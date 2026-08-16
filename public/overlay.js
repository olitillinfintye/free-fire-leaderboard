/* ============================================================
   Free Fire Leaderboard — overlay renderer
   Listens to /api/stream (SSE) and animates every change:
   rank swaps slide, scores roll, gains sweep gold.

   URL overrides (all optional):
     ?bg=1        preview background (never use in OBS)
     ?scale=1.2   size multiplier
     ?rows=8      visible rows
     ?align=left|right|center
     ?theme=classic|neon|crimson|ice
     ?title=TEXT&sub=TEXT
     ?nostatus=1  hide the "reconnecting" chip
   ============================================================ */

(() => {
  const qs = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);

  const els = {
    body: document.body,
    board: $('#board'),
    rows: $('#rows'),
    title: $('#title'),
    subtitle: $('#subtitle'),
    pager: $('#pager'),
    fx: $('#fx'),
    cols: $('#cols'),
  };

  if (qs.get('bg')) els.body.classList.add('preview-bg');
  if (qs.get('nostatus')) els.body.classList.add('hide-status');

  const ROW_H = 46;

  /** id -> { el, refs, total, rank } */
  const live = new Map();
  let settings = null;
  let allPlayers = [];
  let page = 0;
  let cycleTimer = null;
  let firstPaint = true;

  /* ------------------------------------------------ row factory */

  function makeRow(p) {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML = `
      <div class="mv"></div>
      <div class="rk"><span></span></div>
      <div class="nm">
        <img class="nm__av" alt="" />
        <div class="nm__txt">
          <div class="nm__name"></div>
          <div class="nm__team"></div>
        </div>
      </div>
      <div class="sc">0</div>
      <div class="delta"></div>`;

    const refs = {
      mv: el.querySelector('.mv'),
      rk: el.querySelector('.rk span'),
      av: el.querySelector('.nm__av'),
      name: el.querySelector('.nm__name'),
      team: el.querySelector('.nm__team'),
      sc: el.querySelector('.sc'),
      delta: el.querySelector('.delta'),
    };
    els.rows.appendChild(el);
    return { el, refs, total: p.total, rank: p.rank };
  }

  /* ------------------------------------------------ animations */

  function rollNumber(node, from, to, ms) {
    // Each roll gets a token so a superseded animation can't write a stale value.
    const token = (node._roll = (node._roll || 0) + 1);
    const settle = () => { if (node._roll === token) node.textContent = fmt(to); };

    if (from === to || !settings.numbersRoll || Math.abs(to - from) < 2) { settle(); return; }

    const t0 = performance.now();
    const dur = Math.max(180, ms / (settings.speed || 1));
    const step = (now) => {
      if (node._roll !== token) return;
      const k = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      node.textContent = fmt(Math.round(from + (to - from) * eased));
      if (k < 1) requestAnimationFrame(step);
      else settle();
    };
    requestAnimationFrame(step);
    // rAF is paused while the page isn't compositing (OBS scene hidden, tab in the
    // background). This guarantees the final number lands regardless.
    setTimeout(settle, dur + 150);
  }

  const fmt = (n) => (Math.abs(n) >= 10000 ? n.toLocaleString('en-US') : String(n));

  function pulse(node, cls, ms) {
    node.classList.remove(cls);
    void node.offsetWidth;   // restart the animation
    node.classList.add(cls);
    setTimeout(() => node.classList.remove(cls), ms);
  }

  function showDelta(refs, diff) {
    refs.delta.textContent = (diff > 0 ? '+' : '') + diff;
    refs.delta.classList.toggle('up', diff > 0);
    refs.delta.classList.toggle('down', diff < 0);
    pulse(refs.delta, 'go', 1200 / (settings.speed || 1));
  }

  /* ------------------------------------------------ rendering */

  function applySettings(s) {
    settings = s;
    els.body.dataset.theme = s.theme || 'classic';
    els.body.className = els.body.className.replace(/align-\w+/g, '').trim();
    els.body.classList.add('align-' + (qs.get('align') || s.align || 'right'));
    if (qs.get('bg')) els.body.classList.add('preview-bg');
    if (qs.get('nostatus')) els.body.classList.add('hide-status');

    const root = document.documentElement.style;
    root.setProperty('--accent', s.accent || '#ffc400');
    root.setProperty('--speed', String(Number(qs.get('speed')) || s.speed || 1));

    const scale = Number(qs.get('scale')) || s.scale || 1;
    els.board.style.transform = `scale(${scale})`;

    els.title.textContent = qs.get('title') ?? s.title ?? '';
    els.subtitle.textContent = qs.get('sub') ?? s.subtitle ?? '';

    const c = s.columns || {};
    els.board.classList.toggle('no-team', !c.team);
    els.board.classList.toggle('no-avatar', !c.avatar);

    els.board.classList.toggle('is-hidden', s.visible === false);
  }

  function visibleSlice() {
    const s = settings;
    const cycle = s.cycle || {};
    const size = Math.min(
      Number(qs.get('rows')) || s.maxRows,
      cycle.enabled ? Math.max(1, cycle.size) : s.maxRows
    );
    if (!cycle.enabled || allPlayers.length <= size) {
      page = 0;
      els.pager.textContent = '';
      return allPlayers.slice(0, Number(qs.get('rows')) || s.maxRows);
    }
    const pages = Math.ceil(Math.min(allPlayers.length, s.maxRows) / size);
    page = page % pages;
    els.pager.textContent = `${page + 1} / ${pages}`;
    return allPlayers.slice(0, s.maxRows).slice(page * size, page * size + size);
  }

  function paint() {
    const shown = visibleSlice();
    const seen = new Set();

    shown.forEach((p, index) => {
      seen.add(p.id);
      let entry = live.get(p.id);
      const isNew = !entry;
      if (isNew) {
        entry = makeRow(p);
        live.set(p.id, entry);
      }
      const { el, refs } = entry;

      // position
      el.style.setProperty('--y', index * ROW_H + 'px');
      el.style.setProperty('--i', String(index));
      el.style.zIndex = String(100 - index);

      // static-ish fields
      if (refs.name.textContent !== p.name) refs.name.textContent = p.name;
      refs.team.textContent = p.team || '';
      refs.rk.textContent = p.rank;

      if (p.avatar) {
        if (refs.av.getAttribute('src') !== p.avatar) refs.av.src = p.avatar;
        refs.av.style.visibility = 'visible';
      } else {
        refs.av.removeAttribute('src');
        refs.av.style.visibility = 'hidden';
      }

      el.classList.toggle('top1', p.rank === 1);
      el.classList.toggle('top2', p.rank === 2);
      el.classList.toggle('top3', p.rank === 3);
      el.classList.toggle('hl', !!p.highlight);
      el.classList.toggle('dead', !!p.eliminated);

      if (isNew) {
        refs.sc.textContent = fmt(p.total);
        pulse(el, 'enter', 900);
      } else {
        // score change
        if (entry.total !== p.total) {
          rollNumber(refs.sc, entry.total, p.total, 650);
          pulse(refs.sc, 'pop', 320);
          showDelta(refs, p.total - entry.total);
        }
        // rank change
        if (settings.showRankChange && entry.rank !== p.rank) {
          const up = p.rank < entry.rank;
          refs.mv.className = 'mv ' + (up ? 'up' : 'down');
          void refs.mv.offsetWidth;
          refs.mv.classList.add(up ? 'up' : 'down');
          setTimeout(() => (refs.mv.className = 'mv'), 1500 / (settings.speed || 1));
          if (up) pulse(el, 'gain', 1000);
        }
      }

      entry.total = p.total;
      entry.rank = p.rank;
    });

    // remove rows that dropped out of view
    for (const [id, entry] of live) {
      if (seen.has(id)) continue;
      entry.el.classList.add('leave');
      const el = entry.el;
      setTimeout(() => el.remove(), 400);
      live.delete(id);
    }

    els.rows.style.height = shown.length * ROW_H + 6 + 'px';
    firstPaint = false;
  }

  function scheduleCycle() {
    clearInterval(cycleTimer);
    const c = settings.cycle || {};
    if (!c.enabled) return;
    cycleTimer = setInterval(() => { page++; paint(); }, Math.max(2, c.seconds || 8) * 1000);
  }

  let seenAction = null;

  function onState(st) {
    const prevCycle = settings && JSON.stringify(settings.cycle);
    applySettings(st.settings);
    allPlayers = st.players;
    paint();
    if (prevCycle !== JSON.stringify(settings.cycle)) scheduleCycle();

    // Effects travel inside the state so they work over SSE and polling alike.
    // The first state we ever see only establishes the baseline.
    // seq starts at 0, so test for the field itself — testing truthiness would
    // skip the baseline and swallow the first effect after every page load.
    const act = st.action;
    if (act && typeof act.seq === 'number') {
      if (seenAction !== null && act.seq !== seenAction) onAction(act);
      seenAction = act.seq;
    }
  }

  /* ------------------------------------------------ one-off actions */

  /** {top1}, {top1score} and {players} are filled from the current board. */
  function fillTokens(text) {
    const top = allPlayers[0];
    return String(text || '')
      .replace(/\{top1\}/gi, top ? top.name : '')
      .replace(/\{top1score\}/gi, top ? String(top.total) : '0')
      .replace(/\{players\}/gi, String(allPlayers.length));
  }

  // Effects queue so two triggers in quick succession play in turn rather than
  // cutting each other off.
  const fxQueue = [];
  let fxPlaying = false;

  function playEffect(fx) {
    fxQueue.push(fx);
    if (!fxPlaying) nextEffect();
  }

  function nextEffect() {
    const fx = fxQueue.shift();
    if (!fx) { fxPlaying = false; return; }
    fxPlaying = true;

    const ms = Math.max(1, Number(fx.seconds) || 3) * 1000;
    const el = els.fx;
    el.className = 'fx fx--' + (fx.style || 'burst');
    el.style.setProperty('--fx', fx.color || 'var(--accent)');
    el.style.setProperty('--fx-dur', ms + 'ms');
    el.querySelector('.fx__word').textContent = fillTokens(fx.text);
    el.querySelector('.fx__sub').textContent = fillTokens(fx.sub);

    void el.offsetWidth;
    el.classList.add('go');
    setTimeout(() => {
      el.classList.remove('go');
      setTimeout(nextEffect, 120);
    }, ms);
  }

  function onAction({ type, payload }) {
    if (type === 'effect') {
      playEffect(payload || {});
    } else if (type === 'booyah') {
      // kept so older links and the original button still work
      playEffect({ text: 'BOOYAH!', sub: payload?.name || '', color: '#ffc400', style: 'burst', seconds: 3 });
    } else if (type === 'flash') {
      const entry = live.get(payload?.id);
      if (entry) pulse(entry.el, 'flash', 1900 / (settings.speed || 1));
    } else if (type === 'replay') {
      let i = 0;
      for (const [, entry] of live) {
        entry.el.style.setProperty('--i', String(i++));
        pulse(entry.el, 'enter', 1100);
      }
    } else if (type === 'clearfx') {
      fxQueue.length = 0;
      fxPlaying = false;
      els.fx.classList.remove('go');
    } else if (type === 'reload') {
      location.reload();
    }
  }

  /* ------------------------------------------------ transport */

  LBLive.connect({
    onState,
    onStatus: (s) => document.body.classList.toggle('is-offline', s !== 'live'),
  });
})();
