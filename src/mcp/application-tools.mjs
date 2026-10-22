import { applicationContextFingerprint, currentApplicationJob, isApplicationWritingField, upsertApplication } from '../application-workflow.mjs';
import { readCareer, mutateCareer, replayCareer, mutationSchema, fail } from './state.mjs';
import { assertCleanStatement } from './facts.mjs';
import { cvDocumentTexts, inspectCvQuality, renderableCv, unsupportedNumbers } from './cv-quality.mjs';
import { currentAssessment, normalizeQuote } from './matching-tools.mjs';
import { matchingProfileVersion } from './assessment-policy.mjs';
import { policyIdFor } from './matching-contract.mjs';
import { SKILL_DIGEST } from '../generated/skill-digest.mjs';
import { localJobOriginal } from './job-tools.mjs';
import { formEvidence } from './form-tools.mjs';

export const CV_WRITING_GUIDE = [
  'Write to win the interview. The saved CV is the base career record: employers, roles, dates and achievements come from it. Facts are what the candidate has told you since; use them to tailor truthfully.',
  'Match the saved CV against jobs first; do not require an interview or collect general facts before initial matching. Only while reviewing a specific listing for submission, compare its must-haves with the CV and full facts: original question, context, answer, detail and exchanges. For material gaps, call career_interview_ask with this saved applicationId (usually 1–3 questions, at most 5). Use host reasoning, not keyword overlap, to reuse a related fact with factId. Never ask optional questionnaires or re-question known negative answers.',
  'Fast choices route the interview; the useful material is one short, specific explanation of the project, personal contribution and result. If a positive answer is shallow, present the pending follow-up returned by career_interview_ask or career_interview_answer rather than stopping at saved. For an existing explanation that lacks material specificity, use factId with one targeted followUp; do not repeat the level question or demand an essay. Preserve the actual original question/context and prior exchanges, never invent historical questions.',
  'Fact answers: "Led it" supports leadership, not personal implementation or concrete achievements; "Hands-on" supports personal work, not invented outcomes; "Some exposure" supports familiarity only; "None" or "No" is sufficient and must not be re-questioned or claimed as capability. Use actual detail and follow-up answers for concrete examples, never fabricate metrics. Languages: use a saved level or one the CV states, never infer a level from a mere mention.',
  'New explanations must inform subsequent evaluation of relevant roles: they may raise or lower a score or resolve eligibility, never earn an automatic adjustment. Fact changes invalidate old ranking context via profileVersion. Do not rescore in the background merely because an answer was collected; when needed, reassess affected roles against current evidence, and perform full reevaluation when requested. Do not force score changes for irrelevant evidence or merely relabel old judgments.',
  'Aim the headline at the target role. Write a 2–4 sentence summary connecting the candidate’s strongest relevant scope to the employer’s needs. List experience in reverse-chronological order with 3–6 outcome-first bullets for recent relevant roles; condense older roles or move them to an "Earlier experience" additional section. Use the advert’s terminology where it truthfully describes the candidate. Plan before writing: use context.assessment.requirements (or, without one, the advert’s essential requirements) to choose the strongest evidence per requirement. Every highlight and experience bullet is {text, support}: support.cv holds verbatim CV quotes, support.facts holds saved fact IDs. Write only what the cited evidence supports: shorten, combine or adopt the advert’s truthful terminology, but never move a metric to another role, turn leadership into hands-on work, turn exposure into expertise or make an unknown positive. When no outcome is evidenced, state the supported responsibility plainly instead of inventing a metric. Group skills and put the most relevant first. Keep headings plain and ATS-safe. Use implied first person ("Led …"), never "I" and never third-person narration.',
  'Cover letter: 220–380 words, specific to the company’s problem, no generic enthusiasm. Never invent employers, titles, dates, credentials or metrics. Do not ask the user to approve wording.',
].join('\n');

const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const uuid = { type: 'string', format: 'uuid' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const strings = (maxItems, maxLength, minItems = 0) => ({ type: 'array', items: text(maxLength), maxItems, minItems });
const presentationSchema = object({ template: { enum: ['classic', 'modern'] }, paper: { enum: ['A4', 'LETTER'] } });
const support = { ...object({ cv: strings(3, 300, 1), facts: { type: 'array', items: uuid, minItems: 1, maxItems: 5, uniqueItems: true } }, []), minProperties: 1 };
const claim = maxLength => object({ text: text(maxLength), support });
const cvSchema = object({
  headline: text(200), summary: text(1200), highlights: { type: 'array', items: claim(300), maxItems: 6 },
  experience: { type: 'array', minItems: 1, maxItems: 30, items: object({
    employer: text(300), role: text(300), location: text(300), startDate: text(40), endDate: text(40),
    bullets: { type: 'array', items: claim(400), minItems: 1, maxItems: 10 },
  }, ['employer', 'role', 'startDate', 'endDate', 'bullets']) },
  education: { type: 'array', maxItems: 20, items: object({
    institution: text(300), qualification: text(300), startDate: text(40), endDate: text(40), details: text(1000),
  }, ['institution']) },
  skills: { type: 'array', maxItems: 10, items: object({ label: text(100), items: strings(40, 100, 1) }) },
  languages: { type: 'array', maxItems: 20, items: object({ language: text(100), proficiency: { enum: ['native', 'fluent', 'professional', 'conversational', 'basic'] } }) },
  certifications: strings(30, 300),
  additional: { type: 'array', maxItems: 6, items: object({ title: text(100), items: strings(20, 400, 1) }) },
}, ['headline', 'summary', 'experience']);
export const CV_POLICY_ID = policyIdFor({ guide: CV_WRITING_GUIDE, schema: cvSchema, skill: SKILL_DIGEST });
const jobSchema = object({ title: text(300), company: text(300), description: text(100000), url: text(2000), applyUrl: text(2000), location: text(300) }, ['title', 'company', 'description']);
const pagination = { limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0, maximum: 10000 } };
const defaultPresentation = Object.freeze({ template: 'classic', paper: 'A4' });
const thirdPerson = /\b(?:he|she|they)\s+(?:has|have|led|built|managed|delivered|worked)\b|\bthe candidate\b/i;
const employerKey = value => value.normalize('NFKD').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, '');
const factEvidence = fact => [fact.subject, fact.answer, fact.detail ?? '', ...(fact.followUps ?? []).map(exchange => exchange.answer)];
// ISO dates ("2018-03") support prose that names the year alone.
const withYears = texts => [...texts, ...texts.flatMap(value => value.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
const now = () => new Date().toISOString();

function application(career, id) {
  const app = career.applications[id];
  if (!app) fail('NOT_FOUND', 'This application was not found. List local applications and choose its ID.');
  return app;
}
/** The saved CV text (non-archived purpose 'cv' sources) is the base career record. */
function cvRecord(career) {
  return Object.values(career.sources).filter(source => !source.archived && source.purpose === 'cv' && source.text?.trim())
    .map(source => source.text).join('\n\n');
}
/** The CV header always comes from the current profile, never the draft. */
export function cvHeading(profile) {
  const contact = [profile.email, profile.phone, profile.location, ...(profile.links ?? [])]
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
function assertKnownEmployers(career, document) {
  const known = [cvRecord(career), ...Object.values(career.facts).map(fact => fact.employer ?? '')].map(employerKey);
  document.experience.forEach((entry, index) => {
    const key = employerKey(entry.employer);
    if (!key || !known.some(record => record.includes(key))) fail('UNKNOWN_EMPLOYER', `experience[${index}].employer "${entry.employer}" appears neither in the saved CV nor as a fact's employer. Use the employer as the CV writes it; if the candidate stated a role the CV lacks, save a fact with that employer first.`);
  });
}
/** Every highlight and experience bullet cites verbatim CV quotes or saved facts, and its numbers come from that evidence alone. */
function assertClaimSupport(career, document) {
  const cv = normalizeQuote(cvRecord(career));
  const claims = [...(document.highlights ?? []).map((claim, index) => ({ field: `highlights[${index}]`, claim })),
    ...document.experience.flatMap((entry, index) => entry.bullets.map((claim, bullet) => ({ field: `experience[${index}].bullets[${bullet}]`, claim, entry })))];
  for (const { field, claim, entry } of claims) {
    const quotes = claim.support.cv ?? [];
    for (const quote of quotes) {
      const normalized = normalizeQuote(quote);
      if (!normalized || !cv.includes(normalized)) fail('UNKNOWN_QUOTE', `${field}: this quote is not in the saved CV: "${quote.slice(0, 80)}". Quote the CV verbatim.`);
    }
    const facts = (claim.support.facts ?? []).map(id => career.facts[id]
      ?? fail('UNKNOWN_FACT', `${field}: fact ${id} is not saved. Cite fact IDs from career_application_context.`));
    if (entry) for (const fact of facts) {
      const owner = employerKey(fact.employer ?? ''), employer = employerKey(entry.employer);
      if (owner && !owner.includes(employer) && !employer.includes(owner))
        fail('MISATTRIBUTED_FACT', `${field}: fact "${fact.subject}" belongs to ${fact.employer.trim()}, not ${entry.employer}.`);
    }
    const unsupported = unsupportedNumbers(claim.text, withYears([...quotes, ...facts.flatMap(factEvidence)]));
    if (unsupported.length) fail('UNSUPPORTED_NUMBER', `${field}: ${unsupported.join(', ')} must appear in the cited evidence, not elsewhere in the CV.`);
  }
}
function catalogueJob(job, jobId) {
  const company = typeof job?.company === 'string' ? job.company : job?.company?.name;
  if (!job || ![job.id, job.shortUUID].includes(jobId) || !job.title?.trim() || !company?.trim() || !job.description?.trim())
    fail('INVALID_JOB', 'The catalogue did not return a complete matching job. Read the job again, or paste the advert as job.');
  const url = job.applyUrl ?? job.url;
  return { id: job.id, title: job.title, company, description: job.description,
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
    exports: app.exports.length, createdAt: app.createdAt, updatedAt: app.updatedAt };
}
function context(career, app) {
  const { name, email, phone, location, links, headline, seniority, roleCapabilities, skills, preferences = {} } = career.profile;
  const facts = {};
  for (const fact of Object.values(career.facts).sort((a, b) => a.subject.localeCompare(b.subject, 'en', { sensitivity: 'base' })))
    (facts[fact.kind] ??= []).push(fact);
  const row = app.job.id ? career.matching?.scores?.[app.job.id] : undefined;
  const assessment = row && currentAssessment(row, matchingProfileVersion(career))
    ? (({ overall, band, decision, gates, dimensions, requirements, reason }) => ({ overall, band, decision, gates, dimensions, requirements, reason }))(row) : null;
  const fingerprint = applicationContextFingerprint(career, app), evidence = formEvidence(career);
  const forms = Object.values(career.formDrafts ?? {}).filter(draft => draft.applicationId === app.id)
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
    .map(draft => ({ formId: draft.formId, snapshot: draft.snapshot, evidenceRevision: draft.evidenceRevision,
      url: draft.url, title: draft.title, fields: draft.fields, writingFields: draft.fields.filter(isApplicationWritingField), actions: draft.actions ?? [],
      contextCurrent: draft.applicationContext === fingerprint && draft.evidence === evidence,
      instructions: 'Read career_form_read with formId to check Chrome attachment and current answers before staging. If contextCurrent is false, read/prepare the page again in Chrome first. Only empty supported writing fields need prose; do not overwrite populated fields.' }));
  return { revision: career.revision, application: app, job: currentApplicationJob(career, app),
    contextFingerprint: fingerprint, forms,
    profile: { name, email, phone, location, links, headline, seniority, roleCapabilities, skills }, preferences,
    cv: cvRecord(career), facts, assessment,
    presentation: {
      templates: [{ id: 'classic', description: 'Serif text with ruled section headings.' }, { id: 'modern', description: 'Sans-serif text in a single column.' }],
      papers: ['A4', 'LETTER'], fontSize: 11, current: app.cv?.presentation ?? defaultPresentation,
    },
    guide: CV_WRITING_GUIDE };
}

export function createApplicationTools({ store, platform, documents, exportDocument }) {
  const tools = [];
  const add = (name, description, inputSchema, readOnly, invoke) => tools.push({ name, description, inputSchema, readOnly, invoke });
  const mutate = (name, description, properties, required, change) => add(name, description,
    object({ ...mutationSchema, ...properties }, ['requestId', 'revision', ...required]), false,
    args => mutateCareer(store, args, name, args, career => change(career, args)));

  add('career_job_read', 'Read a complete catalogue job or a local capture (including listing text marked complete:false).', object({ id: text(100) }), true, args =>
    typeof args.id === 'string' && args.id.startsWith('local:') ? localJobOriginal(readCareer(store), args.id) : platform('job_read', args));
  add('career_application_create', 'Create or reuse the application for the exact catalogue or complete locally captured job (jobId), or full pasted advert (job, with exact url and optional applyUrl). Never match by title/company alone. A changed original invalidates old document fingerprints. Read career_application_context and reuse current documents; save and export new drafts only when missing or stale.',
    object({ ...mutationSchema, jobId: text(100), job: jobSchema }, ['requestId', 'revision']), false, async args => {
      if ((args.jobId === undefined) === (args.job === undefined)) fail('INVALID_INPUT', 'Provide either jobId for a catalogue job or job for a pasted advert.');
      const replay = replayCareer(store, args, 'career_application_create', args);
      if (replay) return replay;
      let job = args.job;
      if (args.jobId !== undefined) job = typeof args.jobId === 'string' && args.jobId.startsWith('local:')
        ? capturedApplicationJob(readCareer(store), args.jobId)
        : catalogueJob(await platform('job_read', { id: args.jobId }), args.jobId);
      return mutateCareer(store, args, 'career_application_create', args, career => {
        const app = upsertApplication(career, job);
        return { applicationId: app.id, job: app.job };
      });
    });
  add('career_applications_list', 'List saved applications, most recently updated first.', object(pagination, []), true, args => {
    const career = readCareer(store), offset = args.offset ?? 0, limit = args.limit ?? 20;
    const apps = Object.values(career.applications).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { revision: career.revision, applications: apps.slice(offset, offset + limit).map(summary), total: apps.length,
      nextOffset: offset + limit < apps.length ? offset + limit : null };
  });
  add('career_application_read', 'Read a saved application with its current and earlier CV and cover-letter drafts and exports.', object({ applicationId: uuid }), true, args => {
    const career = readCareer(store);
    return { revision: career.revision, application: application(career, args.applicationId) };
  });
  mutate('career_applications_delete', 'Delete saved applications and their drafts. Exported files stay on disk.',
    { applicationIds: { type: 'array', items: uuid, minItems: 1, maxItems: 500, uniqueItems: true } }, ['applicationIds'], (career, args) => {
      const missing = args.applicationIds.filter(id => !career.applications[id]);
      if (missing.length) fail('NOT_FOUND', `These applications were not found: ${missing.join(', ')}. List applications and retry with saved IDs.`);
      for (const id of args.applicationIds) delete career.applications[id];
      return { deleted: args.applicationIds.length };
    });
  add('career_application_context', 'Everything needed to tailor the CV and cover letter: the job, profile, preferences, the saved CV text (the career record), known facts grouped by kind, the current saved match assessment of a catalogue job (or null), presentation options and the writing guide. Ask about job must-haves the CV and facts do not cover with career_interview_ask before writing.',
    object({ applicationId: uuid }), true, args => {
      const career = readCareer(store);
      return context(career, application(career, args.applicationId));
    });

  add('career_application_cv_save', 'Save the tailored CV as a structured document. Every highlight and experience bullet is {text, support}: support.cv quotes the saved CV verbatim, support.facts cites saved fact IDs, and the claim\'s numbers must appear in that cited evidence. Employers must appear in the saved CV or as a fact\'s employer; other numbers must come from the CV, facts or profile. Returns layout and non-blocking quality notes to fix silently.',
    object({ ...mutationSchema, applicationId: uuid, cv: cvSchema, presentation: presentationSchema }, ['requestId', 'revision', 'applicationId', 'cv']), false, async args => {
      const replay = replayCareer(store, args, 'career_application_cv_save', args);
      if (replay) return replay;
      const career = readCareer(store), app = application(career, args.applicationId);
      const document = renderableCv(args.cv), items = cvDocumentTexts(document);
      assertVoice(items);
      assertKnownEmployers(career, args.cv);
      assertClaimSupport(career, args.cv);
      assertNumbers(career, items.filter(item => !item.date && !item.claim));
      const heading = cvHeading(career.profile);
      const presentation = args.presentation ?? app.cv?.presentation ?? defaultPresentation;
      const layout = await documents.measureCareerCvLayout({ document, heading, presentation });
      const issues = inspectCvQuality({ document, heading }).map(issue => `${issue.field}: ${issue.message}`);
      if (!layout.fits) issues.unshift(`layout: ${layout.error}`);
      return mutateCareer(store, args, 'career_application_cv_save', args, current => {
        const target = application(current, app.id);
        const draft = { version: (target.cv?.version ?? 0) + 1, document: args.cv, presentation, policyId: CV_POLICY_ID,
          contextFingerprint: applicationContextFingerprint(current, target), createdAt: now() };
        if (target.cv) target.cvHistory.push(target.cv);
        target.cv = draft;
        target.updatedAt = now();
        return { applicationId: target.id, cvVersion: draft.version, layout: { pages: layout.pages ?? null, fits: layout.fits }, issues };
      });
    });
  mutate('career_application_letter_save', 'Save the tailored cover letter as ordered paragraphs (salutation and sign-off included). Numbers must come from the CV, facts or profile.',
    { applicationId: uuid, paragraphs: strings(12, 1500, 2) }, ['applicationId', 'paragraphs'], (career, args) => {
      const app = application(career, args.applicationId);
      const items = args.paragraphs.map((text, index) => ({ field: `paragraphs[${index}]`, text }));
      assertVoice(items);
      assertNumbers(career, items);
      const letter = { version: (app.coverLetter?.version ?? 0) + 1, paragraphs: args.paragraphs,
        contextFingerprint: applicationContextFingerprint(career, app), createdAt: now() };
      if (app.coverLetter) app.coverLetterHistory.push(app.coverLetter);
      app.coverLetter = letter;
      app.updatedAt = now();
      return { applicationId: app.id, letterVersion: letter.version };
    });

  add('career_application_export', 'Export the current CV or cover letter as PDF (default) or TXT. PDF text is read back and checked before the file is written.',
    object({ ...mutationSchema, applicationId: uuid, kind: { enum: ['cv', 'cover_letter'] }, format: { enum: ['pdf', 'txt'] } }, ['requestId', 'revision', 'applicationId', 'kind']), false, async args => {
      const replay = replayCareer(store, args, 'career_application_export', args);
      if (replay) return replay;
      const career = readCareer(store), app = application(career, args.applicationId);
      const draft = args.kind === 'cv' ? app.cv : app.coverLetter;
      if (!draft) fail('MISSING_DRAFT', `Save the ${args.kind === 'cv' ? 'CV' : 'cover letter'} before exporting it.`);
      if (draft.contextFingerprint !== applicationContextFingerprint(career, app))
        fail('APPLICATION_CONTEXT_CHANGED', 'The job or career evidence changed, or this draft has no job binding. Read the application context and save a current draft before exporting.');
      const format = args.format ?? 'pdf';
      let bytes, expectedText, textValidation = null;
      if (args.kind === 'cv') {
        const input = { document: renderableCv(draft.document), heading: cvHeading(career.profile), presentation: draft.presentation };
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
      return mutateCareer(store, args, 'career_application_export', args, async current => {
        const target = application(current, app.id);
        const exported = await exportDocument({ applicationId: app.id, kind: args.kind, bytes,
          filename: `${args.kind}-${app.id}-v${draft.version}.${format}`, mediaType: format === 'pdf' ? 'application/pdf' : 'text/plain' });
        const record = { ...exported, kind: args.kind, format, documentVersion: draft.version,
          contextFingerprint: draft.contextFingerprint, textValidation, createdAt: now() };
        target.exports.push(record);
        target.updatedAt = now();
        return { applicationId: target.id, export: record };
      });
    });

  return tools;
}
