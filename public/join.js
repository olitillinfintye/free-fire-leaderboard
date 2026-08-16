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

  function renderBoard(st) {
    const players = st.players.slice(0, 20);
    els.count.textContent = st.players.length ? `· ${st.players.length}` : '';
    els.board.hidden = !players.length;

    els.list.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      if (p.rank <= 3) li.classList.add('top');
      if (myName && p.name.toLowerCase() === myName.toLowerCase()) li.classList.add('me');
      if (!firstPaint && !known.has(p.id)) li.classList.add('new');
      li.innerHTML = `<span class="r">${p.rank}</span><span class="n"></span><span class="s">${p.total}</span>`;
      li.querySelector('.n').textContent = p.name;
      els.list.appendChild(li);
    }
    known = new Set(st.players.map((p) => p.id));
    firstPaint = false;
  }

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
