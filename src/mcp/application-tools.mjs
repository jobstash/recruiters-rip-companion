import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PROGRESS_STAGES, applicationProgress, changeProgress } from '../application-progress.mjs';
import { applicationContextFingerprint, assertApplicationClarificationsResolved, pendingApplicationInterviews, originalJobText, currentApplicationJob, isApplicationWritingField, upsertApplication } from '../application-workflow.mjs';
import { readCareer, mutateCareer, replayCareer, mutationSchema, fail } from './state.mjs';
import { inspectCvQuality } from './cv-quality.mjs';
import { CV_WRITING_GUIDE } from './cv-writing-policy.mjs';
export { CV_WRITING_GUIDE } from './cv-writing-policy.mjs';
import { currentAssessment } from './matching-tools.mjs';
import { matchingProfileVersion } from './assessment-policy.mjs';
import { localJobOriginal } from './job-tools.mjs';
import { formEvidence } from './form-tools.mjs';
import { assertJobNotBlocked, blockFilter } from './blocklist.mjs';
import { careerGapContext } from './career-gap.mjs';
import { assertMasterReady, cvDocumentSchema, presentationSchema } from './master-cv.mjs';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const uuid = { type: 'string', format: 'uuid' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const strings = (maxItems, maxLength, minItems = 0) => ({ type: 'array', items: text(maxLength), maxItems, minItems });
const cvSchema = cvDocumentSchema;
const tailoringBinding = { masterVersion: { type: 'integer', minimum: 1 } };
const ajv = new Ajv({ strict: false }); addFormats(ajv);
const validCv = ajv.compile(cvSchema);
const validParagraphs = ajv.compile(strings(12, 1500, 2));
const jobSchema = object({ title: text(300), company: text(300), description: text(100000), url: text(2000), applyUrl: text(2000), location: text(300) }, ['title', 'company', 'description']);
const pagination = { limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0, maximum: 10000 } };
const defaultPresentation = Object.freeze({ template: 'classic', paper: 'A4' });
const now = () => new Date().toISOString();

function application(career, id) {
  const app = career.applications[id];
  if (!app) fail('NOT_FOUND', 'This application was not found. List local applications and choose its ID.');
  assertJobNotBlocked(career, app.job.id, app.job);
  return app;
}
/** The CV header always comes from the current profile, never the draft. */
export function cvHeading(profile) {
  const contact = [...new Set([profile.email, profile.phone, profile.location, profile.linkedinUrl, ...(profile.links ?? [])])]
    .filter(value => typeof value === 'string' && value.trim()).join(' · ');
  return { ...(profile.name?.trim() ? { name: profile.name.trim() } : {}), ...(contact ? { contact } : {}) };
}
function assertTailoringContext(career, app, args) {
  const master = assertMasterReady(career);
  if (args.masterVersion !== master.version)
    fail('APPLICATION_CONTEXT_CHANGED', 'Read career_application_context and tailor a copy of its current master version.');
  const job = currentApplicationJob(career, app);
  if (!job.description?.trim() || job.complete === false) fail('FULL_AD_REQUIRED', 'Read and save the complete original advert before tailoring.');
  return master;
}
function catalogueJob(job, jobId) {
  const company = typeof job?.company === 'string' ? job.company : job?.company?.name;
  if (!job || ![job.id, job.shortUUID].includes(jobId) || !job.title?.trim() || !company?.trim() || !job.description?.trim())
    fail('INVALID_JOB', 'The catalogue did not return a complete matching job. Read the job again, or paste the advert as job.');
  const url = job.applyUrl ?? job.url;
  return { id: job.id, title: job.title, company, description: job.description,
    ...(typeof job.classification === 'string' && job.classification ? { classification: job.classification } : {}),
    ...(typeof url === 'string' && url ? { url } : {}), ...(typeof job.url === 'string' && job.url ? { originalUrl: job.url } : {}),
    ...(typeof job.location === 'string' && job.location ? { location: job.location } : {}) };
}
function capturedApplicationJob(career, jobId) {
  const { id, title, company, description, applyUrl, url, location } = localJobOriginal(career, jobId, true);
  return { id, title, company, description, url: applyUrl, originalUrl: url, ...(location ? { location } : {}) };
}
function summary(app) {
  return { id: app.id, job: { ...(app.job.id ? { id: app.job.id } : {}), title: app.job.title, company: app.job.company, ...(app.job.url ? { url: app.job.url } : {}) },
    cvVersion: app.cv?.version ?? null, coverLetterVersion: app.coverLetter?.version ?? null,
    exports: app.exports.length, createdAt: app.createdAt, updatedAt: app.updatedAt, progress: applicationProgress(app) };
}
function context(career, app) {
  const master = assertMasterReady(career);
  const { name, email, phone, location, links, linkedinUrl, headline, seniority, roleCapabilities, skills, preferences = {} } = career.profile;
  const facts = {};
  for (const fact of Object.values(career.facts).sort((a, b) => a.subject.localeCompare(b.subject, 'en', { sensitivity: 'base' })))
    (facts[fact.kind] ??= []).push(fact);
  const row = app.job.id ? career.matching?.scores?.[app.job.id] : undefined;
  const assessment = row && currentAssessment(row, matchingProfileVersion(career))
    ? (({ overall, band, decision, gates, dimensions, reason }) => ({ overall, band, decision, gates, dimensions, reason }))(row) : null;
  const fingerprint = applicationContextFingerprint(career, app), evidence = formEvidence(career), careerGap = careerGapContext(career);
  const forms = Object.values(career.formDrafts ?? {}).filter(draft => draft.applicationId === app.id)
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
    .map(draft => ({ formId: draft.formId, snapshot: draft.snapshot, evidenceRevision: draft.evidenceRevision,
      url: draft.url, title: draft.title, fields: draft.fields, writingFields: draft.fields.filter(isApplicationWritingField), actions: draft.actions ?? [],
      contextCurrent: draft.applicationContext === fingerprint && draft.evidence === evidence,
      instructions: 'Read career_form_read to check attachment and current answers; refresh the captured page when contextCurrent is false. Write motivation, why-company and fit prose yourself from the candidate and employer context. Stage supported prose and exact choice values. Protected/manual-only means unavailable for automatic staging: use native browser controls for authorized consents and ordinary applicant declarations under the standing delegation. Do not hand those tasks or Submit back to the candidate. Do not invent personal facts or overwrite populated fields blindly.' }));
  return { revision: career.revision, applicationId: app.id, masterVersion: master.version,
    application: app, job: currentApplicationJob(career, app), forms,
    jobText: originalJobText(currentApplicationJob(career, app).description),
    profile: { name, email, phone, location, links, linkedinUrl, headline, seniority, roleCapabilities, skills }, preferences,
    master: structuredClone({ version: master.version, document: master.document, presentation: master.presentation, updatedAt: master.updatedAt }),
    originalSources: Object.values(career.sources ?? {}).filter(source => !source.archived && source.purpose === 'cv')
      .map(source => ({ id: source.id, name: source.name, text: source.text })),
    pendingInterviews: pendingApplicationInterviews(career, app.id),
    facts, assessment, ...(careerGap ? { careerGap } : {}),
    presentation: {
      templates: [{ id: 'classic', description: 'Serif text with ruled section headings.' }, { id: 'modern', description: 'Sans-serif text in a single column.' }],
      papers: ['A4', 'LETTER'], fontSize: 11, current: app.cv?.presentation ?? defaultPresentation,
    },
    guide: CV_WRITING_GUIDE };
}

export function createApplicationTools({ store, platform, documents, exportDocument, cleanupExports = async () => {}, withExportTransaction = action => action() }) {
  const tools = [];
  const guard = (args, result) => {
    const career = readCareer(store);
    if (args.applicationId) application(career, args.applicationId);
    if (args.jobId || args.job) assertJobNotBlocked(career, args.jobId, args.job);
    if (result?.job) assertJobNotBlocked(career, result.job.id, result.job);
    if (result?.applicationId && career.applications[result.applicationId]) application(career, result.applicationId);
    return result;
  };
  const add = (name, description, inputSchema, readOnly, invoke) => tools.push({ name, description, inputSchema, readOnly, invoke });
  const save = async (name, args, change) => {
    // Receipt replay must obey today's blocks, not the policy when the receipt was saved.
    guard(args);
    if (['career_application_cv_save', 'career_application_letter_save'].includes(name)) {
      const career = readCareer(store);
      assertTailoringContext(career, application(career, args.applicationId), args);
    }
    return guard(args, await mutateCareer(store, args, name, args, change));
  };
  const mutate = (name, description, properties, required, change) => add(name, description,
    object({ ...mutationSchema, ...properties }, ['requestId', 'revision', ...required]), false,
    args => save(name, args, career => change(career, args)));

  add('career_job_read', 'Read an unblocked complete catalogue job or local capture (including listing text marked complete:false).', object({ id: text(100) }), true, async args => {
    assertJobNotBlocked(readCareer(store), args.id);
    const job = typeof args.id === 'string' && args.id.startsWith('local:') ? localJobOriginal(readCareer(store), args.id) : await platform('job_read', args);
    assertJobNotBlocked(readCareer(store), args.id, job);
    return job;
  });
  add('career_application_create', 'Create or reuse the application for the exact catalogue or complete locally captured job (jobId), or full pasted advert (job, with exact url and optional applyUrl). Never match by title/company alone. A changed original invalidates old document fingerprints. Read career_application_context and reuse current documents; save and export new drafts only when missing or stale.',
    object({ ...mutationSchema, jobId: text(100), job: jobSchema }, ['requestId', 'revision']), false, async args => {
      if ((args.jobId === undefined) === (args.job === undefined)) fail('INVALID_INPUT', 'Provide either jobId for a catalogue job or job for a pasted advert.');
      guard(args);
      const replay = replayCareer(store, args, 'career_application_create', args);
      if (replay) return guard(args, replay);
      let job = args.job;
      if (args.jobId !== undefined) {
        if (typeof args.jobId === 'string' && args.jobId.startsWith('local:')) job = capturedApplicationJob(readCareer(store), args.jobId);
        else {
          const original = await platform('job_read', { id: args.jobId });
          assertJobNotBlocked(readCareer(store), args.jobId, original);
          job = catalogueJob(original, args.jobId);
        }
      }
      assertJobNotBlocked(readCareer(store), args.jobId ?? job.id, job);
      return save('career_application_create', args, career => {
        const app = upsertApplication(career, job);
        return { applicationId: app.id, job: app.job };
      });
    });
  add('career_applications_list', 'List saved applications with their progress (prepared, applied, interviewing with round, offer, hired, rejected or withdrawn), most recently updated first.', object(pagination, []), true, args => {
    const career = readCareer(store), offset = args.offset ?? 0, limit = args.limit ?? 20;
    const blocked = blockFilter(career);
    const apps = Object.values(career.applications).filter(app => !blocked(app.job)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { revision: career.revision, applications: apps.slice(offset, offset + limit).map(summary), total: apps.length,
      nextOffset: offset + limit < apps.length ? offset + limit : null };
  });
  add('career_application_read', 'Read a saved application with its progress, current and earlier CV and cover-letter drafts and exports.', object({ applicationId: uuid }), true, args => {
    const career = readCareer(store), app = application(career, args.applicationId);
    return { revision: career.revision, application: { ...app, progress: applicationProgress(app) } };
  });
  mutate('career_application_progress_set', 'Record how an application went, without asking: applied right after you submit it yourself and observe the employer’s newly shown confirmation or receipt; applied with the saved date when saved records (progress, facts, notes, form answers) show it was already sent; or any step the user explicitly tells you. Never infer it from time passing, documents, silence or a submit click without an observed confirmation. stage is the next step: applied; interviewing (an invite; again from interviewing adds a round); offer; hired (offer accepted); rejected; withdrawn (the user pulled out or declined the offer). Steps run prepared → applied → interviewing → offer → hired; rejected or withdrawn end it. date is when the step happened (YYYY-MM-DD, default today), not the upcoming interview date. Only date: correct the current step’s date. Save a supplied upcoming interview date as nextInterviewAt (YYYY-MM-DD, future allowed) with interviewing, or alone to schedule/reschedule the current round without adding one; null clears it. Do not ask for confirmation or invent a missing date. Advancing a round or leaving interviewing clears the old schedule. undo: remove the last step.',
    { applicationId: uuid, stage: { enum: PROGRESS_STAGES.slice(1) }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      nextInterviewAt: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, undo: { const: true } },
    ['applicationId'], (career, args) => {
      const app = application(career, args.applicationId);
      return { applicationId: app.id, progress: changeProgress(app, { stage: args.stage, at: args.date, undo: args.undo, nextInterviewAt: args.nextInterviewAt }) };
    });
  mutate('career_applications_delete', 'Delete saved applications and their drafts. Exported files stay on disk.',
    { applicationIds: { type: 'array', items: uuid, minItems: 1, maxItems: 500, uniqueItems: true } }, ['applicationIds'], (career, args) => {
      const missing = args.applicationIds.filter(id => !career.applications[id]);
      if (missing.length) fail('NOT_FOUND', `These applications were not found: ${missing.join(', ')}. List applications and retry with saved IDs.`);
      for (const id of args.applicationIds) delete career.applications[id];
      return { deleted: args.applicationIds.length };
    });
  add('career_application_context', 'Read the current plain master, original CV text, saved facts, full job and writing guide. Complete the master first when MASTER_NOT_READY is returned.',
    object({ applicationId: uuid }), true, args => {
      const career = readCareer(store);
      return context(career, application(career, args.applicationId));
    });

  add('career_application_cv_save', 'Save a plain CV tailored from the current ready master. Supply applicationId, masterVersion, cv and optional presentation. Returns layout and quality notes.',
    object({ ...tailoringBinding, applicationId: uuid, cv: cvSchema, presentation: presentationSchema },
      ['applicationId', 'cv', 'masterVersion']), false, async args => {
      guard(args);
      const career = readCareer(store), app = application(career, args.applicationId);
      const master = assertTailoringContext(career, app, args);
      const mutation = { ...args, requestId: randomUUID(), revision: career.revision };
      if (!validCv(args.cv)) fail('INVALID_INPUT', 'Use the plain structured CV schema.');
      // Gap entries come from the current master and candidate settings, not tailored omissions.
      const { careerGaps: _gaps, ...authored } = args.cv;
      const careerGaps = master.document.careerGaps;
      const stored = careerGaps ? { ...authored, careerGaps: structuredClone(careerGaps) } : authored;
      const document = stored;
      const heading = cvHeading(career.profile);
      const presentation = args.presentation ?? app.cv?.presentation ?? defaultPresentation;
      const layout = await documents.measureCareerCvLayout({ document, heading, presentation });
      const issues = inspectCvQuality({ document, heading }).map(issue => `${issue.field}: ${issue.message}`);
      if (!layout.fits) issues.unshift(`layout: ${layout.error}`);
      return save('career_application_cv_save', mutation, current => {
        const target = application(current, app.id);
        const master = assertTailoringContext(current, target, args);
        const draft = { version: (target.cv?.version ?? 0) + 1, document: structuredClone(stored), presentation: structuredClone(presentation),
          masterVersion: master.version,
          contextFingerprint: applicationContextFingerprint(current, target), createdAt: now() };
        if (target.cv) target.cvHistory.push(target.cv);
        target.cv = draft;
        target.updatedAt = now();
        return { applicationId: target.id, cvVersion: draft.version, layout: { pages: layout.pages ?? null, fits: layout.fits }, issues };
      });
    });
  add('career_application_letter_save', 'Save plain cover-letter paragraphs tailored from the current ready master. Supply applicationId, masterVersion and paragraphs.',
    object({ ...tailoringBinding, applicationId: uuid, paragraphs: strings(12, 1500, 2) }), false, args => {
      const current = readCareer(store);
      return save('career_application_letter_save', { ...args, requestId: randomUUID(), revision: current.revision }, career => {
        const app = application(career, args.applicationId), master = assertTailoringContext(career, app, args);
        if (!validParagraphs(args.paragraphs)) fail('INVALID_INPUT', 'Supply bounded letter paragraphs.');
        const letter = { version: (app.coverLetter?.version ?? 0) + 1, paragraphs: structuredClone(args.paragraphs),
          masterVersion: master.version, contextFingerprint: applicationContextFingerprint(career, app), createdAt: now() };
        if (app.coverLetter) app.coverLetterHistory.push(app.coverLetter);
        app.coverLetter = letter;
        app.updatedAt = now();
        return { applicationId: app.id, letterVersion: letter.version };
      });
    });

  add('career_application_export', 'Export the current CV or cover letter as PDF (default) or TXT. PDF text is read back and checked before the file is written.',
    object({ ...mutationSchema, applicationId: uuid, kind: { enum: ['cv', 'cover_letter'] }, format: { enum: ['pdf', 'txt'] } }, ['requestId', 'revision', 'applicationId', 'kind']), false, async args => {
      guard(args);
      const career = readCareer(store), app = application(career, args.applicationId);
      const master = assertMasterReady(career);
      assertApplicationClarificationsResolved(career, app.id);
      const draft = args.kind === 'cv' ? app.cv : app.coverLetter;
      const replay = replayCareer(store, args, 'career_application_export', args);
      if (replay && replay.export?.masterVersion === master.version &&
          replay.export.contextFingerprint === applicationContextFingerprint(career, app) && replay.export.documentVersion === draft?.version) return replay;
      if (replay) fail('APPLICATION_CONTEXT_CHANGED', 'This export receipt belongs to an earlier document or master. Export the current draft with a new requestId.');
      if (!draft) fail('MISSING_DRAFT', `Save the ${args.kind === 'cv' ? 'CV' : 'cover letter'} before exporting it.`);
      if (draft.masterVersion !== master.version || draft.contextFingerprint !== applicationContextFingerprint(career, app))
        fail('APPLICATION_CONTEXT_CHANGED', 'The job or career evidence changed, or this draft has no job binding. Read career_application_context, rewrite and save a current draft, then export again; no need to ask the candidate.');
      const format = args.format ?? 'pdf';
      let bytes, expectedText, textValidation = null;
      if (args.kind === 'cv') {
        const input = { document: draft.document, heading: cvHeading(career.profile), presentation: draft.presentation };
        expectedText = documents.renderCareerCvText(input);
        if (format === 'pdf') {
          const layout = await documents.measureCareerCvLayout(input);
          if (!layout.fits) fail('LAYOUT_OVERFLOW', layout.error || 'The CV could not be laid out readably at 11pt. Shorten the reported content and save it again.');
          bytes = await documents.renderCareerCvPdf(input);
        }
      } else {
        const job = currentApplicationJob(career, app);
        const title = ['Cover letter', job.title, job.company].filter(Boolean).join(' — ');
        expectedText = [title, ...draft.paragraphs].join('\n\n') + '\n';
        if (format === 'pdf') bytes = await documents.renderCareerPdf(title, draft.paragraphs);
      }
      if (format === 'txt') bytes = Buffer.from(expectedText, 'utf8');
      else {
        try { textValidation = await documents.validateCareerPdfText({ bytes, expectedText, pageNumberFooter: args.kind === 'cover_letter' }); }
        catch { fail('EXPORT_CORRUPT', 'The generated PDF could not be read back. The draft is saved; fix the document rendering before exporting again.'); }
        if (!textValidation.passed) fail('EXPORT_CORRUPT', `The generated PDF did not preserve its text and reading order. Missing text: ${textValidation.missingTokens.slice(0, 12).join(', ') || 'none; reading order or extra text differs'}.`);
      }
      // A concurrent change bumps the revision, so the rendered draft is still current here.
      const result = await withExportTransaction(() => save('career_application_export', args, async current => {
        const target = application(current, app.id);
        assertMasterReady(current);
        if (applicationContextFingerprint(current, target) !== draft.contextFingerprint) fail('APPLICATION_CONTEXT_CHANGED', 'The master or application changed while rendering.');
        const exported = await exportDocument({ applicationId: app.id, kind: args.kind, documentVersion: draft.version, bytes,
          mediaType: format === 'pdf' ? 'application/pdf' : 'text/plain' });
        const record = { ...exported, kind: args.kind, format, documentVersion: draft.version,
          masterVersion: master.version, contextFingerprint: draft.contextFingerprint, textValidation, createdAt: now() };
        target.exports.push(record);
        target.updatedAt = now();
        return { applicationId: target.id, export: record };
      }));
      try { await cleanupExports(); }
      catch { return { ...result, cleanupWarning: 'The current document is saved, but some obsolete generated files could not be removed.' }; }
      return result;
    });

  return tools;
}
