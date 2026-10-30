'use strict';

(() => {
  const element = name => document.getElementById(`update-${name}`);
  const labels = {
    idle: '', checking: 'Checking for updates…',
    available: 'An update is available.', current: 'You have the latest published version.',
    ahead: 'This version is newer than the latest published release.',
    'no-release': 'No compatible published release is available.', downloading: 'Downloading update in the background…',
    downloaded: 'Downloaded and ready to install.', staging: 'Preparing update in the background…',
    installing: 'Installing update. The companion will reopen.', launched: 'The updated app is starting.',
    confirmed: 'The update was installed.', 'rolled-back': 'The update did not start. The previous version was restored.',
    'manual-required': 'This update needs to be installed manually.',
    cancelled: 'Update canceled.', error: 'The update could not finish.',
  };
  const active = new Set(['checking', 'downloading', 'staging', 'installing', 'launched']);
  function newerVersion() {
    if (!current?.latestVersion) return false;
    const latest = current.latestVersion.split('.').map(Number), installed = current.version.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
      if (latest[index] !== installed[index]) return latest[index] > installed[index];
    }
    return false;
  }
  let current, pending = false, preferencePending = false, failure = '', generation = 0;
  function render() {
    const status = current?.status;
    const automatic = current?.automation?.enabled !== false;
    const supported = current?.automaticSupported === true;
    const source = current?.installationKind === 'source';
    const localSource = source && current?.sourceProvenance === 'local-candidate';
    const restarting = ['installing', 'launched'].includes(status);
    element('version').textContent = current ? `Installed ${current.version}${source ? ` · ${localSource ? 'Local source build' : 'Source build'}` : ''}${current.latestVersion ? ` · Latest published ${current.latestVersion}` : ''}` : '';
    element('automatic').checked = automatic;
    element('automatic').disabled = !current || preferencePending || restarting;
    element('reason').textContent = current?.automaticReason || (automatic
      ? `Updates ${source ? 'build' : 'download'} in the background. The app restarts when you’re away and no work is running.`
      : 'Automatic updates are off. You can still check and install updates here.');
    const waiting = supported && automatic && status === 'downloaded';
    const statusLabel = localSource && status === 'current' ? 'This local build has the same version number as the latest published release.'
      : source && status === 'downloading' ? 'Building update from source…'
      : source && status === 'downloaded' ? 'Built and ready to install.' : labels[status];
    element('status').textContent = current ? (waiting ? `Update ${source ? 'built' : 'downloaded'}. Waiting until you’re away to restart.` : statusLabel ?? 'Update status unavailable.') : '';
    element('check').disabled = !current || pending || active.has(status) || status === 'downloaded';
    element('download').hidden = (source && !supported) || !newerVersion() || !['available', 'cancelled', 'error'].includes(status) || (automatic && supported && status === 'available');
    element('download').textContent = source ? 'Build update' : 'Download update';
    element('download').disabled = pending || restarting;
    element('install').hidden = (source && !supported) || (status !== 'downloaded' && !(status === 'manual-required' && current?.error?.code === 'MANUAL_INSTALL_REQUIRED'));
    element('install').disabled = pending || current?.blocked;
    element('install').textContent = status === 'manual-required' || !supported ? 'Install manually' : 'Restart now';
    element('cancel').hidden = !['checking', 'downloading', 'staging'].includes(status);
    element('cancel').disabled = !current;
    element('source-guide').hidden = !source || supported;
    element('source-guide').disabled = pending || restarting;
    const progress = current?.progress;
    element('progress').hidden = status !== 'downloading';
    element('progress').setAttribute('aria-label', source ? 'Source update build progress' : 'Update download progress');
    if (progress?.total > 0) {
      element('progress').max = progress.total;
      element('progress').value = progress.received;
      element('progress').setAttribute('aria-valuetext', `${progress.received.toLocaleString()} of ${progress.total.toLocaleString()} bytes`);
    } else {
      element('progress').removeAttribute('value');
      element('progress').removeAttribute('aria-valuetext');
    }
    const error = failure || (current?.status === 'no-release' ? '' : current?.error?.message) || current?.automation?.error || '';
    element('error').textContent = error;
    element('error').hidden = !error;
  }
  async function perform(op, input = {}) {
    const preference = op === 'update-preferences';
    if (!current || (preference ? preferencePending : pending && op !== 'update-cancel')) return;
    const token = generation;
    if (preference) preferencePending = true;
    else if (op !== 'update-cancel') pending = true;
    failure = ''; render();
    try {
      const response = await window.companion.invoke(op, input);
      if (token !== generation) return;
      if (!response.ok) throw new Error(response.error?.message || 'Update action failed.');
      current = response.result;
    } catch (error) { if (token === generation) failure = error.message; }
    finally {
      if (token === generation) {
        if (preference) preferencePending = false; else pending = false;
        render();
      }
    }
  }
  for (const action of ['check', 'download', 'install', 'cancel', 'source-guide']) element(action).addEventListener('click', () => { void perform(`update-${action}`); });
  element('automatic').addEventListener('change', () => {
    void perform('update-preferences', { automaticUpdates: element('automatic').checked });
  });
  window.updatesUI = {
    refresh(value) { current = value; render(); },
    clear() { generation++; current = null; pending = false; preferencePending = false; failure = ''; render(); },
  };
  window.updatesUI.clear();
})();
