'use strict';

// Exchanges the access code Companion printed at startup for a browser session.
// The code normally arrives in the address fragment, which browsers never send to a server or log.
(() => {
  const status = document.getElementById('signin-status'), form = document.getElementById('signin'), input = document.getElementById('signin-code');
  async function open(token) {
    status.textContent = 'Opening Companion…';
    try {
      const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!response.ok) throw new Error();
      location.replace('/');
    } catch {
      status.textContent = 'That access code did not work. Open the address Companion printed when it started, or paste its access code here.';
      input.value = ''; input.focus();
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); const token = input.value.trim(); if (token) void open(token); });
  const supplied = new URLSearchParams(location.hash.slice(1)).get('access');
  if (supplied) { history.replaceState(null, '', '/'); void open(supplied); }
})();
