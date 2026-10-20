'use strict';

(() => {
  const element = name => document.getElementById(`update-${name}`);
  const labels = {
    idle: '', checking: 'Checking releases…',
    available: 'A newer version is available.', current: 'You have the latest published version.',
    'no-release': 'No compatible published release is available.', downloading: 'Downloading update…',
    downloaded: 'Ready to install.',
    'awaiting-approval': 'Approve installation in the companion dialog.', staging: 'Preparing update…',
    installing: 'Installing update. The companion will reopen.', launched: 'Update launched; awaiting confirmation.',
    confirmed: 'Update confirmed.', 'rolled-back': 'The previous version was restored.',
    'manual-required': 'Manual installation is needed. Check for updates or follow the download instructions below.',
    cancelled: 'Update canceled.', error: 'Update stopped.',
  };
  const active = new Set(['checking', 'downloading', 'awaiting-approval', 'staging']);
  let current, pending = false, failure = '', generation = 0;
  function render() {
    const status = current?.status;
    element('version').textContent = current ? `Version ${current.version}${current.latestVersion ? ` · Latest ${current.latestVersion}` : ''}` : '';
    element('status').textContent = current ? `${labels[status] ?? 'Update status unavailable.'}${current.blocked ? ' Finish active work before updating.' : ''}` : '';
    element('check').disabled = !current || pending || current.blocked || active.has(status) || status === 'installing';
    element('download').hidden = !['available', 'cancelled', 'error'].includes(status) || !current?.latestVersion;
    element('download').disabled = pending || current?.blocked;
    element('install').hidden = status !== 'downloaded' && !(status === 'manual-required' && current?.error?.code === 'MANUAL_INSTALL_REQUIRED');
    element('install').disabled = pending || current?.blocked;
    element('install').textContent = status === 'manual-required' ? 'Open downloaded update' : 'Install update';
    element('cancel').hidden = !active.has(status);
    element('cancel').disabled = !current;
    const progress = current?.progress;
    element('progress').hidden = status !== 'downloading';
    if (progress?.total > 0) {
      element('progress').max = progress.total;
      element('progress').value = progress.received;
      element('progress').setAttribute('aria-valuetext', `${progress.received.toLocaleString()} of ${progress.total.toLocaleString()} bytes`);
    } else {
      element('progress').removeAttribute('value');
      element('progress').removeAttribute('aria-valuetext');
    }
    const error = failure || (current?.status === 'no-release' ? '' : current?.error?.message) || '';
    element('error').textContent = error;
    element('error').hidden = !error;
  }
  async function perform(op) {
    if (!current || (pending && op !== 'update-cancel')) return;
    const token = generation;
    if (op !== 'update-cancel') pending = true;
    failure = ''; render();
    try {
      const response = await window.companion.invoke(op);
      if (token !== generation) return;
      if (!response.ok) throw new Error(response.error?.message || 'Update action failed.');
      current = response.result;
    } catch (error) { if (token === generation) failure = error.message; }
    finally {
      if (token === generation) { pending = false; render(); }
    }
  }
  for (const action of ['check', 'download', 'install', 'cancel']) element(action).addEventListener('click', () => { void perform(`update-${action}`); });
  window.updatesUI = {
    refresh(value) { current = value; render(); },
    clear() { generation++; current = null; pending = false; failure = ''; render(); },
  };
  window.updatesUI.clear();
})();
