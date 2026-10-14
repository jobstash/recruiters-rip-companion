import { createHash } from 'node:crypto';
import { canonicalJSON } from '../client.mjs';

export { canonicalJSON };
export const mutationSchema = Object.freeze({ requestId: { type: 'string', format: 'uuid' }, revision: { type: 'integer', minimum: 0 } });
export const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
export class CareerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function fail(code, message) { throw new CareerError(code, message); }
export function createCareerState() {
  return { version: 1, revision: 0, evidenceRevision: 0,
    profile: { name: null, headline: null, email: null, phone: null, location: null, links: [], roleCapabilities: [], seniority: null, skills: [], preferences: {} },
    sources: {}, facts: {}, applications: {}, receipts: {} };
}
export function readCareer(store) { return store.get().career ?? createCareerState(); }
function preflight(career, { requestId, revision }, operation, input) {
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) || !Number.isSafeInteger(revision) || revision < 0)
    fail('INVALID_INPUT', 'Use a fresh request ID and the revision returned by the latest read.');
  const inputHash = hash({ operation, input });
  const receipt = career.receipts[requestId];
  if (receipt) {
    if (receipt.operation !== operation || receipt.inputHash !== inputHash)
      fail('REQUEST_CONFLICT', 'This request ID was already used with different content. Read the saved state and use a new request ID.');
    return { receipt, inputHash };
  }
  if (career.revision !== revision) fail('REVISION_CONFLICT', 'The local profile changed. Read its current state and apply your change to the new revision.');
  return { receipt: null, inputHash };
}
export function replayCareer(store, mutation, operation, input) {
  return preflight(readCareer(store), mutation, operation, input).receipt?.result ?? null;
}
export async function mutateCareer(store, mutation, operation, input, change) {
  let result;
  await store.update(async state => {
    const career = state.career ??= createCareerState();
    const checked = preflight(career, mutation, operation, input);
    if (checked.receipt) { result = checked.receipt.result; return; }
    const data = await change(career);
    career.revision++;
    result = structuredClone({ ...data, revision: career.revision });
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) fail('RESULT_LIMIT', 'This result is too large. Request a smaller set of records.');
    career.receipts[mutation.requestId] = { operation, inputHash: checked.inputHash, result: structuredClone(result), createdAt: new Date().toISOString() };
  });
  return result;
}
