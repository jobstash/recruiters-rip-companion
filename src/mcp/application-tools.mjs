import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PROGRESS_STAGES, applicationProgress, changeProgress } from '../application-progress.mjs';
import { applicationContextFingerprint, assertApplicationClarificationsResolved, pendingApplicationInterviews, originalJobText, currentApplicationJob, isApplicationWritingField, upsertApplication } from '../application-workflow.mjs';
import { readCareer, mutateCareer, replayCareer, mutationSchema, fail } from './state.mjs';
import { assertCleanStatement } from './facts.mjs';
import { cvDocumentTexts, inspectCvQuality, renderableCv, unsupportedNumbers } from './cv-quality.mjs';
import { CV_WRITING_GUIDE } from './cv-writing-policy.mjs';
export { CV_WRITING_GUIDE } from './cv-writing-policy.mjs';
import { currentAssessment } from './matching-tools.mjs';
import { matchingProfileVersion } from './assessment-policy.mjs';
import { policyIdFor, tailoringRequirementsSchema } from './matching-contract.mjs';
import { SKILL_DIGEST } from '../generated/skill-digest.mjs';
import { localJobOriginal } from './job-tools.mjs';
import { formEvidence } from './form-tools.mjs';
import { assertJobNotBlocked, blockFilter } from './blocklist.mjs';
import { careerGapContext } from './career-gap.mjs';
import { assertMasterReady, assertSupport, assertDocumentEvidence, assertPublishableText, cvDocumentSchema, documentEvidenceSchema, supportSchema, presentationSchema, masterEditConstraints,
  sourceSet, sourceSetFingerprint, masterEvidenceFingerprint, cvReviewState } from './master-cv.mjs';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const uuid = { type: 'string', format: 'uuid' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const strings = (maxItems, maxLength, minItems = 0) => ({ type: 'array', items: text(maxLength), maxItems, minItems });
const cvSchema = cvDocumentSchema;
const tailoringBinding = { masterVersion: { type: 'integer', minimum: 1 }, contextFingerprint: text(64), requirements: tailoringRequirementsSchema };
const ajv = new Ajv({ strict: false }); addFormats(ajv);
const validRequirements = ajv.compile(tailoringRequirementsSchema);
const validCv = ajv.compile(cvSchema);
const validEvidence = ajv.compile(documentEvidenceSchema);
const validParagraphs = ajv.compile(strings(12, 1500, 2));
export const CV_POLICY_ID = policyIdFor({ guide: CV_WRITING_GUIDE, schema: cvSchema, evidence: documentEvidenceSchema, requirements: tailoringRequirementsSchema, skill: SKILL_DIGEST });
const jobSchema = object({ title: text(300), company: text(300), description: text(100000), url: text(2000), applyUrl: text(2000), location: text(300) }, ['title', 'company', 'description']);
const pagination = { limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0, maximum: 10000 } };
const defaultPresentation = Object.freeze({ template: 'classic', paper: 'A4' });
const thirdPerson = /\b(?:he|she|they)\s+(?:has|have|led|built|managed|delivered|worked)\b|\bthe candidate\b/i;
const factEvidence = fact => [fact.subject, fact.answer, fact.detail ?? ''];
// ISO dates ("2018-03") support prose that names the year alone.
const withYears = texts => [...texts, ...texts.flatMap(value => value.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
const now = () => new Date().toISOString();

function application(career, id) {
  const app = career.applications[id];
  if (!app) fail('NOT_FOUND', 'This application was not found. List local applications and choose its ID.');
  assertJobNotBlocked(career, app.job.id, app.job);
  return app;
}
/** The saved CV text (non-archived purpose 'cv' sources) is the base career record. */
function cvRecord(career) {
  return Object.values(career.sources).filter(source => !source.archived && source.purpose === 'cv' && source.text?.trim())
    .map(source => source.text).join('\n\n');
}
/** The CV header always comes from the current profile, never the draft. */
export function cvHeading(profile) {
  const contact = [...new Set([profile.email, profile.phone, profile.location, profile.linkedinUrl, ...(profile.links ?? [])])]
    .filter(value => typeof value === 'string' && value.trim()).join(' · ');
  return { ...(profile.name?.trim() ? { name: profile.name.trim() } : {}), ...(contact ? { contact } : {}) };
}
function assertVoice(items) {
  for (const { field, text } of items) {
    assertCleanStatement(text, field);
    const match = text.match(thirdPerson);
    if (match) fail('CV_TONE', `${field}: write in implied first person ("Led …"), not third-person narration ("${match[0]}").`);
  }
}
/** Numbers outside cited claims may only repeat values present in the saved CV, facts or profile. */
function assertNumbers(career, items) {
  const corpus = [cvRecord(career), ...Object.values(career.facts).flatMap(factEvidence)];
  const collect = value => {
    if (typeof value === 'string') corpus.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  const { preferences, ...profile } = career.profile;
  collect(profile);
  const supporting = withYears(corpus);
  const problems = items.flatMap(({ field, text }) => {
    const unsupported = unsupportedNumbers(text, supporting);
    return unsupported.length ? [`${field}: ${unsupported.join(', ')}`] : [];
  });
  if (problems.length) fail('UNSUPPORTED_NUMBER', `Leave out numbers that are not in the saved CV, facts or profile (never invent metrics): ${problems.join('; ')}.`);
}
/** Exact advert wording is classification input, never evidence for a candidate claim. */
export function assertTailoringRequirements(career, job, requirements) {
  if (!validRequirements(requirements)) fail('INVALID_REQUIREMENTS', 'Provide the complete exact-phrase requirement inventory using the tailoring requirements schema.');
  if (!job.description?.trim() || job.complete === false) fail('FULL_AD_REQUIRED', 'Read and save the complete original advert before tailoring.');
  const jobText = originalJobText(job.description);
  const ids = new Set(), phrases = new Set();
  for (const requirement of requirements) {
    const { id, phrase, status, support, roleIds } = requirement;
    if (ids.has(id) || phrases.has(phrase)) fail('INVALID_REQUIREMENTS', 'Requirement IDs and exact phrases must be unique.');
    ids.add(id); phrases.add(phrase);
    if (!jobText.includes(phrase)) fail('UNKNOWN_JOB_PHRASE', `Requirement "${phrase}" is not an exact substring of context.jobText (the complete original advert text).`);
    if (status === 'missing') {
      if (support || roleIds.length) fail('UNSUPPORTED_REQUIREMENT', 'Missing requirements must not claim supporting evidence or roles.');
      continue;
    }
    assertSupport(career, support, { field: `requirements[${id}]` });
    if (['experience', 'outcome'].includes(requirement.kind) && !roleIds.length)
      fail('MISATTRIBUTED_FACT', 'Experience and outcome requirements need the exact supporting roleIds.');
    for (const roleId of roleIds) {
      if (!career.roles?.[roleId]) fail('UNKNOWN_ROLE', 'Cite stable role IDs from the current master context.');
      const scoped = {
        sources: (support.sources ?? []).filter(ref => career.roles[roleId].sourceRefs.some(bound =>
          bound.sourceId === ref.sourceId && bound.contentHash === ref.contentHash && bound.quote.includes(ref.quote))),
        facts: (support.facts ?? []).filter(id => career.facts[id]?.roleId === roleId),
      };
      if (!scoped.sources.length) delete scoped.sources;
      if (!scoped.facts.length) delete scoped.facts;
      if (!scoped.sources && !scoped.facts) fail('MISATTRIBUTED_FACT', 'This requirement has no evidence belonging to the cited role.');
      assertSupport(career, scoped, { roleId, field: `requirements[${id}]` });
    }
    if (roleIds.length) for (const ref of support.sources ?? []) {
      if (!roleIds.some(roleId => career.roles[roleId].sourceRefs.some(bound =>
        bound.sourceId === ref.sourceId && bound.contentHash === ref.contentHash && bound.quote.includes(ref.quote))))
        fail('MISATTRIBUTED_SOURCE', 'Every requirement source quote must belong to a cited role.');
    }
    for (const factId of support.facts ?? []) {
      const roleId = career.facts[factId]?.roleId;
      if (roleId && !roleIds.includes(roleId)) fail('MISATTRIBUTED_FACT', 'List the owning role of each requirement fact.');
    }
  }
}
function assertRequirementPhrases(document, evidence, requirements) {
  const overlaps = (left, right) => (left.facts ?? []).some(id => right.facts?.includes(id)) ||
    (left.sources ?? []).some(ref => right.sources?.some(other => ref.sourceId === other.sourceId && ref.contentHash === other.contentHash &&
      (ref.quote.includes(other.quote) || other.quote.includes(ref.quote))));
  for (const requirement of requirements.filter(item => item.status === 'supported')) {
    const claims = [...(document.highlights ?? []), ...document.experience.filter(entry => !requirement.roleIds.length || requirement.roleIds.includes(entry.roleId)).flatMap(entry => entry.bullets)];
    const inClaim = claims.some(claim => claim.text.includes(requirement.phrase) && overlaps(claim.support, requirement.support));
    const inSkills = (document.skills ?? []).some(group => group.items.some(item => item.includes(requirement.phrase))) && overlaps(evidence.sections, requirement.support);
    if (!inClaim && !inSkills) fail('JOB_PHRASE_MISSING', `Preserve supported job phrase "${requirement.phrase}" exactly in an evidenced relevant skill or achievement, without changing its case or internal whitespace.`);
  }
}
function assertTailoringContext(career, app, args) {
  const master = assertMasterReady(career);
  if (args.masterVersion !== master.version || args.contextFingerprint !== applicationContextFingerprint(career, app))
    fail('APPLICATION_CONTEXT_CHANGED', 'Read career_application_context and tailor a copy of its current master version.');
  assertTailoringRequirements(career, currentApplicationJob(career, app), args.requirements);
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
    ? (({ overall, band, decision, gates, dimensions, requirements, reason }) => ({ overall, band, decision, gates, dimensions, requirements, reason }))(row) : null;
  const fingerprint = applicationContextFingerprint(career, app), evidence = formEvidence(career), careerGap = careerGapContext(career);
  const forms = Object.values(career.formDrafts ?? {}).filter(draft => draft.applicationId === app.id)
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
    .map(draft => ({ formId: draft.formId, snapshot: draft.snapshot, evidenceRevision: draft.evidenceRevision,
      url: draft.url, title: draft.title, fields: draft.fields, writingFields: draft.fields.filter(isApplicationWritingField), actions: draft.actions ?? [],
      contextCurrent: draft.applicationContext === fingerprint && draft.evidence === evidence,
      instructions: 'Read career_form_read with formId to check Chrome attachment and current answers before staging. If contextCurrent is false, read/prepare the page again in Chrome first. Answer every empty field the evidence supports: prose for writingFields, an exact option value for choices; leave the rest unanswered and never overwrite populated fields.' }));
  return { revision: career.revision, application: app, job: currentApplicationJob(career, app),
    contextFingerprint: fingerprint, forms,
    jobText: originalJobText(currentApplicationJob(career, app).description), masterEditConstraints: masterEditConstraints(career),
    profile: { name, email, phone, location, links, linkedinUrl, headline, seniority, roleCapabilities, skills }, preferences,
    master: structuredClone(master), sourceSetFingerprint: sourceSetFingerprint(career), masterEvidenceFingerprint: masterEvidenceFingerprint(career),
    review: cvReviewState(career), roles: Object.values(career.roles ?? {}),
    originalSources: sourceSet(career).map(ref => ({ ...ref, text: career.sources[ref.sourceId].text })),
    pendingInterviews: pendingApplicationInterviews(career, app.id),
    facts, assessment, requirements: app.cv?.contextFingerprint === fingerprint ? app.cv.requirements : null,
    requirementsSchema: tailoringRequirementsSchema, ...(careerGap ? { careerGap } : {}),
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
  add('career_application_context', 'Read the current ready immutable master, complete original job, original CV sources separate from master prose, stable roles, facts, source/review fingerprints, exact-phrase tailoring requirements schema, contact details and writing guide. Complete the source review and master first when MASTER_NOT_READY is returned.',
    object({ applicationId: uuid }), true, args => {
      const career = readCareer(store);
      return context(career, application(career, args.applicationId));
    });

  add('career_application_cv_save', 'Tailor an immutable copy of the current ready master. Supply masterVersion, contextFingerprint, exact original-advert requirements and evidence for headline, summary and other sections. Claims require id/text/support and experience requires roleId. Original source refs and role-scoped facts—not master prose—support claims. Returns layout and quality notes.',
    object({ ...mutationSchema, ...tailoringBinding, applicationId: uuid, cv: cvSchema, evidence: documentEvidenceSchema, presentation: presentationSchema },
      ['requestId', 'revision', 'applicationId', 'cv', 'evidence', ...Object.keys(tailoringBinding)]), false, async args => {
      guard(args);
      const career = readCareer(store), app = application(career, args.applicationId);
      const master = assertTailoringContext(career, app, args);
      const replay = replayCareer(store, args, 'career_application_cv_save', args);
      if (replay) return replay;
      if (!validCv(args.cv) || !validEvidence(args.evidence)) fail('INVALID_INPUT', 'Use the structured CV and document evidence schemas.');
      // Gap entries are an immutable projection of the candidate's settings and complete canonical career, never tailored omissions.
      const { careerGaps: _gaps, ...authored } = args.cv;
      const careerGaps = master.document.careerGaps;
      const stored = careerGaps ? { ...authored, careerGaps: structuredClone(careerGaps) } : authored;
      const document = renderableCv(stored), items = cvDocumentTexts(document).filter(item => !item.setting);
      assertVoice(items);
      assertDocumentEvidence(career, stored, args.evidence);
      assertRequirementPhrases(stored, args.evidence, args.requirements);
      assertNumbers(career, items.filter(item => !item.date && !item.claim));
      const heading = cvHeading(career.profile);
      assertPublishableText(career, Object.values(heading), 'CV contact');
      const presentation = args.presentation ?? app.cv?.presentation ?? defaultPresentation;
      const layout = await documents.measureCareerCvLayout({ document, heading, presentation });
      const issues = inspectCvQuality({ document, heading }).map(issue => `${issue.field}: ${issue.message}`);
      if (!layout.fits) issues.unshift(`layout: ${layout.error}`);
      return save('career_application_cv_save', args, current => {
        const target = application(current, app.id);
        const master = assertTailoringContext(current, target, args);
        const draft = { version: (target.cv?.version ?? 0) + 1, document: stored, presentation, policyId: CV_POLICY_ID,
          masterVersion: master.version, requirements: structuredClone(args.requirements), evidence: structuredClone(args.evidence),
          contextFingerprint: applicationContextFingerprint(current, target), createdAt: now() };
        if (target.cv) target.cvHistory.push(target.cv);
        target.cv = draft;
        target.updatedAt = now();
        return { applicationId: target.id, cvVersion: draft.version, layout: { pages: layout.pages ?? null, fits: layout.fits }, issues };
      });
    });
  mutate('career_application_letter_save', 'Save evidence-backed cover-letter paragraphs tailored from the ready immutable master. Supply the current masterVersion/contextFingerprint, exact original-advert requirements and one Support per paragraph.',
    { ...tailoringBinding, applicationId: uuid, paragraphs: strings(12, 1500, 2), evidence: { type: 'array', items: supportSchema, minItems: 2, maxItems: 12 } },
    ['applicationId', 'paragraphs', 'evidence', ...Object.keys(tailoringBinding)], (career, args) => {
      const app = application(career, args.applicationId), master = assertTailoringContext(career, app, args);
      if (!validParagraphs(args.paragraphs) || !Array.isArray(args.evidence) || args.evidence.length !== args.paragraphs.length)
        fail('INVALID_INPUT', 'Supply bounded letter paragraphs and one evidence Support per paragraph.');
      args.paragraphs.forEach((text, index) => assertSupport(career, args.evidence[index], { text, field: `paragraphs[${index}]` }));
      const items = args.paragraphs.map((text, index) => ({ field: `paragraphs[${index}]`, text }));
      assertVoice(items);
      assertNumbers(career, items);
      const letter = { version: (app.coverLetter?.version ?? 0) + 1, paragraphs: args.paragraphs,
        masterVersion: master.version, requirements: structuredClone(args.requirements), evidence: structuredClone(args.evidence),
        contextFingerprint: applicationContextFingerprint(career, app), createdAt: now() };
      if (app.coverLetter) app.coverLetterHistory.push(app.coverLetter);
      app.coverLetter = letter;
      app.updatedAt = now();
      return { applicationId: app.id, letterVersion: letter.version };
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
      assertTailoringRequirements(career, currentApplicationJob(career, app), draft.requirements);
      if (args.kind === 'cv') {
        assertDocumentEvidence(career, draft.document, draft.evidence);
        assertRequirementPhrases(draft.document, draft.evidence, draft.requirements);
      }
      else draft.paragraphs.forEach((text, index) => assertSupport(career, draft.evidence?.[index], { text, field: `paragraphs[${index}]` }));
      const format = args.format ?? 'pdf';
      let bytes, expectedText, textValidation = null;
      if (args.kind === 'cv') {
        const input = { document: renderableCv(draft.document), heading: cvHeading(career.profile), presentation: draft.presentation };
        assertPublishableText(career, Object.values(input.heading), 'CV contact');
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
