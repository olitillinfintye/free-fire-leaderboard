/* ============================================================
   Shared live-state client for the overlay, control panel and
   join page.

   Prefers Server-Sent Events (instant, one connection). Some
   proxies — Cloudflare quick tunnels among them — buffer
   text/event-stream so nothing ever arrives, so if the first
   state doesn't land quickly we fall back to polling. Callers
   don't need to care which mode is in use.
   ============================================================ */

(function (root) {
  function connect({ onState, onStatus, pollMs = 1000, firstByteMs = 4000 } = {}) {
    let mode = 'sse';
    let es = null;
    let pollTimer = null;
    let watchdog = null;
    let gotFirst = false;
    let stopped = false;
    let lastRev = -1;

    const status = (s) => onStatus && onStatus(s, mode);

    function deliver(st) {
      gotFirst = true;
      status('live');
      // Polling re-fetches unchanged state constantly; skip identical revisions
      // so the UI isn't asked to re-render for nothing.
      if (mode === 'poll' && st.rev === lastRev) return;
      lastRev = st.rev;
      onState(st);
    }

    /* ---- preferred path ---- */
    function startSSE() {
      if (stopped) return;
      try { es = new EventSource('/api/stream'); }
      catch { return startPolling(); }

      watchdog = setTimeout(() => { if (!gotFirst) startPolling(); }, firstByteMs);

      es.addEventListener('state', (e) => {
        clearTimeout(watchdog);
        try { deliver(JSON.parse(e.data)); } catch (err) { console.error(err); }
      });

      es.onerror = () => {
        if (stopped) return;
        if (!gotFirst) { startPolling(); return; }   // never worked — stop trying
        status('offline');
        es.close();
        setTimeout(startSSE, 2000);                  // worked before, so retry
      };
    }

    /* ---- fallback ---- */
    function startPolling() {
      if (stopped || mode === 'poll') return;
      mode = 'poll';
      clearTimeout(watchdog);
      if (es) { es.close(); es = null; }

      const tick = async () => {
        if (stopped) return;
        try {
          const res = await fetch('/api/state', { cache: 'no-store' });
          deliver(await res.json());
        } catch {
          status('offline');
        }
        pollTimer = setTimeout(tick, pollMs);
      };
      tick();
    }

    startSSE();

    return {
      get mode() { return mode; },
      stop() { stopped = true; if (es) es.close(); clearTimeout(pollTimer); clearTimeout(watchdog); },
    };
  }

  const api = { connect };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LBLive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
