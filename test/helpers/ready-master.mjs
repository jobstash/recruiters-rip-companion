import { randomUUID } from 'node:crypto';
import { hash } from '../../src/mcp/state.mjs';
import { createMasterCvTools, sourceSet, sourceSetFingerprint } from '../../src/mcp/master-cv.mjs';
import { createApplicationTools } from '../../src/mcp/application-tools.mjs';

/** Synthetic fixtures only. Exercises the actual review and master-save contracts. */
export async function readyMaster(store, options = {}) {
  let career = store.get().career;
  if (!options.roles && !career.masterCv?.current) {
    const sourceId = randomUUID(), roleId = randomUUID();
    const text = 'Synthetic Employer | Engineer | 2020 | Present\nBuilt reliable services. Improved delivery reliability. Grew from delivery to service ownership. Resolved a difficult production incident by tracing the failing dependency and restoring service.';
    await store.update(state => {
      state.career.sources[sourceId] = { id: sourceId, name: 'Synthetic original CV', purpose: 'cv', text, contentHash: hash(text), mediaType: 'text/plain', createdAt: '2026-01-01T00:00:00Z' };
    });
    career = store.get().career;
    const ref = { ...sourceSet(career).find(source => source.sourceId === sourceId), quote: text };
    options = { ...options, roles: [{ id: roleId, employer: 'Synthetic Employer', title: 'Engineer', startDate: '2020', endDate: 'Present', sourceRefs: [ref] }],
      document: { headline: 'Engineer', summary: 'Built reliable services.', experience: [{ roleId, employer: 'Synthetic Employer', role: 'Engineer', startDate: '2020', endDate: 'Present', bullets: [{ id: randomUUID(), text: 'Built reliable services.', support: { sources: [ref] } }] }] } };
  }
  const roles = options.roles ?? Object.values(career.roles ?? {});
  const document = options.document ?? career.masterCv.current.document;
  const support = { sources: sourceSet(career).map(source => ({ ...source, quote: career.sources[source.sourceId].text })) };
  if (!support.sources.length) { delete support.sources; support.facts = Object.keys(career.facts); }
  const evidence = options.evidence ?? career.masterCv?.current?.evidence ?? { headline: support, summary: support, sections: support };
  const tools = new Map(createMasterCvTools({ store }).map(tool => [tool.name, tool]));
  const mutation = args => ({ requestId: randomUUID(), revision: store.get().career.revision, ...args });
  await tools.get('career_cv_review_save').invoke(mutation({ sourceSetFingerprint: sourceSetFingerprint(career), reviewedSourceIds: sourceSet(career).map(source => source.sourceId), roles,
    review: roles.map(role => ({ roleId: role.id, ...Object.fromEntries(['outcomes', 'growth', 'complex_scenario'].map(facet => [facet,
      { status: 'answered', support: role.sourceRefs.length ? { sources: role.sourceRefs } : {
        facts: Object.entries(career.facts).filter(([id, fact]) => fact.roleId === role.id && fact.facet === facet && !role.factIds?.includes(id)).map(([id]) => id),
      } }])) })), complete: true }));
  const result = await tools.get('career_master_cv_save').invoke(mutation({ baseVersion: career.masterCv?.current?.version ?? 0,
    sourceSetFingerprint: sourceSetFingerprint(store.get().career), document, evidence, presentation: career.masterCv?.current?.presentation ?? { template: 'classic', paper: 'A4' } }));
  return { master: result.master, support, evidence, roles, document: result.master.document };
}

/** Payloads omit mutation receipts: attach a fresh requestId/current revision immediately before each call. */
export function tailoringPayloads(context, { requirements, paragraphs, document = context.master.document }) {
  const binding = { applicationId: context.application.id, masterVersion: context.master.version,
    contextFingerprint: context.contextFingerprint, requirements };
  return {
    cv: { ...binding, cv: structuredClone(document), evidence: context.master.evidence, presentation: context.master.presentation },
    letter: { ...binding, paragraphs, evidence: paragraphs.map(() => context.master.evidence.summary) },
  };
}

/** Actual tool sequence for parent smoke tests; callers supply isolated store and real renderer/export adapters. */
export async function readyApplication({ store, documents, exportDocument, format = 'txt' }) {
  const ready = await readyMaster(store);
  const tools = new Map(createApplicationTools({ store, documents, exportDocument }).map(tool => [tool.name, tool]));
  const call = (name, args) => tools.get(name).invoke(args);
  const mutation = args => ({ requestId: randomUUID(), revision: store.get().career.revision, ...args });
  const { applicationId } = await call('career_application_create', mutation({ job: { title: 'Engineer', company: 'Synthetic Hiring Employer',
    description: 'Build reliable services. Production incident ownership is important.', url: 'https://synthetic.example/jobs/engineer' } }));
  const context = await call('career_application_context', { applicationId });
  const requirements = [{ id: randomUUID(), phrase: 'reliable services', priority: 'crucial', kind: 'skill', status: 'supported',
    support: ready.support, roleIds: [ready.roles[0].id], rationale: 'The original states delivery of reliable services.' }];
  const payloads = tailoringPayloads(context, { requirements, paragraphs: ['Dear Synthetic Hiring Employer team,', 'Built reliable services and resolved a difficult production incident by tracing the failing dependency and restoring service.'] });
  await call('career_application_cv_save', mutation(payloads.cv));
  await call('career_application_letter_save', mutation(payloads.letter));
  const exports = [];
  for (const kind of ['cv', 'cover_letter']) exports.push(await call('career_application_export', mutation({ applicationId, kind, format })));
  return { applicationId, context, payloads, exports, call, mutation };
}
