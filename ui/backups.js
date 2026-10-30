// Settings → Backups receives only file labels, profile summaries and an opaque restore ID.
// File selection, validation, safety copies and replacement stay in the main process.
(() => {
  const element = name => document.getElementById(`backup-${name}`);
  const save = document.getElementById('backup');
  let available = false, externalBusy = false, pending = '', preview = null;
  let contextVersion, generation = 0;
  let cancellation = Promise.resolve();

  async function invoke(op, input = {}) {
    const response = await window.companion.invoke(op, input);
    if (!response.ok) throw new Error(response.error?.message || 'Companion could not finish this action. Try again.');
    return response.result;
  }
  function cancelStage() {
    cancellation = cancellation.then(() => invoke('backup-cancel')).catch(() => {});
    return cancellation;
  }
  function focus(control) {
    if (control && !control.disabled && control.getClientRects().length) {
      if (control === element('preview-title')) control.scrollIntoView({ block: 'nearest' });
      control.focus({ preventScroll: true });
    }
    else if (document.getElementById('settings-backups').getClientRects().length) document.getElementById('settings-tab-backups').focus({ preventScroll: true });
  }
  function feedback(message = '', error = '') {
    element('status').textContent = message;
    element('error').textContent = error;
    element('error').hidden = !error;
  }
  function warnings(control, values = []) {
    control.replaceChildren(...values.map(value => {
      const item = document.createElement('li');
      item.textContent = value;
      return item;
    }));
    control.hidden = !values.length;
  }
  function renderControls() {
    const disabled = !available || externalBusy || Boolean(pending);
    save.disabled = disabled || Boolean(preview);
    element('choose').disabled = disabled;
    element('open-folder').disabled = disabled;
    element('profile').disabled = disabled;
    element('cancel').disabled = disabled;
    element('restore').disabled = disabled || !preview;
    save.textContent = pending === 'backup' ? 'Saving…' : 'Save backup';
    element('choose').textContent = pending === 'backup-preview' ? 'Opening…' : 'Restore backup';
    element('restore').textContent = pending === 'backup-restore' ? 'Restoring…' : 'Restore profile';
    document.getElementById('settings-backups').setAttribute('aria-busy', String(Boolean(pending)));
  }
  function clearPreview() {
    preview = null;
    element('preview').hidden = true;
    element('profile').replaceChildren();
    element('file').textContent = '';
    element('profile-name').textContent = '';
    element('counts').replaceChildren();
    warnings(element('warnings'));
  }
  function renderProfile() {
    const profile = preview?.profiles.find(item => item.id === element('profile').value);
    if (!profile) return;
    element('profile-name').hidden = preview.profiles.length > 1;
    element('profile-name').textContent = profile.name;
    element('counts').replaceChildren();
    for (const [key, label] of [['cvs', 'CVs'], ['facts', 'Saved answers'], ['jobs', 'Jobs'], ['applications', 'Applications']]) {
      const term = document.createElement('dt'), value = document.createElement('dd');
      term.textContent = label;
      value.textContent = new Intl.NumberFormat().format(profile.counts[key]);
      element('counts').append(term, value);
    }
    warnings(element('warnings'), profile.warnings);
  }
  function showPreview(result) {
    preview = result;
    const date = typeof result.exportedAt === 'string' && Number.isFinite(Date.parse(result.exportedAt))
      ? `Saved ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(result.exportedAt))}`
      : 'Save date not available';
    element('file').textContent = `${result.filename} · ${date}`;
    element('profile').replaceChildren(...result.profiles.map(profile => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      return option;
    }));
    element('profile-field').hidden = result.profiles.length < 2;
    element('preview').hidden = false;
    renderProfile();
  }
  function invalidate(message) {
    generation++;
    const hadPreview = Boolean(preview);
    const hadFocus = element('preview').contains(document.activeElement);
    clearPreview();
    if (hadPreview || pending === 'backup-preview') {
      feedback('', message);
      // Discard the local token immediately, even if Companion cannot be reached.
      void cancelStage();
    }
    renderControls();
    if (hadFocus) focus(element('choose'));
  }
  async function perform(op, origin) {
    if (pending || externalBusy || !available) return;
    const selected = preview && { restoreId: preview.restoreId, profileId: element('profile').value };
    if (op === 'backup-restore' && !selected) return;
    pending = op;
    let nextFocus = origin;
    const request = generation;
    feedback(op === 'backup-restore' ? 'Saving your current profile, then restoring…' : op === 'backup' ? 'Saving backup…' : '');
    warnings(element('save-warnings'));
    renderControls();
    try {
      await cancellation;
      if (!available || request !== generation) return;
      if (op === 'backup-preview' && preview) {
        clearPreview();
        await invoke('backup-cancel');
      }
      const result = await invoke(op, op === 'backup-restore' ? selected : {});
      if (op === 'backup-preview') {
        if (request !== generation || !available) {
          await invoke('backup-cancel');
          return;
        }
        if (result.cancelled) {
          clearPreview();
          feedback('No backup selected.');
        } else {
          if (!result.restoreId || !result.profiles?.length) throw new Error('This file has no profile to restore. Choose another backup.');
          showPreview(result);
          nextFocus = element('preview-title');
        }
      } else if (op === 'backup-restore') {
        clearPreview();
        nextFocus = element('choose');
        if (!result.restored || !result.safetyBackupSaved) throw new Error('Companion could not confirm the restore. Check your profile before trying again.');
        feedback(`${result.profileName} restored. Your previous profile is saved in Backups.`);
        if (typeof window.refresh === 'function') await window.refresh();
      } else if (op === 'backup-cancel') {
        clearPreview();
        nextFocus = element('choose');
        feedback('Restore canceled. Your current profile is unchanged.');
      } else if (op === 'backup') {
        if (typeof result.exported !== 'boolean') throw new Error('Companion could not confirm that the backup was saved. Try again.');
        feedback(result.exported ? `Backup saved${result.filename ? `: ${result.filename}` : '.'}` : 'Backup canceled.');
        if (result.exported) warnings(element('save-warnings'), result.warnings);
      } else if (op === 'backup-open-folder') {
        if (!result.opened) throw new Error('Could not open the backups folder. Try again.');
        feedback('Backups folder opened.');
      }
    } catch (error) {
      if (['backup-preview', 'backup-restore', 'backup-cancel'].includes(op)) {
        clearPreview();
        nextFocus = element('choose');
        await cancelStage();
      }
      feedback('', error.message);
    } finally {
      pending = '';
      renderControls();
      focus(nextFocus);
    }
  }
  save.addEventListener('click', () => { void perform('backup', save); });
  for (const [name, op] of [['choose', 'backup-preview'], ['restore', 'backup-restore'], ['cancel', 'backup-cancel'], ['open-folder', 'backup-open-folder']]) {
    element(name).addEventListener('click', () => { void perform(op, element(name)); });
  }
  element('profile').addEventListener('change', renderProfile);
  window.backupsUI = {
    isBusy: () => Boolean(pending),
    setBusy(value) { externalBusy = value; renderControls(); },
    refresh(current) {
      available = current?.execution?.state !== 'locked' && Boolean(current?.execution);
      element('availability').textContent = available ? '' : 'Unlock your saved work to use backups.';
      if (!available && pending !== 'backup-restore') invalidate('Your saved work is locked. Unlock it, then choose Restore backup again.');
      else if (contextVersion !== undefined && contextVersion !== current.careerViewVersion && (preview || pending === 'backup-preview') && pending !== 'backup-restore') {
        invalidate('Your profile changed. Choose Restore backup again to review the latest details.');
      }
      contextVersion = current.careerViewVersion;
      renderControls();
    },
    unavailable() {
      available = false;
      element('availability').textContent = 'Could not reach Companion. Choose Retry in Me, or reopen Companion.';
      if (pending !== 'backup-restore') invalidate('Could not reach Companion. Choose Restore backup again when it is available.');
      renderControls();
    },
  };
})();
