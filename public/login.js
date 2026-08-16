/* Admin sign-in. Exchanges the password for a session cookie so the key
   never has to live in the address bar. */

(() => {
  const form = document.querySelector('#form');
  const username = document.querySelector('#username');
  const key = document.querySelector('#key');
  const go = document.querySelector('#go');
  const error = document.querySelector('#error');

  const fail = (msg) => {
    error.textContent = msg;
    error.classList.add('show');
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
    key.select();
  };

  [username, key].forEach((el) =>
    el.addEventListener('input', () => error.classList.remove('show')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!username.value.trim()) return fail('Enter your username.');
    if (!key.value) return fail('Enter your password.');

    go.disabled = true;
    go.textContent = 'CHECKING…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.value.trim(), password: key.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data.error || 'Wrong username or password.');
      location.replace('/');          // cookie is set; load the dashboard
    } catch {
      fail('No connection — try again.');
    } finally {
      go.disabled = false;
      go.textContent = 'SIGN IN';
    }
  });
})();
