'use strict';

// The browser's half of the web shell (src/web-shell.mjs). It replaces the desktop preload bridge and
// performs what a native window would: pick a file, confirm, open a link or document, copy text.
// Loaded only when Companion serves its screens over HTTP; the desktop app never loads this file.
(() => {
  const client = crypto.randomUUID();
  const stateListeners = new Set(), sectionListeners = new Set(), open = new Map();
  const waitingForStream = new Set(), downloads = new Map();
  let streamConnected = false;
  function streamReady() {
    if (streamConnected) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = ready => { clearTimeout(timer); waitingForStream.delete(finish); resolve(ready); };
      const timer = setTimeout(() => finish(false), 30_000);
      waitingForStream.add(finish);
    });
  }
  document.documentElement.dataset.shell = 'web';
  // `#section=…` opens one settings section (the browser extension links to Form filling this way).
  let pendingSection = new URLSearchParams(location.hash.slice(1)).get('section');
  if (location.hash) history.replaceState(null, '', '/');

  async function invoke(op, input = {}) {
    if (!await streamReady()) return { ok: false, error: { code: 'LOCAL_OPERATION_FAILED', message: 'Companion is not connected in this browser. Reopen it and try again.' } };
    const response = await fetch('/api/invoke', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Companion-Client': client }, body: JSON.stringify({ op, input }) });
    if (response.status === 401) { location.reload(); return { ok: false, error: { code: 'LOCAL_LOCKED', message: 'Open Companion again with its access code.' } }; }
    return response.json();
  }
  const subscribe = (listeners, callback) => {
    if (typeof callback !== 'function') return undefined;
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  window.companion = Object.freeze({ web: true, invoke,
    onState: callback => subscribe(stateListeners, callback),
    onSettingsSection: callback => {
      const unsubscribe = subscribe(sectionListeners, callback);
      if (unsubscribe && pendingSection) { const section = pendingSection; pendingSection = null; callback(section); }
      return unsubscribe;
    } });

  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const button = (label, className) => { const element = node('button', className, label); element.type = 'button'; return element; };
  const answer = (id, path = '', init = {}) => fetch(`/api/dialog/${id}${path}`, { method: 'POST', ...init,
    headers: { ...init.headers, 'X-Companion-Client': client } });

  /** A modal built from the app's own dialog styles. `dismiss` runs when the user closes it without choosing. */
  function modal(id, title, build, dismiss = () => {}) {
    const dialog = node('dialog'), rule = node('div', 'edge-rule'), content = node('div', 'dialog-body'), heading = node('h2', '', title);
    rule.setAttribute('aria-hidden', 'true');
    content.append(heading); dialog.append(rule, content); document.body.append(dialog);
    const close = () => { open.delete(id); if (dialog.open) dialog.close(); dialog.remove(); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); close(); });
    open.get(id)?.();
    open.set(id, close);
    build(content, close);
    dialog.showModal();
  }

  function chooseFile({ id, title, extensions }) {
    const cancel = () => { void answer(id, '/cancel'); };
    modal(id, title, (content, close) => {
      const field = node('label', 'decisions-field'), caption = node('span', '', extensions.length ? `File (${extensions.map(value => `.${value}`).join(', ')})` : 'File');
      const input = node('input'), status = node('p'), actions = node('div', 'actions dialog-actions'), dismiss = button('Cancel', 'ghost');
      input.type = 'file'; if (extensions.length) input.accept = extensions.map(value => `.${value}`).join(',');
      status.setAttribute('role', 'alert'); status.hidden = true;
      field.append(caption, input); actions.append(dismiss); content.append(field, status, actions);
      dismiss.addEventListener('click', () => { cancel(); close(); });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        input.disabled = true; dismiss.disabled = true; status.hidden = false; status.textContent = 'Sending the file to Companion…';
        try {
          const response = await answer(id, '/file', { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Companion could not read this file.');
          close();
        } catch (error) {
          status.textContent = `${error.message} Choose another file or cancel.`;
          input.value = ''; input.disabled = false; dismiss.disabled = false;
        }
      });
    }, cancel);
  }

  function confirmMessage({ id, type, message, detail, buttons, defaultId, cancelId }) {
    const choose = response => answer(id, '', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response }) });
    modal(id, message, (content, close) => {
      if (detail) content.append(node('p', '', detail));
      const actions = node('div', 'actions dialog-actions');
      buttons.forEach((label, index) => {
        const control = button(label, index === cancelId ? 'ghost' : type === 'warning' ? 'ghost destructive' : 'primary');
        if (index === defaultId) control.autofocus = true;
        control.addEventListener('click', () => { void choose(index); close(); });
        actions.append(control);
      });
      content.append(actions);
    }, () => { void choose(cancelId); });
  }

  // Browsers block new tabs and clipboard writes that do not follow a click closely enough.
  // When that happens, offer the same action behind one explicit click.
  function offerLink(title, url, label) {
    modal(`link:${url}`, title, (content, close) => {
      const actions = node('div', 'actions dialog-actions'), go = button(label, 'primary'), dismiss = button('Close', 'ghost');
      go.addEventListener('click', () => { window.open(url, '_blank'); close(); });
      dismiss.addEventListener('click', () => close());
      actions.append(dismiss, go); content.append(actions);
    });
  }
  function openLink(url) {
    if (!/^https?:/i.test(url)) { location.assign(url); return; }
    // This page isolates its browsing context, so the new tab cannot reach back into Companion.
    if (!window.open(url, '_blank')) offerLink('Open this page', url, 'Open');
  }
  function openFile({ url, name, download, receipt }) {
    if (receipt) {
      if (downloads.has(receipt)) return;
      const received = value => fetch(`/api/downloads/${receipt}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Companion-Client': client }, body: JSON.stringify({ received: value }) });
      downloads.set(receipt, (async () => {
        try {
          const response = await fetch(url, { headers: { 'X-Companion-Client': client } });
          if (!response.ok) throw new Error('The export is no longer current.');
          const blob = await response.blob();
          if (!blob.size) throw new Error('The export was empty.');
          const objectUrl = URL.createObjectURL(blob), link = node('a');
          link.href = objectUrl; link.download = name; link.hidden = true;
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
          // This confirms received bytes and browser handoff, not an OS disk-save result.
          const acknowledgement = await received(true);
          if (!acknowledgement.ok) throw new Error('The export changed before delivery finished.');
        } catch { await received(false).catch(() => {}); }
      })());
      return;
    }
    if (download) {
      const link = node('a'); link.href = url; link.download = name; link.hidden = true;
      document.body.append(link); link.click(); link.remove();
    } else if (!window.open(url, '_blank')) offerLink(name, url, 'Open');
  }
  async function copyText({ text }) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      modal(`copy:${text.length}`, 'Copy this text', (content, close) => {
        const value = node('pre', 'command', text), actions = node('div', 'actions dialog-actions'), copy = button('Copy', 'primary'), dismiss = button('Close', 'ghost');
        value.tabIndex = 0;
        copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); close(); } catch { copy.textContent = 'Select the text and copy it'; } });
        dismiss.addEventListener('click', () => close());
        actions.append(dismiss, copy); content.append(value, actions);
      });
    }
  }

  // Requests can arrive at once (a dialog that was already waiting), so listen only when the page can show them.
  document.addEventListener('DOMContentLoaded', () => {
    const source = new EventSource(`/api/events?client=${client}`);
    const on = (event, handle) => source.addEventListener(event, message => { handle(JSON.parse(message.data)); });
    // A reconnect means Companion restarted or the network dropped: reread everything.
    source.addEventListener('open', () => {
      streamConnected = true;
      for (const finish of [...waitingForStream]) finish(true);
      for (const listener of stateListeners) listener();
    });
    source.addEventListener('error', () => { streamConnected = false; if (source.readyState === EventSource.CLOSED) location.reload(); });
    on('state-changed', () => { for (const listener of stateListeners) listener(); });
    on('settings-section', section => { for (const listener of sectionListeners) listener(section); });
    // Named apart from EventSource's own `open` and `error` events.
    on('open-link', ({ url }) => openLink(url));
    on('open-file', openFile);
    on('copy-text', value => { void copyText(value); });
    on('dialog', request => (request.kind === 'open' ? chooseFile : confirmMessage)(request));
    on('dialog-closed', ({ id }) => open.get(id)?.());
    on('reload', () => location.reload());
  });
})();
