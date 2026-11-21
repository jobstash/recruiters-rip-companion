'use strict';
(() => {
  const el = name => document.getElementById(`referral-${name}`);
  const sharing = el('sharing');
  let visible = false, identity = null, paired = false, generation = 0, code = null;
  let showSharing = false, savingFor = null;

  async function request(op, input = {}) {
    const response = await window.companion.invoke(op, input);
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  }
  function clear() {
    generation++;
    code = null;
    el('invite').hidden = el('balance').hidden = el('retry').hidden = el('connect').hidden = true;
    el('link').value = el('earned').textContent = el('available').textContent = el('code').textContent = el('status').textContent = '';
    el('copy').disabled = false;
  }
  async function load() {
    clear();
    if (!visible) return;
    if (!identity) { el('status').textContent = 'Free months is unavailable. Reopen Companion if it doesn’t reconnect.'; return; }
    if (!paired) {
      el('status').textContent = 'Connect your account to get your invite link and see your credits.';
      el('connect').hidden = false;
      return;
    }
    const current = generation;
    el('status').textContent = 'Loading your invite and credits…';
    try {
      const summary = await request('referrals');
      if (generation !== current) return;
      code = summary.code;
      el('link').value = summary.link;
      el('code').textContent = code;
      el('earned').textContent = String(summary.earnedMonths);
      el('available').textContent = String(summary.availableMonths);
      el('invite').hidden = el('balance').hidden = false;
      el('status').textContent = '';
    } catch (error) {
      if (generation !== current) return;
      if (error.code === 'PAIRING_REQUIRED' || error.code === 'DEVICE_UNAUTHORIZED') {
        el('status').textContent = 'Check your account connection in Settings, then open Free months again.';
        el('connect').hidden = false;
      } else {
        el('status').textContent = 'Couldn’t load your invite or credits. Check your connection and retry.';
        el('retry').hidden = false;
      }
    }
  }
  function renderPreference() {
    sharing.checked = showSharing;
    sharing.disabled = !identity || savingFor !== null;
    document.documentElement.toggleAttribute('data-pipeline-sharing', Boolean(identity && showSharing));
  }
  sharing.addEventListener('change', async () => {
    if (!identity || savingFor !== null) return;
    const owner = identity, show = sharing.checked;
    savingFor = owner; sharing.disabled = true;
    try {
      const saved = await request('pipeline-sharing-set', { show });
      if (identity === owner) showSharing = saved;
    } catch { if (identity === owner) window.showCompanionNotice('Couldn’t save your Pipeline sharing preference. Try again.', 'error'); }
    finally { if (savingFor === owner) savingFor = null; renderPreference(); }
  });
  el('copy').addEventListener('click', async () => {
    if (!code || el('copy').disabled) return;
    const current = generation;
    el('copy').disabled = true;
    try {
      const result = await request('referral-copy', { code });
      if (current === generation && result.copied) el('status').textContent = 'Invite link copied.';
    } catch (error) {
      if (current !== generation) return;
      if (['IDENTITY_CHANGED', 'LOCAL_LOCKED', 'PAIRING_REQUIRED'].includes(error.code)) {
        clear();
        el('status').textContent = 'Your account connection changed. Reopen Free months to get your current link.';
      } else {
        el('status').textContent = 'Couldn’t copy your link. Select it and copy it manually.';
        el('link').focus(); el('link').select();
      }
    } finally { if (current === generation) el('copy').disabled = false; }
  });
  el('connect').addEventListener('click', () => window.openCompanionSettings('account-settings'));
  el('retry').addEventListener('click', () => void load());

  window.referralsUI = {
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      void load();
    },
    refresh(state) {
      const available = state && state.execution?.state !== 'locked';
      const next = available ? JSON.stringify([state.deviceId, state.account?.id, state.paired]) : null;
      const changed = next !== identity;
      if (changed) savingFor = null;
      identity = next; paired = Boolean(available && state.paired);
      if (savingFor === null) showSharing = Boolean(available && state.showPipelineSharing);
      renderPreference();
      if (changed) void load();
    },
    invite() {
      document.querySelector('[data-view="referrals"]').click();
      el('heading').focus();
    },
    async share(stage) {
      try { await request('milestone-share', { stage }); }
      catch { window.showCompanionNotice('Couldn’t open the X draft. Try again.', 'error'); }
    },
  };
})();
