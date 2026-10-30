const action = (id, label) => ({ id, label });

// Presentation only: readiness and handoffs are supplied by Companion, never inferred from an app opening.
export function derivePanelFlow(state = {}) {
  const app = state.application;
  const host = state.applicationHost || state.companion?.preferredHost || app?.preferredHost || 'claude';
  const hostName = host === 'codex' ? 'Codex' : 'Claude';
  const hostInfo = state.companion?.hostInfo?.[host] || app?.hostInfo?.[host];
  const fields = state.answersStale ? [] : (state.prepared?.fields || []);
  const answerCount = fields.filter(field => !field.manualOnly && field.empty && String(state.edits?.[field.id] ?? field.value ?? '').trim()).length;
  const cvReady = !!app?.documents?.some(doc => doc.kind === 'cv' && doc.ready);
  const introReady = app?.introduction?.ready === true;
  const result = (kind, message, primary = null, extra = {}) => ({ kind, message, primary, host, hostName, answerCount, cvReady, introReady, ...extra });
  if (state.busy) {
    const message = {
      detect: 'Reading this page…', prepare: 'Preparing saved answers…', 'prepare-saved': 'Preparing saved answers…',
      'application-prepare': `Preparing this application in ${hostName}…`, 'answer-save': 'Saving answer…', 'answer-undo': 'Removing saved answer…',
      'application-host': 'Saving AI app choice…', 'application-document': 'Showing your CV…',
      'copy-intro': 'Copying introduction…', save: 'Saving as applied…', settings: 'Opening Companion…',
      configure: 'Opening settings…', install: 'Opening downloads…', 'open-job': 'Opening job…', 'application-open-ad': 'Opening job ad…',
    }[state.busy] || 'Working…';
    return result('working', message, state.busy === 'prepare' || state.busy === 'prepare-saved' ? action('cancel', 'Stop') : null);
  }
  // Page evidence wins over setup requirements: there is no application to prepare here.
  if (state.pageKind === 'none') return result('no-job', 'No job found on this page. Open a job ad or application form.', action('detect', 'Read page'));
  if (state.pageKind === 'listing') return result('listing', 'Open the job you want to apply for, or select the jobs you applied to and save them.', null);
  if (state.errorCode === 'COMPANION_UNAVAILABLE') return result('unavailable', 'Companion is not running. Open it, then retry. Not installed? Choose Get Companion.', action('detect', 'Retry'), { recovery: true, install: true });
  if (state.companion?.locked || state.errorCode === 'LOCAL_LOCKED') return result('locked', 'Unlock your saved data in Companion, then read the page again.', action('settings', 'Open Companion'), { recovery: true });
  if (state.errorCode === 'COMPANION_UPDATE_REQUIRED' || (state.companion && !(state.companion.workflowVersion >= 2))) return result('update', 'Update Companion to prepare this application, then read the page again.', action('settings', 'Open Companion'), { recovery: true });
  if (state.errorCode && /^(DECISIONS_|OPENAI_|API_)/.test(state.errorCode)) return result('extra-help-error', 'Extra form help is unavailable. You can still use saved answers.', action('prepare-saved', 'Use saved answers'));
  if (state.error) return result('error', state.error, action('detect', 'Read again'));
  if (state.companion?.hasCv === false && app?.state !== 'ready') return result('missing-cv', 'Import your CV in Companion → Me → Import CV, then read the page again.', action('settings', 'Open Companion'), { recovery: true });
  if (state.answersStale || app?.state === 'needs_refresh') return result('stale', 'The job or your saved details changed. Refresh this application before using its answers.', app?.state === 'ready' ? action('application-answers', 'Refresh answers') : app ? action('application-prepare', 'Update application') : action('prepare-saved', 'Refresh answers'));
  if (app?.state === 'ready') return result('ready', answerCount ? `${answerCount} ${answerCount === 1 ? 'answer' : 'answers'} ready` : 'Your application is ready.', state.applicationAnswersPending ? action('application-answers', 'Use saved answers') : null);
  if (app?.handoff?.state === 'agent_read') {
    const name = app.handoff.host === 'codex' ? 'Codex' : 'Claude';
    return result('host-read', `${name} has read the request. Return there to continue; saved documents appear here when available.`);
  }
  if (app?.handoff?.requiresSend === true) {
    const name = app.handoff.host === 'codex' ? 'Codex' : 'Claude';
    const instruction = app.handoff.mode === 'cli' ? `In ${name}, review the request and press Enter.`
      : app.handoff.mode === 'desktop' ? `In ${name}, review the request and click Send.`
      : `In ${name}, review and send the request.`;
    return result('awaiting-send', instruction);
  }
  if (hostInfo?.available === false) return result('unavailable-ai', `${hostName} is unavailable. Choose another app in Options or set it up in Companion → Settings → AI apps.`, action('settings', 'Open Companion'), { recovery: true });
  if (app?.state === 'needs_job') return result('needs-job', app.jobUrl ? `${hostName} will need to read the full linked job ad before preparing your application.` : 'Open the original job ad, then read the page to identify this job.', app.jobUrl ? action('application-prepare', 'Prepare application') : action('detect', 'Read page'));
  if (app || state.pageKind === 'job' || state.pageKind === 'application') return result(cvReady || introReady || app?.state === 'drafts' ? 'partial' : 'prepare', cvReady || introReady ? 'Some of your application is ready. Prepare the remaining documents and answers.' : 'Prepare a tailored CV and introduction for this job.', action('application-prepare', 'Prepare application'));
  if (state.prepared) return result('answers', answerCount ? `${answerCount} ${answerCount === 1 ? 'answer' : 'answers'} ready` : 'No saved answers match this form.', null);
  return result('connecting', 'Read the current job ad or application.', action('detect', 'Read page'));
}
