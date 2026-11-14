import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCareerState, hash } from '../src/mcp/state.mjs';
import { assertDocumentEvidence, assertMasterReady, assertPublishableText, assertSupport, createMasterCvTools, cvReviewState, masterCareerGaps, masterCvState, masterEditConstraints, masterExportSnapshot, masterHeading, renderMaster, saveManualMaster, sourceSetFingerprint, validateMasterCareer } from '../src/mcp/master-cv.mjs';

const presentation = { template: 'classic', paper: 'A4' };
const facets = ['outcomes', 'growth', 'complex_scenario'];
async function fixture({ ready = true, noRoles = false } = {}) {
  let state = { deviceId: randomUUID(), career: createCareerState() }, queue = Promise.resolve();
  Object.assign(state.career.profile, { name: 'Alex Example', email: 'alex@example.test', phone: '+44 000 1234', location: 'London', linkedinUrl: 'https://linkedin.com/in/alex-example', links: ['https://example.test/alex'] });
  const descriptions = noRoles ? ['Alex Example\nExample University | BSc Computing | 2025\nBuilt an accessible reading project.'] : [
    'Example Labs | Engineer | 2018 | 2020\nReduced release time by 40%. Took ownership of release automation. Recovered a failed migration by validating backups and restoring service.',
    'Example Labs | Engineering Manager | 2021 | Present\nLed a team of 12 engineers. Expanded ownership to delivery planning. Resolved a delayed launch by narrowing scope and delivering the critical service.',
  ];
  const refs = descriptions.map(text => {
    const id = randomUUID();
    state.career.sources[id] = { id, name: 'Synthetic original CV', purpose: 'cv', mediaType: 'text/plain', text, contentHash: hash(text), createdAt: '2026-01-01T00:00:00.000Z' };
    return { sourceId: id, contentHash: hash(text), quote: text };
  });
  const roles = noRoles ? [] : refs.map((ref, index) => ({ id: randomUUID(), employer: 'Example Labs', title: index ? 'Engineering Manager' : 'Engineer', startDate: index ? '2021' : '2018', endDate: index ? 'Present' : '2020', sourceRefs: [ref] }));
  const store = { get: () => structuredClone(state), update(change) {
    const action = queue.then(async () => { const next = structuredClone(state); await change(next); state = next; });
    queue = action.catch(() => {}); return action;
  } };
  const tools = new Map(createMasterCvTools({ store, identity: () => state.deviceId }).map(tool => [tool.name, tool]));
  const mutation = fields => ({ requestId: randomUUID(), revision: state.career.revision, ...fields });
  const call = (name, args = {}) => tools.get(`career_${name}`).invoke(args);
  const reviewArgs = (complete = true) => mutation({ sourceSetFingerprint: sourceSetFingerprint(state.career), reviewedSourceIds: Object.keys(state.career.sources).filter(id => !state.career.sources[id].archived), roles, review: roles.map(role => ({ roleId: role.id, ...Object.fromEntries(facets.map(facet => [facet, complete ? { status: 'answered', support: { sources: role.sourceRefs } } : { status: 'unreviewed' }])) })), complete });
  const support = { sources: refs };
  const document = { headline: noRoles ? 'Computing graduate' : 'Engineering leader', summary: noRoles ? 'Computing graduate building accessible reading tools.' : 'Engineering leader who improves delivery and develops teams.', experience: roles.map((role, index) => ({ roleId: role.id, employer: role.employer, role: role.title, startDate: role.startDate, endDate: role.endDate, bullets: [{ id: randomUUID(), text: index ? 'Led a team of 12 engineers.' : 'Reduced release time by 40%.', support: { sources: role.sourceRefs } }] })), ...(noRoles ? { education: [{ institution: 'Example University', qualification: 'BSc Computing', endDate: '2025' }] } : {}) };
  const evidence = { headline: support, summary: support, sections: support };
  const save = (doc = document, extra = {}) => call('master_cv_save', mutation({ baseVersion: state.career.masterCv?.current?.version ?? 0, sourceSetFingerprint: sourceSetFingerprint(state.career), document: doc, presentation, evidence, ...extra }));
  const manual = (doc, extra = {}) => saveManualMaster({ store, identity: () => state.deviceId, args: mutation({ baseVersion: state.career.masterCv?.current?.version ?? 0, contact: masterCvState(state.career).contact, document: doc, presentation, ...extra }) });
  await call('cv_review_save', reviewArgs(ready));
  if (ready) await save();
  return { state: () => state.career, store, roles, refs, document, evidence, tools, mutation, call, reviewArgs, save, manual };
}

test('full active source checkpoint detects addition, removal, archival and text changes', async () => {
  const f = await fixture();
  assert.equal(masterCvState(f.state()).status, 'ready');
  const oldFingerprint = sourceSetFingerprint(f.state());
  const id = randomUUID();
  await f.store.update(state => { state.career.sources[id] = { id, purpose: 'cv', name: 'Education', text: 'Example College education', contentHash: hash('Example College education') }; });
  assert.equal(masterCvState(f.state()).status, 'stale');
  assert.equal((await f.call('cv_review_read')).sourceChanges.added[0].sourceId, id);
  await assert.rejects(f.call('cv_review_save', { ...f.reviewArgs(), sourceSetFingerprint: oldFingerprint }), { code: 'SOURCE_SET_CHANGED' });
  await assert.rejects(f.call('cv_review_save', { ...f.reviewArgs(), reviewedSourceIds: f.refs.map(ref => ref.sourceId) }), { code: 'SOURCE_REVIEW_INCOMPLETE' });
  await f.call('cv_review_save', f.reviewArgs());
  assert.equal(cvReviewState(f.state()).complete, true, 'an education-only source is explicitly reviewed without inventing a role');
  await f.save();
  assert.equal(masterCvState(f.state()).status, 'ready');
  await f.store.update(state => { delete state.career.sources[id]; });
  assert.equal((await f.call('cv_review_read')).sourceChanges.removed[0].sourceId, id);
  assert.equal(masterCvState(f.state()).status, 'stale');
  await f.call('cv_review_save', f.reviewArgs());
  await f.save();
  await f.store.update(state => { state.career.sources[f.refs[0].sourceId].archived = true; });
  assert.equal(masterCvState(f.state()).status, 'stale');
  await f.store.update(state => { delete state.career.sources[f.refs[0].sourceId].archived; state.career.sources[f.refs[0].sourceId].text += '\nChanged text without updating stored hash.'; });
  assert.equal((await f.call('cv_review_read')).sourceChanges.changed[0].sourceId, f.refs[0].sourceId);
  assert.equal(masterCvState(f.state()).status, 'stale', 'live text determines the digest, not a stale stored hash');
});

test('education and projects can produce a ready master with no employment roles', async () => {
  const f = await fixture({ noRoles: true });
  assert.equal(masterCvState(f.state()).status, 'ready');
  assert.deepEqual(assertMasterReady(f.state()).document.experience, []);
  assert.equal(cvReviewState(f.state()).pendingRoles, 0);
});

test('a provisional stable role permits identity clarification but cannot complete review', async () => {
  const f = await fixture({ ready: false });
  const role = { id: randomUUID(), employer: 'Other Example', title: 'Consultant', startDate: '2016', endDate: '2017', sourceRefs: [] };
  const args = f.reviewArgs(false);
  args.roles.push(role);
  args.review.push({ roleId: role.id, ...Object.fromEntries(facets.map(facet => [facet, { status: 'unreviewed' }])) });
  await f.call('cv_review_save', args);
  assert.equal((await f.call('cv_review_read')).roles.length, 3);
  await assert.rejects(f.call('cv_review_save', { ...args, ...f.mutation({}), complete: true }), { code: 'UNSUPPORTED_ROLE' });
  const factId = randomUUID();
  await f.store.update(state => { state.career.facts[factId] = { id: factId, kind: 'narrative', subject: 'Earlier role', answer: 'Other Example | Consultant | 2016 | 2017', createdAt: '2026-01-01', updatedAt: '2026-01-01' }; });
  role.factIds = [factId];
  await f.call('cv_review_save', { ...args, ...f.mutation({}) });
  assert.equal(f.state().facts[factId].roleId, role.id, 'explicit identity reconciliation scopes the existing literal global fact');
});

test('same employer roles retain separate identity and reject metric transplantation', async () => {
  const f = await fixture();
  const factId = randomUUID();
  await f.store.update(state => { state.career.facts[factId] = { id: factId, kind: 'narrative', subject: 'Team scope', answer: 'Led 12 engineers.', roleId: f.roles[1].id }; });
  assert.throws(() => assertSupport(f.state(), { facts: [factId] }, { roleId: f.roles[0].id, text: 'Led 12 engineers.' }), { code: 'MISATTRIBUTED_FACT' });
  assert.throws(() => assertSupport(f.state(), { sources: [f.refs[1]] }, { roleId: f.roles[0].id, text: 'Led 12 engineers.' }), { code: 'MISATTRIBUTED_FACT' });
  assert.throws(() => assertSupport(f.state(), { sources: [f.refs[0]] }, { roleId: f.roles[0].id, text: 'Reduced release time by 80%.' }), { code: 'UNSUPPORTED_NUMBER' });
  const args = f.reviewArgs();
  args.roles = args.roles.slice(0, 1); args.review = args.review.slice(0, 1);
  await assert.rejects(f.call('cv_review_save', args), { code: 'ROLE_OMITTED' });
});

test('review cannot mark unknown or declined without recorded literal user response', async () => {
  const f = await fixture({ ready: false });
  const factId = randomUUID();
  await f.store.update(state => { state.career.facts[factId] = { id: factId, kind: 'narrative', subject: 'Growth', answer: 'unknown', roleId: f.roles[0].id, facet: 'growth' }; });
  const args = f.reviewArgs();
  args.review[0].growth = { status: 'unknown', support: { facts: [factId] } };
  await assert.rejects(f.call('cv_review_save', args), { code: 'REVIEW_RESPONSE_REQUIRED' });
  args.review[0].growth.status = 'answered';
  await assert.rejects(f.call('cv_review_save', { ...args, ...f.mutation({}) }), { code: 'REVIEW_RESPONSE_REQUIRED' });
  const interviewId = randomUUID(), responseId = randomUUID();
  await f.store.update(state => {
    Object.assign(state.career.facts[factId], { resolution: 'unknown', resolutionOrigin: { kind: 'interview', interviewId, responseId } });
    state.career.interviews = { [interviewId]: { id: interviewId, status: 'completed', responses: [{ id: responseId, channel: 'chat', reply: 'unknown', answers: [{ number: 1, factId, answer: 'unknown', resolution: 'unknown', question: { roleId: f.roles[0].id, facet: 'growth' } }] }] } };
  });
  args.review[0].growth.status = 'unknown';
  await f.call('cv_review_save', { ...args, ...f.mutation({}) });
  assert.equal(cvReviewState(f.state()).complete, true);
  assert.throws(() => assertSupport(f.state(), { facts: [factId] }), { code: 'UNSUPPORTED_REQUIREMENT' });
});

test('manual edits preserve claim identity, store literal authoritative facts and survive regeneration', async () => {
  const f = await fixture();
  const doc = structuredClone(f.document), claim = doc.experience[0].bullets[0];
  claim.text = 'Supported release automation; I did not lead the migration.'; claim.support = {};
  doc.summary = 'Engineer focused on delivery improvements.';
  const saved = await f.manual(doc);
  assert.equal(saved.status, 'ready');
  assert.equal(saved.userEdited, true);
  const persisted = saved.master.document.experience[0].bullets[0];
  assert.equal(persisted.id, claim.id);
  const fact = f.state().facts[persisted.support.facts[0]];
  assert.equal(fact.answer, claim.text);
  assert.equal(fact.roleId, f.roles[0].id);
  assert.equal(f.state().sources[f.refs[0].sourceId].text, f.refs[0].quote, 'manual prose never overwrites originals');
  await assert.rejects(f.save(f.document), { code: 'USER_EDIT_CONFLICT' });
  const current = f.state().masterCv.current;
  await f.save(current.document, { evidence: current.evidence });
  assert.equal(f.state().masterCv.current.userEdited, true);
  assert.equal(f.state().masterCv.history.length, 2);
  const editedAgain = structuredClone(current.document); editedAgain.experience[0].bullets[0].text = 'Supported release automation and release planning.';
  const changed = await f.manual(editedAgain);
  assert.equal(changed.master.document.experience[0].bullets[0].support.facts[0], fact.id, 'corrections update the current fact rather than leave reusable obsolete answers');
  const unchanged = structuredClone(changed.master.document); unchanged.experience[0].bullets[0].support = {};
  const replayedUi = await f.manual(unchanged);
  assert.deepEqual(replayedUi.master.document.experience[0].bullets[0].support, changed.master.document.experience[0].bullets[0].support, 'a delayed UI draft cannot replace canonical support');
});

test('tailoring cannot restore manually removed or qualified claims through old source evidence', async () => {
  const f = await fixture();
  const doc = structuredClone(f.document), removed = doc.experience[0].bullets.pop();
  await f.manual(doc);
  assert.equal(masterEditConstraints(f.state()).claims[removed.id].removed, true);
  assert.throws(() => assertDocumentEvidence(f.state(), f.document, f.evidence), { code: 'USER_EDIT_CONFLICT' });
  assert.throws(() => assertSupport(f.state(), removed.support, { roleId: f.roles[0].id, text: removed.text, claimId: randomUUID() }), { code: 'USER_EDIT_CONFLICT' });
});

test('manual new roles are candidate-backed drafts, not silently completed source reviews', async () => {
  const f = await fixture();
  const doc = structuredClone(f.document), roleId = randomUUID();
  doc.experience.push({ roleId, employer: 'New Example', role: 'Consultant', startDate: '2016', endDate: '2017', bullets: [{ id: randomUUID(), text: 'Helped the team recover delivery.', support: {} }] });
  const saved = await f.manual(doc, { contact: { ...masterCvState(f.state()).contact, addressLine1: 'Example street', city: 'London', postalCode: 'EX1 1AA' } });
  assert.equal(saved.status, 'draft');
  assert.equal(saved.review.complete, false);
  assert.deepEqual(f.state().roles[roleId].sourceRefs, []);
  assert.equal(f.state().facts[f.state().roles[roleId].factIds[0]].roleId, roleId);
  assert.equal(f.state().profile.addressLine1, 'Example street');
  assert.throws(() => assertMasterReady(f.state()), { code: 'MASTER_NOT_READY' });
});

test('manual CAS and exact retries preserve versions and do not duplicate evidence', async () => {
  const f = await fixture();
  const args = f.mutation({ baseVersion: 1, contact: masterCvState(f.state()).contact, document: f.document, presentation });
  const first = await saveManualMaster({ store: f.store, args });
  const second = await saveManualMaster({ store: f.store, args });
  assert.deepEqual(second, first);
  assert.equal(f.state().masterCv.current.version, 2);
  await assert.rejects(saveManualMaster({ store: f.store, args: { ...args, document: { ...args.document, summary: 'Changed request' } } }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.manual(f.document, { baseVersion: 1 }), { code: 'VERSION_CONFLICT' });
  await assert.rejects(saveManualMaster({ store: f.store, args: { ...args, requestId: randomUUID() } }), { code: 'REVISION_CONFLICT' });
  assert.equal(f.state().masterCv.current.version, 2);
});

test('prohibited information cannot reenter through source citations or exact output text', async () => {
  const f = await fixture();
  const id = randomUUID(), secret = '40%';
  await f.store.update(state => { state.career.facts[id] = { id, kind: 'narrative', subject: 'Release result privacy', answer: 'Keep the release metric private.', roleId: f.roles[0].id, publication: 'prohibited', publicationRestrictions: { texts: [secret], sources: [{ ...f.refs[0], quote: 'Reduced release time by 40%.' }] } }; });
  assert.throws(() => assertSupport(f.state(), { facts: [id] }), { code: 'PUBLICATION_RESTRICTED' });
  assert.throws(() => assertSupport(f.state(), { sources: [f.refs[0]] }), { code: 'PUBLICATION_RESTRICTED' });
  assert.throws(() => assertPublishableText(f.state(), 'A 40% improvement in delivery.'), { code: 'PUBLICATION_RESTRICTED' });
  assert.doesNotThrow(() => assertPublishableText(f.state(), 'Improved delivery using repeatable releases.'));
  assert.equal(masterCvState(f.state()).status, 'stale');
});

test('enabled career breaks use the complete canonical timeline and current setting', async () => {
  const f = await fixture();
  await f.store.update(state => { state.career.careerGap = { enabled: true, activity: 'Study leave', place: 'Home', description: 'Studied independently.', minMonths: 3, fromYear: 2015, toYear: 2026 }; state.career.roles[f.roles[0].id].endDate = '2020-01'; state.career.roles[f.roles[1].id].startDate = '2021-01'; });
  const gaps = masterCareerGaps(f.state(), { ...f.document, experience: [] });
  assert.deepEqual(gaps, [{ activity: 'Study leave', place: 'Home', description: 'Studied independently.', startDate: 'Jan 2020', endDate: 'Jan 2021' }]);
  assert.equal(masterCvState(f.state()).status, 'stale');
  await f.store.update(state => { state.career.careerGap.enabled = false; });
  assert.equal(masterCareerGaps(f.state(), f.document), undefined);
});

test('gap setting changes rebind a user-edited master without overwriting authored content', async () => {
  const f = await fixture({ ready: false });
  const ref = f.refs[1];
  ref.quote = ref.quote.replace('2021', '2023');
  ref.contentHash = hash(ref.quote);
  f.roles[1].startDate = '2023';
  f.document.experience[1].startDate = '2023';
  f.document.skills = [{ label: 'Engineering', items: ['release automation'] }];
  await f.store.update(state => {
    Object.assign(state.career.sources[ref.sourceId], { text: ref.quote, contentHash: ref.contentHash });
  });
  await f.call('cv_review_save', f.reviewArgs());
  await f.save();
  await f.manual({ ...f.document, summary: 'I build dependable services and lead engineering teams.' });
  await f.store.update(state => {
    state.career.careerGap = { enabled: true, activity: 'Study leave', place: 'Home', description: 'Studied independently.', minMonths: 3, fromYear: 2015, toYear: 2026 };
  });
  const before = f.state().masterCv.current;
  const enabled = await f.save(before.document, { evidence: before.evidence });
  assert.equal(enabled.status, 'ready');
  assert.equal(enabled.master.document.summary, before.document.summary);
  assert.equal(enabled.master.document.careerGaps[0].activity, 'Study leave');
  assert.deepEqual(enabled.master.document.experience, before.document.experience);
  await f.store.update(state => { state.career.careerGap.enabled = false; });
  const current = f.state().masterCv.current;
  const disabled = await f.save(current.document, { evidence: current.evidence });
  assert.equal(disabled.status, 'ready');
  assert.equal(disabled.master.document.careerGaps, undefined);
  await assert.rejects(f.save({ ...disabled.master.document, summary: 'An agent replacement.' }, { evidence: current.evidence }), { code: 'USER_EDIT_CONFLICT' });
});

test('manual bio edits preserve unrelated role evidence for future job tailoring', async () => {
  const f = await fixture();
  await f.manual({ ...f.document, summary: 'I build dependable services and lead engineering teams.' });
  const current = f.state().masterCv.current;
  assert.doesNotThrow(() => assertSupport(f.state(), { sources: [f.refs[0]] }, {
    roleId: f.roles[0].id, text: 'Built release automation.', field: 'requirement',
  }));
  const tailored = { ...current.document, summary: 'I lead engineering teams and build release automation.' };
  const evidence = { ...current.evidence, summary: { ...current.evidence.summary, sources: [f.refs[0]] } };
  assert.doesNotThrow(() => assertDocumentEvidence(f.state(), tailored, evidence));
  assert.throws(() => assertDocumentEvidence(f.state(), { ...current.document, summary: f.document.summary },
    { ...current.evidence, summary: f.evidence.summary }), { code: 'USER_EDIT_CONFLICT' });
});

test('master export binds current review/version and preserves full contact without duplicates', async () => {
  const f = await fixture();
  const args = f.mutation({ baseVersion: 1, format: 'txt' });
  const snapshot = masterExportSnapshot(f.state(), args);
  const header = masterHeading({ ...snapshot.contact, addressLine1: 'Example road', city: 'London', links: [snapshot.contact.linkedinUrl, 'https://example.test/alex'] });
  assert.equal(header.contact.split(snapshot.contact.linkedinUrl).length - 1, 1);
  assert.match(header.contact, /Example road/);
  const result = await renderMaster(snapshot, snapshot.contact, { renderCareerCvText: ({ heading, document }) => `${heading.name}\n${heading.contact}\n${document.summary}` }, 'txt');
  assert.match(result.bytes.toString('utf8'), /Alex Example/);
  await f.store.update(state => { delete state.career.sources[f.refs[0].sourceId]; });
  assert.throws(() => masterExportSnapshot(f.state(), args), { code: 'MASTER_NOT_READY' });
  assert.equal(masterCvState(f.state()).master.document.summary, f.document.summary, 'stale document remains readable');
});

test('backup validation retains stale history but rejects misattribution and lost ownership', async () => {
  const f = await fixture();
  const doc = structuredClone(f.document); doc.experience[0].bullets[0].text = 'Supported release automation.';
  await f.manual(doc);
  const saved = f.state();
  assert.doesNotThrow(() => validateMasterCareer(saved));
  delete saved.sources[f.refs[0].sourceId];
  assert.doesNotThrow(() => validateMasterCareer(saved), 'deleting an original does not make recoverable history invalid');
  const wrong = structuredClone(saved), factId = wrong.masterCv.current.document.experience[0].bullets[0].support.facts[0];
  wrong.facts[factId].roleId = f.roles[1].id;
  assert.throws(() => validateMasterCareer(wrong), { code: 'INVALID_INPUT' });
  const ownership = structuredClone(saved); ownership.masterCv.current.userEdited = false;
  assert.throws(() => validateMasterCareer(ownership), { code: 'INVALID_INPUT' });
});

test('backup rejects orphaned master history and unsafe version counters', async () => {
  const f = await fixture();
  await f.manual(f.document);
  const noTip = structuredClone(f.state()); noTip.masterCv.current = null;
  assert.throws(() => validateMasterCareer(noTip), { code: 'INVALID_INPUT' });
  const overflow = structuredClone(f.state()); overflow.masterCv.current.version = Number.MAX_SAFE_INTEGER;
  assert.throws(() => validateMasterCareer(overflow), { code: 'INVALID_INPUT' });
  await f.store.update(state => { state.career.masterCv.current.version = Number.MAX_SAFE_INTEGER - 1; });
  await assert.rejects(f.manual(f.document), { code: 'VERSION_CONFLICT' });
  assert.equal(f.state().masterCv.current.version, Number.MAX_SAFE_INTEGER - 1);
});

test('different roles cannot bind the same whole CV as their own achievement excerpt', async () => {
  const f = await fixture({ ready: false });
  const text = f.refs.map(ref => ref.quote).join('\n\n'), sourceId = f.refs[0].sourceId;
  await f.store.update(state => { state.career.sources[sourceId].text = text; delete state.career.sources[f.refs[1].sourceId]; });
  const args = f.reviewArgs(false);
  args.roles = args.roles.map(role => ({ ...role, sourceRefs: [{ sourceId, contentHash: hash(text), quote: text }] }));
  await assert.rejects(f.call('cv_review_save', args), { code: 'MISATTRIBUTED_FACT' });
});

test('known negative answers cannot serve as positive achievement evidence', async () => {
  const f = await fixture();
  for (const [kind, answer] of [['capability', 'None'], ['yes_no', 'No']]) {
    const id = randomUUID();
    await f.store.update(state => { state.career.facts[id] = { id, kind, subject: 'Synthetic requirement', answer, roleId: f.roles[0].id }; });
    assert.throws(() => assertSupport(f.state(), { facts: [id] }, { roleId: f.roles[0].id, text: 'Led the work.' }), { code: 'UNSUPPORTED_REQUIREMENT' });
  }
});

test('review fact facets cannot be relabelled to complete unrelated coverage', async () => {
  const f = await fixture({ ready: false }), id = randomUUID();
  await f.store.update(state => { state.career.facts[id] = { id, kind: 'narrative', subject: 'Release result', answer: 'Improved delivery reliability.', roleId: f.roles[0].id, facet: 'outcomes' }; });
  const args = f.reviewArgs();
  args.review[0].growth = { status: 'answered', support: { facts: [id] } };
  await assert.rejects(f.call('cv_review_save', args), { code: 'MISATTRIBUTED_FACT' });
});

test('private role identity cannot leak as shorter structured headings or dates', async () => {
  const f = await fixture(), id = randomUUID(), role = f.roles[0];
  await f.store.update(state => { state.career.facts[id] = { id, kind: 'narrative', subject: 'Private role identity', answer: `${role.employer} | ${role.title} | ${role.startDate}`, roleId: role.id, facet: 'role_identity', publication: 'prohibited' }; });
  assert.throws(() => assertDocumentEvidence(f.state(), f.document, f.evidence), { code: 'PUBLICATION_RESTRICTED' });
  assert.doesNotThrow(() => assertPublishableText(f.state(), 'Engineer'), 'ordinary words are not globally blacklisted by reverse containment');
});

test('old writing policy makes a saved master stale without destroying edits', async () => {
  const f = await fixture();
  await f.store.update(state => { state.career.masterCv.current.policyId = hash('old policy'); });
  assert.equal(masterCvState(f.state()).status, 'stale');
  assert.throws(() => assertMasterReady(f.state()), { code: 'MASTER_NOT_READY' });
  assert.equal(masterCvState(f.state()).master.document.summary, f.document.summary);
});

test('same-text agent rebinding cannot swap user evidence or presentation', async () => {
  const f = await fixture(), doc = structuredClone(f.document);
  doc.summary = 'Engineer focused on release work, without claiming ownership of the entire migration.';
  const saved = await f.manual(doc, { presentation: { template: 'modern', paper: 'LETTER' } });
  const current = f.state().masterCv.current;
  await assert.rejects(f.save(saved.master.document, { presentation: current.presentation, evidence: { ...current.evidence, summary: f.evidence.summary } }), { code: 'USER_EDIT_CONFLICT' });
  await assert.rejects(f.save(saved.master.document, { presentation, evidence: current.evidence }), { code: 'USER_EDIT_CONFLICT' });
  await f.save(saved.master.document, { presentation: current.presentation, evidence: current.evidence });
  assert.deepEqual(f.state().masterCv.current.presentation, { template: 'modern', paper: 'LETTER' });
});

test('a new explicit user claim can restore wording previously removed under another ID', async () => {
  const f = await fixture(), without = structuredClone(f.document), removed = without.experience[0].bullets.pop();
  await f.manual(without);
  const restored = structuredClone(f.state().masterCv.current.document);
  restored.experience[0].bullets.push({ id: randomUUID(), text: removed.text, support: {} });
  await f.manual(restored);
  const current = f.state().masterCv.current;
  assert.equal(masterEditConstraints(f.state()).claims[removed.id], undefined);
  const tailored = structuredClone(current.document);
  tailored.headline = 'Engineer focused on delivery';
  assert.doesNotThrow(() => assertDocumentEvidence(f.state(), tailored, current.evidence));
});

test('unfaceted facts used to establish role identity cannot complete outcome facets', async () => {
  const f = await fixture({ ready: false }), id = randomUUID(), role = f.roles[0];
  await f.store.update(state => { state.career.facts[id] = { id, kind: 'narrative', subject: 'Earlier employment', answer: `${role.employer} | ${role.title} | ${role.startDate} | ${role.endDate}`, roleId: role.id }; });
  for (const facet of facets) {
    const args = f.reviewArgs();
    args.roles[0] = { ...args.roles[0], factIds: [id] };
    args.review[0][facet] = { status: 'answered', support: { facts: [id] } };
    await assert.rejects(f.call('cv_review_save', args), { code: 'MISATTRIBUTED_FACT' });
  }
});

test('omitting a private role from experience does not authorize its employer elsewhere', async () => {
  const f = await fixture(), id = randomUUID(), role = f.roles[0];
  await f.store.update(state => { state.career.facts[id] = { id, kind: 'narrative', subject: 'Private identity', answer: `${role.employer} | ${role.title} | ${role.startDate}`, roleId: role.id, facet: 'role_identity', publication: 'prohibited' }; });
  const base = { ...structuredClone(f.document), experience: [] };
  for (const document of [
    { ...base, headline: `Engineer at ${role.employer}` },
    { ...base, summary: `Delivered services for ${role.employer}.` },
    { ...base, highlights: [{ id: randomUUID(), text: `Worked at ${role.employer}.`, support: { sources: [f.refs[0]] } }] },
  ]) assert.throws(() => assertDocumentEvidence(f.state(), document, f.evidence), { code: 'PUBLICATION_RESTRICTED' });
  assert.doesNotThrow(() => assertPublishableText(f.state(), ['Engineer', '2018', 'Delivered reliable services.']));
  assert.doesNotThrow(() => assertDocumentEvidence(f.state(), base, f.evidence));
});

test('marked original role identity passages protect named employers beyond experience', async () => {
  const f = await fixture(), id = randomUUID(), role = f.roles[0];
  await f.store.update(state => { state.career.facts[id] = { id, kind: 'narrative', subject: 'Original CV privacy', answer: 'Do not publish that employer.', publication: 'prohibited', publicationRestrictions: {
    texts: ['Do not publish that employer.'], sources: [{ ...f.refs[0], quote: `${role.employer} | ${role.title} | ${role.startDate} | ${role.endDate}` }],
  } }; });
  assert.throws(() => assertPublishableText(f.state(), `Delivered services at ${role.employer}.`), { code: 'PUBLICATION_RESTRICTED' });
  assert.doesNotThrow(() => assertPublishableText(f.state(), 'Engineer delivering services since 2018.'));
});

test('private current and historical role locations remain protected when experience is omitted', async () => {
  const f = await fixture(), doc = structuredClone(f.document), roleId = f.roles[0].id;
  doc.experience[0].location = 'Secret Base';
  await f.manual(doc);
  await f.store.update(state => {
    const fact = state.career.facts[state.career.roles[roleId].factIds[0]];
    fact.publication = 'prohibited';
    fact.publicationRestrictions = { texts: [fact.answer], sources: [] };
  });
  const check = () => {
    const base = { ...structuredClone(f.state().masterCv.current.document), experience: [] };
    for (const document of [
      { ...base, summary: 'Worked in Secret Base.' },
      { ...base, highlights: [{ id: randomUUID(), text: 'Delivered services in Secret Base.', support: { sources: [f.refs[0]] } }] },
    ]) assert.throws(() => assertDocumentEvidence(f.state(), document, f.state().masterCv.current.evidence), { code: 'PUBLICATION_RESTRICTED' });
    assert.doesNotThrow(() => assertPublishableText(f.state(), ['Engineer', '2018']));
  };
  check();
  const revised = structuredClone(f.state().masterCv.current.document);
  revised.experience[0].location = 'Public Office';
  await f.manual(revised);
  check();
});

test('source-bound role identity protects literal historical location excerpts', async () => {
  const f = await fixture(), roleId = f.roles[0].id, sourceId = f.refs[0].sourceId, id = randomUUID();
  const text = `${f.refs[0].quote}\nWork location: Secret Base`;
  const ref = { sourceId, contentHash: hash(text), quote: text };
  await f.store.update(state => {
    state.career.sources[sourceId].text = text;
    state.career.sources[sourceId].contentHash = ref.contentHash;
    state.career.roles[roleId].sourceRefs = [ref];
  });
  const doc = structuredClone(f.document); doc.experience[0].location = 'Secret Base';
  await f.manual(doc);
  const revised = structuredClone(f.state().masterCv.current.document); revised.experience[0].location = 'Public Office';
  await f.manual(revised);
  await f.store.update(state => { state.career.facts[id] = { id, kind: 'narrative', subject: 'Private original identity', answer: 'Keep this identity private.', publication: 'prohibited', publicationRestrictions: { texts: [], sources: [ref] } }; });
  assert.throws(() => assertPublishableText(f.state(), 'Worked in Secret Base.'), { code: 'PUBLICATION_RESTRICTED' });
  assert.doesNotThrow(() => assertPublishableText(f.state(), 'Engineer working since 2018.'));
});
