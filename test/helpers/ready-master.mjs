import { randomUUID } from 'node:crypto';
import { hash } from '../../src/mcp/state.mjs';
import { createMasterCvTools } from '../../src/mcp/master-cv.mjs';
import { createApplicationTools } from '../../src/mcp/application-tools.mjs';

/** Synthetic fixtures only; exercises the ordinary master save. */
export async function readyMaster(store, options = {}) {
  let career = store.get().career;
  if (!options.document && !career.masterCv?.current) {
    const sourceId = randomUUID();
    const text = 'Synthetic Employer | Engineer | 2020 | Present\nBuilt reliable services. Improved delivery reliability. Grew from delivery to service ownership. Resolved a difficult production incident by tracing the failing dependency and restoring service.';
    await store.update(state => {
      state.career.sources[sourceId] = { id: sourceId, name: 'Synthetic original CV', purpose: 'cv', text, contentHash: hash(text), mediaType: 'text/plain', createdAt: '2026-01-01T00:00:00Z' };
    });
    career = store.get().career;
  }
  const document = options.document ?? career.masterCv?.current?.document ?? { headline: 'Engineer', summary: 'Built reliable services.', experience: [
    { employer: 'Synthetic Employer', role: 'Engineer', startDate: '2020', endDate: 'Present', bullets: ['Built reliable services.'] },
  ] };
  const save = createMasterCvTools({ store }).find(tool => tool.name === 'career_master_cv_save');
  const result = await save.invoke({ baseVersion: career.masterCv?.current?.version ?? 0, document,
    presentation: career.masterCv?.current?.presentation ?? { template: 'classic', paper: 'A4' } });
  return { master: result.master, document: result.master.document };
}

export function tailoringPayloads(context, { paragraphs, document = context.master.document }) {
  const binding = { applicationId: context.application.id, masterVersion: context.master.version };
  return {
    cv: { ...binding, cv: structuredClone(document), presentation: context.master.presentation },
    letter: { ...binding, paragraphs },
  };
}

/** Actual tool sequence with an isolated store and real renderer/export adapters. */
export async function readyApplication({ store, documents, exportDocument, format = 'txt' }) {
  await readyMaster(store);
  const tools = new Map(createApplicationTools({ store, documents, exportDocument }).map(tool => [tool.name, tool]));
  const call = (name, args) => tools.get(name).invoke(args);
  const mutation = args => ({ requestId: randomUUID(), revision: store.get().career.revision, ...args });
  const { applicationId } = await call('career_application_create', mutation({ job: { title: 'Engineer', company: 'Synthetic Hiring Employer',
    description: 'Build reliable services. Production incident ownership is important.', url: 'https://synthetic.example/jobs/engineer' } }));
  const context = await call('career_application_context', { applicationId });
  const payloads = tailoringPayloads(context, { paragraphs: ['Dear Synthetic Hiring Employer team,', 'Built reliable services and resolved a difficult production incident by tracing the failing dependency and restoring service.'] });
  await call('career_application_cv_save', payloads.cv);
  await call('career_application_letter_save', payloads.letter);
  const exports = [];
  for (const kind of ['cv', 'cover_letter']) exports.push(await call('career_application_export', mutation({ applicationId, kind, format })));
  return { applicationId, context, payloads, exports, call, mutation };
}
