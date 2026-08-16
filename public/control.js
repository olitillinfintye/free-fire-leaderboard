/* ============================================================
   Free Fire Leaderboard — control panel
   Edits are debounced and POSTed to /api/state; the server fans
   the new state out to every overlay over SSE.
   ============================================================ */

(() => {
  const $ = (s) => document.querySelector(s);
  const KEY = new URLSearchParams(location.search).get('key') || '';

  let state = { settings: {}, players: [] };
  let dirty = false;

  /* ------------------------------------------------ transport */

  const saveChip = $('#saveState');
  const setChip = (text, cls) => {
    saveChip.textContent = text;
    saveChip.className = 'chip ' + (cls || '');
  };

  let pushTimer = null;
  function push({ instant = false } = {}) {
    dirty = true;
    setChip('saving…', 'chip--busy');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/state' + (KEY ? '?key=' + encodeURIComponent(KEY) : ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(KEY ? { 'X-LB-Key': KEY } : {}) },
          body: JSON.stringify({ settings: state.settings, players: state.players }),
        });
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        dirty = false;
        setChip('saved', 'chip--ok');
      } catch (e) {
        setChip('save failed', 'chip--err');
        console.error(e);
      }
    }, instant ? 0 : 220);
  }

  async function action(type, payload) {
    await fetch('/api/action' + (KEY ? '?key=' + encodeURIComponent(KEY) : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(KEY ? { 'X-LB-Key': KEY } : {}) },
      body: JSON.stringify({ type, payload }),
    }).catch(console.error);
  }

  /* ------------------------------------------------ helpers */

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'p' + Math.random().toString(36).slice(2));
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

  function ordered() {
    const list = state.players.slice();
    if (state.settings.autoSort) {
      list.sort((a, b) => num(b.score) - num(a.score) || a.name.localeCompare(b.name));
    }
    return list;
  }

  /* ------------------------------------------------ player table */

  const tbody = $('#players');

  function renderPlayers() {
    const list = ordered();
    $('#empty').style.display = list.length ? 'none' : 'block';
    tbody.innerHTML = '';

    list.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'prow' + (i === 0 ? ' rank1' : i === 1 ? ' rank2' : i === 2 ? ' rank3' : '') +
        (p.highlight ? ' hl' : '') + (p.eliminated ? ' dead' : '');
      row.dataset.id = p.id;
      row.draggable = !state.settings.autoSort;

      row.innerHTML = `
        <div class="drag" title="${state.settings.autoSort ? 'Turn off auto-sort to reorder' : 'Drag to reorder'}">⠿</div>
        <div class="pos">${i + 1}</div>
        <input class="f-name" value="" />
        <input class="f-team" value="" placeholder="—" />
        <input class="f-score" type="number" />
        <div class="quick">
          <button class="btn qk" data-d="-100">−100</button>
          <button class="btn qk" data-d="100">+100</button>
          <button class="star ${p.highlight ? 'on' : ''}" title="Highlight">★</button>
          <button class="skull ${p.eliminated ? 'on' : ''}" title="Eliminated">💀</button>
        </div>
        <button class="del" title="Remove">✕</button>`;

      row.querySelector('.f-name').value = p.name;
      row.querySelector('.f-team').value = p.team || '';
      row.querySelector('.f-score').value = p.score;

      const bind = (sel, key, cast) => {
        const el = row.querySelector(sel);
        el.addEventListener('input', () => {
          p[key] = cast ? cast(el.value) : el.value;
          push();
          if (key !== 'name' && key !== 'team') softRefresh();
        });
      };
      bind('.f-name', 'name');
      bind('.f-team', 'team');
      bind('.f-score', 'score', num);

      row.querySelectorAll('.qk').forEach((b) => {
        b.addEventListener('click', () => {
          p.score = num(p.score) + num(b.dataset.d);
          push({ instant: true });
          renderPlayers();
        });
      });

      row.querySelector('.star').addEventListener('click', () => {
        p.highlight = !p.highlight; push({ instant: true }); renderPlayers();
      });
      row.querySelector('.skull').addEventListener('click', () => {
        p.eliminated = !p.eliminated; push({ instant: true }); renderPlayers();
      });
      row.querySelector('.del').addEventListener('click', () => {
        state.players = state.players.filter((x) => x.id !== p.id);
        push({ instant: true }); renderPlayers();
      });

      // click the rank number to flash that row on stream
      row.querySelector('.pos').addEventListener('click', () => action('flash', { id: p.id }));
      row.querySelector('.pos').style.cursor = 'pointer';
      row.querySelector('.pos').title = 'Flash this row on the overlay';

      wireDrag(row);
      tbody.appendChild(row);
    });
  }

  /** Live re-ranking while you type.
   *  Two stages so the list never jumps out from under the cursor:
   *  the rank numbers and medal colours update on the next keystroke, and the
   *  rows themselves slide into their new order once you pause.
   *  (The overlay re-sorts immediately either way — it has no cursor to protect.) */
  let softTimer = null;
  function softRefresh() {
    clearTimeout(softTimer);
    softTimer = setTimeout(() => {
      const rankOf = new Map(ordered().map((p, i) => [p.id, i + 1]));
      for (const row of tbody.children) {
        const rank = rankOf.get(row.dataset.id);
        if (!rank) continue;
        const pos = row.querySelector('.pos');
        if (pos.textContent !== String(rank)) {
          pos.textContent = rank;
          pos.animate(
            [{ transform: 'scale(1.6)', color: '#ffc400' }, { transform: 'scale(1)' }],
            { duration: 280, easing: 'cubic-bezier(.3,1.6,.4,1)' }
          );
        }
        row.classList.toggle('rank1', rank === 1);
        row.classList.toggle('rank2', rank === 2);
        row.classList.toggle('rank3', rank === 3);
      }
      scheduleReorder();
    }, 120);
  }

  let reorderTimer = null;
  function scheduleReorder() {
    clearTimeout(reorderTimer);
    reorderTimer = setTimeout(reorderRows, 700);
  }

  /** Slide the rows into rank order (FLIP), keeping focus and caret intact. */
  function reorderRows() {
    if (!state.settings.autoSort) return;
    const list = ordered();
    const rows = [...tbody.children];
    if (rows.every((row, i) => row.dataset.id === list[i]?.id)) return;

    const startTop = new Map(rows.map((r) => [r.dataset.id, r.getBoundingClientRect().top]));

    const active = document.activeElement;
    const focusRow = active && active.closest ? active.closest('.prow') : null;
    const focus = focusRow
      ? { id: focusRow.dataset.id, cls: active.className, caret: [active.selectionStart, active.selectionEnd] }
      : null;

    const byId = new Map(rows.map((r) => [r.dataset.id, r]));
    for (const p of list) {
      const row = byId.get(p.id);
      if (row) tbody.appendChild(row);        // moving a node re-places it, no rebuild
    }

    if (focus) {
      const el = tbody.querySelector(`.prow[data-id="${CSS.escape(focus.id)}"] .${focus.cls}`);
      if (el) {
        el.focus();
        try { el.setSelectionRange(focus.caret[0], focus.caret[1]); } catch { /* number inputs */ }
      }
    }

    for (const row of tbody.children) {
      const delta = (startTop.get(row.dataset.id) ?? 0) - row.getBoundingClientRect().top;
      if (!delta) continue;
      row.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
        { duration: 420, easing: 'cubic-bezier(.2,.9,.25,1)' }
      );
    }
  }

  /* ------------------------------------------------ drag reorder */

  let dragId = null;
  function wireDrag(row) {
    row.addEventListener('dragstart', (e) => {
      dragId = row.dataset.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragId = null; });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dragover'); });
    row.addEventListener('dragleave', () => row.classList.remove('dragover'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('dragover');
      if (!dragId || dragId === row.dataset.id) return;
      const from = state.players.findIndex((p) => p.id === dragId);
      const to = state.players.findIndex((p) => p.id === row.dataset.id);
      if (from < 0 || to < 0) return;
      const [moved] = state.players.splice(from, 1);
      state.players.splice(to, 0, moved);
      push({ instant: true });
      renderPlayers();
    });
  }

  /* ------------------------------------------------ settings binding */

  const S = {
    sTitle: 'title', sSubtitle: 'subtitle', sMaxRows: 'maxRows',
    sTheme: 'theme', sAccent: 'accent', sAlign: 'align', sScale: 'scale', sSpeed: 'speed',
  };
  const CHK = {
    sAutoSort: 'autoSort', sRankChange: 'showRankChange', sNumbers: 'numbersRoll',
    sJoinOpen: 'joinOpen', sJoinUpper: 'joinUpper',
  };
  const COLS = { cTeam: 'team', cAvatar: 'avatar' };

  function fillSettings() {
    const s = state.settings;
    for (const [id, key] of Object.entries(S)) $('#' + id).value = s[key];
    for (const [id, key] of Object.entries(CHK)) $('#' + id).checked = !!s[key];
    for (const [id, key] of Object.entries(COLS)) $('#' + id).checked = !!s.columns[key];
    $('#sCycle').checked = !!s.cycle.enabled;
    $('#sCycleSize').value = s.cycle.size;
    $('#sCycleSecs').value = s.cycle.seconds;
    $('#vScale').textContent = Number(s.scale).toFixed(2) + '×';
    $('#vSpeed').textContent = Number(s.speed).toFixed(2) + '×';
    document.querySelector('.cycle-only').classList.toggle('on', !!s.cycle.enabled);
    $('#btnVisible').textContent = s.visible === false ? 'Show overlay' : 'Hide overlay';
  }

  function wireSettings() {
    for (const [id, key] of Object.entries(S)) {
      const el = $('#' + id);
      el.addEventListener('input', () => {
        const v = el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
        state.settings[key] = v;
        if (id === 'sScale') $('#vScale').textContent = v.toFixed(2) + '×';
        if (id === 'sSpeed') $('#vSpeed').textContent = v.toFixed(2) + '×';
        push();
      });
    }
    for (const [id, key] of Object.entries(CHK)) {
      $('#' + id).addEventListener('change', (e) => {
        state.settings[key] = e.target.checked;
        if (key === 'autoSort') renderPlayers();
        push({ instant: true });
      });
    }
    for (const [id, key] of Object.entries(COLS)) {
      $('#' + id).addEventListener('change', (e) => {
        state.settings.columns[key] = e.target.checked;
        push({ instant: true });
      });
    }
    $('#sCycle').addEventListener('change', (e) => {
      state.settings.cycle.enabled = e.target.checked;
      document.querySelector('.cycle-only').classList.toggle('on', e.target.checked);
      push({ instant: true });
    });
    $('#sCycleSize').addEventListener('input', (e) => { state.settings.cycle.size = num(e.target.value); push(); });
    $('#sCycleSecs').addEventListener('input', (e) => { state.settings.cycle.seconds = num(e.target.value); push(); });
  }

  /* ------------------------------------------------ toolbar actions */

  $('#btnAdd').addEventListener('click', () => {
    state.players.push({
      id: uid(), name: 'PLAYER_' + String(state.players.length + 1).padStart(2, '0'),
      team: '', score: 0, avatar: '', highlight: false, eliminated: false,
    });
    push({ instant: true });
    renderPlayers();
    const last = tbody.lastElementChild?.querySelector('.f-name');
    if (last) { last.focus(); last.select(); }
  });

  $('#btnSort').addEventListener('click', () => {
    state.players = ordered();
    push({ instant: true });
    renderPlayers();
  });

  $('#btnClear').addEventListener('click', () => {
    if (!confirm('Remove every player from the board?')) return;
    state.players = [];
    push({ instant: true });
    renderPlayers();
  });

  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ settings: state.settings, players: state.players }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'leaderboard.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $('#btnVisible').addEventListener('click', () => {
    state.settings.visible = state.settings.visible === false;
    fillSettings();
    push({ instant: true });
  });

  $('#btnReplay').addEventListener('click', () => action('replay'));

  $('#btnPopout').addEventListener('click', () => window.open('/overlay?bg=1', '_blank', 'width=1280,height=720'));

  /* ---- bulk import ---- */
  const dlgImport = $('#dlgImport');
  $('#btnImport').addEventListener('click', () => dlgImport.showModal());
  $('#importCancel').addEventListener('click', () => dlgImport.close());
  $('#importGo').addEventListener('click', () => {
    const lines = $('#importText').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((line) => {
      const parts = line.split(/\t|,(?![^(]*\))/).map((x) => x.trim());
      return {
        id: uid(),
        name: parts[0] || 'PLAYER',
        score: num(parts[1]),
        team: parts[2] || '',
        avatar: '', highlight: false, eliminated: false,
      };
    });
    state.players = $('#importReplace').checked ? parsed : state.players.concat(parsed);
    push({ instant: true });
    renderPlayers();
    dlgImport.close();
    $('#importText').value = '';
  });

  /* ---- booyah ---- */
  const dlgBooyah = $('#dlgBooyah');
  $('#btnBooyah').addEventListener('click', () => {
    $('#booyahName').value = ordered()[0]?.name || '';
    dlgBooyah.showModal();
  });
  $('#booyahCancel').addEventListener('click', () => dlgBooyah.close());
  $('#booyahGo').addEventListener('click', () => {
    action('booyah', { name: $('#booyahName').value });
    dlgBooyah.close();
  });

  /* ------------------------------------------------ google form import */

  const dlgSheet = $('#dlgSheet');
  let sheetRows = { headers: [], body: [] };

  const sheetOpts = () => ({
    upper: $('#sheetUpper').checked,
    dedupe: $('#sheetDedupe').checked,
    nameCol: Number($('#sheetNameCol').value),
    scoreCol: Number($('#sheetScoreCol').value),
  });

  function loadSheetText(text) {
    const rows = FFNames.parseDelimited(text);
    sheetRows = FFNames.splitHeader(rows);
    const { headers, body } = sheetRows;

    const fill = (sel, extra) => {
      sel.innerHTML = '';
      if (extra) sel.appendChild(new Option(extra, '-1'));
      headers.forEach((h, i) => sel.appendChild(new Option(h || `Column ${i + 1}`, String(i))));
    };
    fill($('#sheetNameCol'));
    fill($('#sheetScoreCol'), '— none —');
    $('#sheetNameCol').value = String(FFNames.pickNameColumn(headers, body));
    $('#sheetScoreCol').value = String(FFNames.pickScoreColumn(headers));

    previewSheet();
  }

  function previewSheet() {
    const box = $('#sheetPreview');
    box.innerHTML = '';
    const { body } = sheetRows;
    if (!body.length) { $('#sheetGo').disabled = true; $('#sheetGo').textContent = 'Import 0 players'; return; }

    const o = sheetOpts();
    const existing = new Set(
      o.replace ? [] : state.players.map((p) => p.name.toLowerCase())
    );
    const seen = new Set();
    let importable = 0;

    for (const row of body.slice(0, 60)) {
      const from = row[o.nameCol] || '';
      const to = FFNames.formatPlayerName(from, o);
      if (!to) continue;
      const key = to.toLowerCase();
      const dupe = o.dedupe && (seen.has(key) || existing.has(key));
      if (!dupe) { importable++; seen.add(key); }

      const line = document.createElement('div');
      line.className = 'pv' + (dupe ? ' dupe' : '');
      line.innerHTML = `<span class="from"></span><span class="arrow">→</span><span class="to"></span>`;
      line.querySelector('.from').textContent = from;
      line.querySelector('.to').textContent = to + (dupe ? '  (already on board)' : '');
      box.appendChild(line);
    }
    if (body.length > 60) {
      const more = document.createElement('div');
      more.className = 'pv';
      more.innerHTML = `<span class="from">…and ${body.length - 60} more rows</span>`;
      box.appendChild(more);
    }

    $('#sheetGo').disabled = importable === 0;
    $('#sheetGo').textContent = `Import ${importable} player${importable === 1 ? '' : 's'}`;
  }

  $('#btnSheet').addEventListener('click', () => {
    $('#sheetError').textContent = '';
    $('#sheetUpper').checked = !!state.settings.joinUpper;
    dlgSheet.showModal();
  });
  $('#sheetCancel').addEventListener('click', () => dlgSheet.close());
  $('#sheetText').addEventListener('input', (e) => loadSheetText(e.target.value));
  ['#sheetNameCol', '#sheetScoreCol', '#sheetUpper', '#sheetDedupe', '#sheetReplace']
    .forEach((sel) => $(sel).addEventListener('change', previewSheet));

  $('#sheetFetch').addEventListener('click', async () => {
    const btn = $('#sheetFetch');
    const err = $('#sheetError');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const res = await fetch('/api/import/sheet' + (KEY ? '?key=' + encodeURIComponent(KEY) : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(KEY ? { 'X-LB-Key': KEY } : {}) },
        body: JSON.stringify({ url: $('#sheetUrl').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not read that sheet.');
      $('#sheetText').value = data.csv;
      loadSheetText(data.csv);
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch';
    }
  });

  $('#sheetGo').addEventListener('click', () => {
    const o = sheetOpts();
    const replace = $('#sheetReplace').checked;
    const { players } = FFNames.extractPlayers($('#sheetText').value, o);
    const existing = new Set(replace ? [] : state.players.map((p) => p.name.toLowerCase()));

    const fresh = players
      .filter((p) => !(o.dedupe && existing.has(p.name.toLowerCase())))
      .map((p) => ({
        id: uid(), name: p.name, team: '', score: p.score,
        avatar: '', highlight: false, eliminated: false,
      }));

    state.players = replace ? fresh : state.players.concat(fresh);
    push({ instant: true });
    renderPlayers();
    dlgSheet.close();
    toast('Imported', `${fresh.length} player${fresh.length === 1 ? '' : 's'}`);
  });

  /* ------------------------------------------------ toasts */

  function toast(tag, text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="tag"></span><b></b>`;
    el.querySelector('.tag').textContent = tag;
    el.querySelector('b').textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  /* ------------------------------------------------ live joins */

  /** Players who sign themselves up at /join arrive over SSE. Only additions are
   *  merged in, so nothing you are editing here can be overwritten. */
  let mergeTimer = null;
  function mergeRemote(remote) {
    const mine = new Set(state.players.map((p) => p.id));
    const added = remote.players.filter((p) => !mine.has(p.id));
    if (!added.length) return;

    state.players.push(...added.map((p) => ({
      id: p.id, name: p.name, team: p.team, score: p.score,
      avatar: p.avatar, highlight: p.highlight, eliminated: p.eliminated,
    })));

    const paint = () => {
      // Don't rebuild the table out from under a field being typed in.
      if (document.activeElement?.closest('.prow')) {
        mergeTimer = setTimeout(paint, 500);
        return;
      }
      renderPlayers();
      for (const p of added) {
        const row = tbody.querySelector(`.prow[data-id="${CSS.escape(p.id)}"]`);
        if (row) row.classList.add('joined');
      }
    };
    clearTimeout(mergeTimer);
    paint();
  }

  function watchStream() {
    const es = new EventSource('/api/stream');
    es.addEventListener('state', (e) => {
      try { mergeRemote(JSON.parse(e.data)); } catch (err) { console.error(err); }
    });
    es.addEventListener('joined', (e) => {
      try { toast('joined', JSON.parse(e.data).name); } catch { /* ignore */ }
    });
    es.onerror = () => { es.close(); setTimeout(watchStream, 2000); };
  }

  /* ------------------------------------------------ share links */

  async function buildLinks() {
    let info;
    try { info = await (await fetch('/api/links')).json(); }
    catch { info = { port: location.port, addresses: [location.hostname] }; }

    const pick = $('#lanPick');
    pick.innerHTML = '';

    const addOption = (value, label) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      pick.appendChild(opt);
    };

    // Whatever address this panel was opened on always works — on a deployed
    // host that is the only one that means anything to the outside world.
    const deployed = !['localhost', '127.0.0.1'].includes(location.hostname);
    addOption(location.origin + '/overlay', deployed ? 'This site (share this)' : 'This PC (localhost)');

    if (!deployed) {
      info.addresses
        .filter((h) => h !== 'localhost')
        .forEach((h) => addOption(`http://${h}:${info.port}/overlay`, `Network — ${h}`));
    }

    pick.value = pick.options[0].value;
    $('#obsUrl').value = pick.value;
    pick.style.display = pick.options.length > 1 ? '' : 'none';

    // The sign-up link has to be reachable from the players' phones, so localhost
    // is never the answer — offer the network addresses, best guess first.
    const jp = $('#joinPick');
    jp.innerHTML = '';
    if (deployed) {
      jp.appendChild(new Option('This site', location.origin + '/join'));
    } else {
      const lan = info.addresses.filter((h) => h !== 'localhost');
      lan.forEach((h, i) => jp.appendChild(new Option(
        `${h}${i === 0 ? '  (try this one first)' : ''}`, `http://${h}:${info.port}/join`)));
      if (!lan.length) jp.appendChild(new Option('This PC only', `${location.origin}/join`));
    }
    jp.value = jp.options[0].value;
    $('#joinUrl').value = jp.value;
    jp.style.display = jp.options.length > 1 ? '' : 'none';
    jp.addEventListener('change', () => ($('#joinUrl').value = jp.value));
    $('#viewers').textContent = deployed ? 'live on the internet'
      : info.addresses.length > 1 ? 'shareable on your network' : 'overlay link ready';

    pick.addEventListener('change', () => ($('#obsUrl').value = pick.value));
  }

  const wireCopy = (btnSel, inputSel) => {
    $(btnSel).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($(inputSel).value); }
      catch { $(inputSel).select(); document.execCommand('copy'); }
      const b = $(btnSel);
      b.textContent = 'Copied ✓';
      setTimeout(() => (b.textContent = 'Copy'), 1400);
    });
  };
  wireCopy('#btnCopy', '#obsUrl');
  wireCopy('#btnCopyJoin', '#joinUrl');

  /* ------------------------------------------------ boot */

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  (async function boot() {
    const raw = await (await fetch('/api/raw')).json();
    state = { settings: raw.settings, players: raw.players };
    if (raw.needsKey && !KEY) {
      setChip('key required — add ?key=… to the URL', 'chip--err');
    }
    fillSettings();
    wireSettings();
    renderPlayers();
    buildLinks();
    watchStream();
    setChip('saved', 'chip--ok');
  })();
})();
