/* ============================================================
   Shared parsing helpers for Google Form / Sheets imports.
   Pure functions, no DOM — also loaded by tools/test-names.js.
   ============================================================ */

(function (root) {
  /** Split CSV or TSV, honouring "quoted, fields" and ""escaped"" quotes. */
  function parseDelimited(text) {
    const t = String(text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (!t.trim()) return [];

    const head = t.slice(0, t.indexOf('\n') === -1 ? t.length : t.indexOf('\n'));
    const delim = (head.match(/\t/g) || []).length > (head.match(/,/g) || []).length ? '\t' : ',';

    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (quoted) {
        if (c !== '"') { field += c; continue; }
        if (t[i + 1] === '"') { field += '"'; i++; continue; }
        quoted = false;
      } else if (c === '"') {
        quoted = true;
      } else if (c === delim) {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += c;
      }
    }
    row.push(field);
    rows.push(row);

    return rows.map((r) => r.map((cell) => cell.trim())).filter((r) => r.some(Boolean));
  }

  const HEADER_HINT = /name|player|ign|timestamp|email|score|team|nick|user/i;

  /** Google Forms always exports a header row, but a hand-pasted list may not. */
  function splitHeader(rows) {
    if (!rows.length) return { headers: [], body: [] };
    const first = rows[0];
    if (first.some((c) => HEADER_HINT.test(c))) {
      return { headers: first, body: rows.slice(1) };
    }
    return { headers: first.map((_, i) => `Column ${i + 1}`), body: rows };
  }

  /** Score each header and return the index most likely to hold player names. */
  function pickNameColumn(headers, body) {
    const score = (h) => {
      const s = String(h).toLowerCase();
      if (/e-?mail|timestamp|date|phone|score|points|rank/.test(s)) return -50;
      if (/\b(ign|in.?game)\b/.test(s)) return 10;
      if (/player|gamer|nick/.test(s)) return 8;
      if (/full name|your name|^name$/.test(s)) return 7;
      if (/name/.test(s)) return 4;         // "username", "team name", …
      return 0;
    };

    let best = -1;
    let bestScore = 0;
    headers.forEach((h, i) => {
      let s = score(h);
      // A column of blanks is never the answer, however good the header reads.
      if (s > 0 && body.length && !body.some((r) => (r[i] || '').trim())) s = -50;
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best !== -1) return best;

    // Nothing matched by name — take the first column that isn't a timestamp or email.
    for (let i = 0; i < headers.length; i++) {
      const sample = body.find((r) => (r[i] || '').trim())?.[i] || '';
      if (/@/.test(sample)) continue;
      if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(sample)) continue;
      return i;
    }
    return 0;
  }

  function pickScoreColumn(headers) {
    const i = headers.findIndex((h) => /score|points|pts/i.test(String(h)));
    return i;
  }

  /**
   * "Oliyad Tesfaye"      -> "Oliyad T"
   * "mary jane watson"    -> "Mary W"     (first name, initial of the LAST name)
   * "Smith, John"         -> "John S"     ("Last, First" is detected and flipped)
   * "AXON"                -> "AXON"       (single name is left alone)
   */
  function formatPlayerName(raw, opts = {}) {
    let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return '';

    if (s.includes(',')) {
      const [last, ...rest] = s.split(',');
      const first = rest.join(' ').trim();
      if (first && last.trim()) s = `${first} ${last.trim()}`;
    }

    const parts = s.split(' ').filter(Boolean);
    // Only tidy casing when the whole word was typed lowercase, so "AXON" and
    // "McArthur" survive exactly as the player wrote them. Capitalise after
    // hyphens and apostrophes too: "jean-luc" -> "Jean-Luc", "o'brien" -> "O'Brien".
    const tidy = (w) =>
      w === w.toLowerCase()
        ? w.replace(/(^|[-'’])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
        : w;

    let out;
    if (parts.length === 1) {
      out = tidy(parts[0]);
    } else {
      const initial = [...parts[parts.length - 1]][0] || '';
      out = `${tidy(parts[0])} ${initial.toUpperCase()}`;
    }
    return opts.upper ? out.toUpperCase() : out;
  }

  /* ---------------------------------------------------------------- search */

  // Gamer tags lean on letterforms that look like ASCII but aren't, and none of
  // them survive a plain toLowerCase(). NFKD handles the fullwidth and modifier
  // letters ("Tｅｅ" -> "Tee", "ᴰᴿ" -> "DR"); small capitals have no
  // decomposition at all, so they need a table.
  const SMALL_CAPS =
    'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘqʀꜱᴛᴜᴠᴡxʏᴢ';
  const SMALL_CAPS_PLAIN =
    'abcdefghijklmnopqrstuvwxyz';
  const EXTRA = { 'ғ': 'f', 'ǫ': 'q', 'ʏ': 'y', 'ᴡ': 'w', 'ᴠ': 'v', 'ㅤ': ' ', '　': ' ' };

  /** Fold a display name down to something a typed query can match. */
  function searchKey(s) {
    let out = String(s ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '');    // drop combining accents

    let folded = '';
    for (const ch of out) {
      const i = SMALL_CAPS.indexOf(ch);
      if (i !== -1) { folded += SMALL_CAPS_PLAIN[i]; continue; }
      folded += EXTRA[ch] ?? ch;
    }
    return folded.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** True when `query` appears in `name`, ignoring decoration and case.
   *  Multiple words match in any order, so "evo raiden" finds "EVO.R4IDENX7". */
  function matchesQuery(name, query) {
    const q = searchKey(query);
    if (!q) return true;
    const hay = searchKey(name);
    // Punctuation between words shouldn't block a match.
    const loose = hay.replace(/[^\p{L}\p{N} ]+/gu, ' ');
    return q.split(' ').every((word) => hay.includes(word) || loose.includes(word));
  }

  /** Full pipeline: raw paste/CSV text -> [{ name, score }]. */
  function extractPlayers(text, opts = {}) {
    const rows = parseDelimited(text);
    const { headers, body } = splitHeader(rows);
    const nameCol = opts.nameCol ?? pickNameColumn(headers, body);
    const scoreCol = opts.scoreCol ?? -1;

    const seen = new Set();
    const out = [];
    for (const row of body) {
      const name = formatPlayerName(row[nameCol], opts);
      if (!name) continue;
      const key = name.toLowerCase();
      if (opts.dedupe !== false) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const rawScore = scoreCol >= 0 ? Number(String(row[scoreCol]).replace(/[^\d.-]/g, '')) : 0;
      out.push({ name, score: Number.isFinite(rawScore) ? Math.round(rawScore) : 0 });
    }
    return { headers, body, nameCol, players: out };
  }

  /* ------------------------------------------------------- json import */

  /** Accepts a full board export, { players: [...] }, a bare array of player
   *  objects, or a plain list of names. Returns [{ id?, name, score, ... }]. */
  function playersFromJson(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;

    let rows;
    if (Array.isArray(data)) rows = data;
    else if (data && Array.isArray(data.players)) rows = data.players;
    else throw new Error('No players found — expected a board export or a list of players.');

    const out = rows.map((r, i) => {
      if (typeof r === 'string') return { name: r.trim(), score: 0 };
      if (!r || typeof r !== 'object') throw new Error(`Row ${i + 1} is not a player.`);
      const name = String(r.name ?? r.player ?? r.ign ?? '').trim();
      const rawScore = r.score ?? r.points ?? r.total ?? 0;
      const score = Number(String(rawScore).replace(/[^\d.-]/g, ''));
      return {
        id: typeof r.id === 'string' ? r.id : undefined,
        name,
        team: String(r.team ?? '').trim(),
        score: Number.isFinite(score) ? Math.round(score) : 0,
        avatar: String(r.avatar ?? ''),
        highlight: !!r.highlight,
        eliminated: !!r.eliminated,
      };
    }).filter((p) => p.name);

    if (!out.length) throw new Error('That file has no named players in it.');
    return { players: out, settings: (data && data.settings) || null };
  }

  const api = {
    parseDelimited, splitHeader, pickNameColumn, pickScoreColumn,
    formatPlayerName, extractPlayers, searchKey, matchesQuery, playersFromJson,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FFNames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
