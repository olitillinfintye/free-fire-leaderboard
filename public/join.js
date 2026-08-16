/* ============================================================
   Player sign-up page.
   Shows the player exactly how their name will appear before they
   commit, posts it to /api/join, then follows the live board.
   ============================================================ */

(() => {
  const $ = (s) => document.querySelector(s);
  const els = {
    form: $('#form'), name: $('#name'), preview: $('#preview'), submit: $('#submit'),
    error: $('#error'), done: $('#done'), doneName: $('#doneName'), again: $('#again'),
    closed: $('#closed'), board: $('#board'), list: $('#list'), count: $('#count'),
    status: $('#status'), title: $('#title'), subtitle: $('#subtitle'),
    findMe: $('#findMe'),
  };

  let upper = false;
  let myName = localStorage.getItem('ff-my-name') || '';
  let known = new Set();
  let firstPaint = true;
  let lastState = null;   // the server pushes state before our POST resolves

  /* ---------------------------------------------- live name preview */

  const shown = () => window.FFNames.formatPlayerName(els.name.value, { upper });

  els.name.addEventListener('input', () => {
    const out = shown();
    const b = els.preview.querySelector('b');
    if (b.textContent !== (out || '—')) {
      b.textContent = out || '—';
      els.preview.classList.remove('bump');
      void els.preview.offsetWidth;
      els.preview.classList.add('bump');
    }
    hideError();
  });

  function showError(msg) {
    els.error.textContent = msg;
    els.error.classList.add('show');
    els.form.classList.remove('shake');
    void els.form.offsetWidth;
    els.form.classList.add('shake');
  }
  const hideError = () => els.error.classList.remove('show');

  /* ---------------------------------------------- submit */

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = els.name.value.trim();
    if (!raw) { showError('Please enter your name.'); return; }

    els.submit.disabled = true;
    els.submit.textContent = 'JOINING…';
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: raw }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Could not join, try again.'); return; }

      myName = data.name;
      localStorage.setItem('ff-my-name', myName);
      els.doneName.textContent = data.name;
      els.form.hidden = true;
      els.done.hidden = false;
      wantScroll = true;                       // show them where they landed
      if (lastState) renderBoard(lastState);   // repaint so their row is marked
    } catch {
      showError('No connection — check your Wi-Fi and try again.');
    } finally {
      els.submit.disabled = false;
      els.submit.textContent = 'JOIN THE MATCH';
    }
  });

  els.again.addEventListener('click', () => {
    els.name.value = '';
    els.preview.querySelector('b').textContent = '—';
    els.done.hidden = true;
    els.form.hidden = false;
    els.name.focus();
  });

  /* ---------------------------------------------- live board */

  /** Every player on the board, in rank order.
   *  Rows are updated in place rather than rebuilt — with a big roster this
   *  keeps the list from jumping back to the top each time a score changes
   *  while somebody is scrolling through it. */
  const rowById = new Map();

  function renderBoard(st) {
    const players = st.players;
    els.count.textContent = players.length ? `· ${players.length}` : '';
    els.board.hidden = !players.length;

    for (const p of players) {
      let li = rowById.get(p.id);
      if (!li) {
        li = document.createElement('li');
        li.innerHTML = '<span class="r"></span><span class="n"></span><span class="s"></span>';
        rowById.set(p.id, li);
        if (!firstPaint) li.classList.add('new');
      }
      const rank = li.querySelector('.r');
      const name = li.querySelector('.n');
      const score = li.querySelector('.s');
      if (rank.textContent !== String(p.rank)) rank.textContent = p.rank;
      if (name.textContent !== p.name) name.textContent = p.name;
      if (score.textContent !== String(p.total)) score.textContent = p.total;

      li.classList.toggle('top', p.rank <= 3);
      li.classList.toggle('me', !!myName && p.name.toLowerCase() === myName.toLowerCase());
    }

    for (const [id, li] of rowById) {
      if (!players.some((p) => p.id === id)) { li.remove(); rowById.delete(id); }
    }

    // Put them in rank order, moving only the rows that actually shifted.
    players.forEach((p, i) => {
      const li = rowById.get(p.id);
      if (els.list.children[i] !== li) els.list.insertBefore(li, els.list.children[i] || null);
    });

    els.findMe.hidden = !myName || !players.some(
      (p) => p.name.toLowerCase() === myName.toLowerCase());

    // A join is confirmed before the row exists, so the scroll waits for it.
    if (wantScroll && scrollToMe()) wantScroll = false;

    known = new Set(players.map((p) => p.id));
    firstPaint = false;
  }

  /** With 90-odd players your own row is rarely on screen — jump to it.
   *  Positions the list directly rather than using scrollIntoView, which also
   *  scrolls the page and is skipped entirely in some mobile browsers. */
  let wantScroll = false;

  function scrollToMe() {
    const mine = els.list.querySelector('li.me');
    if (!mine) return false;

    const offset = mine.getBoundingClientRect().top - els.list.getBoundingClientRect().top;
    const target = els.list.scrollTop + offset - (els.list.clientHeight - mine.offsetHeight) / 2;
    els.list.scrollTop = Math.max(0, target);

    mine.classList.remove('ping');
    void mine.offsetWidth;
    mine.classList.add('ping');
    return true;
  }
  els.findMe.addEventListener('click', scrollToMe);

  function applySettings(s) {
    upper = !!s.joinUpper;
    document.documentElement.style.setProperty('--accent', s.accent || '#ffc400');
    els.title.textContent = s.title || 'LEADERBOARD';
    els.subtitle.textContent = s.subtitle || '';
    document.title = `Join — ${s.title || 'Leaderboard'}`;

    const open = s.joinOpen !== false;
    els.closed.hidden = open;
    if (!open) { els.form.hidden = true; els.done.hidden = true; }
    else if (els.done.hidden) els.form.hidden = false;
  }

  /* ---------------------------------------------- transport */

  LBLive.connect({
    onState: (st) => {
      lastState = st;
      applySettings(st.settings);
      renderBoard(st);
    },
    onStatus: (s) => {
      els.status.textContent = s === 'live' ? 'live' : 'reconnecting…';
      els.status.classList.toggle('live', s === 'live');
    },
  });

  els.name.focus();
})();
