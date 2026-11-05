import { createCareerState } from './mcp/state.mjs';
import { loadMatchingCatalogue, replaceFeedCache } from './mcp/matching-tools.mjs';
import { savedPublicationRange } from './mcp/review-queue.mjs';
import { publicationWindowForRange } from './mcp/publication-range.mjs';

const FRESH_MS = 15 * 60 * 1000;
const identityKey = state => state.pairing
  ? JSON.stringify([state.deviceId, state.pairing.origin, state.pairing.account?.id]) : null;
const emptyCount = () => ({ total: null, checkedAt: null, pending: false });

/** Why the job feed could not load, in the terms the Jobs empty state acts on. */
export function catalogueFailure(error) {
  if (error?.code === 'PAIRING_REQUIRED') return 'not_connected';
  if (error?.status === 403 && /membership/i.test(error.message ?? '')) return 'membership';
  if (error?.code === 'DEVICE_UNAUTHORIZED') return 'reconnect';
  if (error?.code === 'DEVICE_OFFLINE') return 'offline';
  return 'failed';
}

/** Companion loads only the selected publication window's jobs before AI review.
 *  `total` counts that window; `catalogueTotal` independently counts the whole remote catalogue, or is null if unknown. */
export function createJobsCatalogue({ store, platform, onChange = () => {}, now = Date.now }) {
  let current = { status: 'idle' }, request = 0, loadedAt = 0, identity = null, count = emptyCount();
  const set = next => { current = next; onChange(current); return current; };
  const reset = () => {
    request++; loadedAt = 0; identity = null; count = emptyCount();
    if (current.status !== 'idle') set({ status: 'idle' });
  };
  async function loadCount(account, cache) {
    const window = publicationWindowForRange('all', now());
    try {
      const result = await platform('matching_catalogue', {
        publicationRange: window.range, since: window.since, until: window.until, countOnly: true,
      });
      if (!Number.isSafeInteger(result?.total) || result.total < 0 ||
          result.publicationWindow?.range !== window.range || result.publicationWindow?.since !== window.since ||
          result.publicationWindow?.until !== window.until || cache !== count) return;
      const saved = store.get();
      if (identityKey(saved) !== account) return;
      cache.total = result.total;
      if (current.status !== 'idle' && current.range === savedPublicationRange(saved.career ?? {}))
        set({ ...current, catalogueTotal: cache.total });
    } catch {
      // A missing full count must not prevent the selected jobs from loading.
    } finally {
      cache.pending = false;
      cache.checkedAt = now();
    }
  }
  return {
    state: () => current,
    reset,
    async load({ force = false } = {}) {
      const saved = store.get(), account = identityKey(saved);
      if (!account) { reset(); return current; }
      if (account !== identity) { reset(); identity = account; }
      const range = savedPublicationRange(saved.career ?? {}), timestamp = now();
      const refreshCount = force || (!count.pending && (count.checkedAt === null || timestamp - count.checkedAt >= FRESH_MS));
      if (refreshCount) count = { ...emptyCount(), pending: true };
      if (!force && current.range === range && (current.status === 'loading' || (current.status === 'ready' && timestamp - loadedAt < FRESH_MS))) {
        if (refreshCount) {
          if (current.catalogueTotal !== null) set({ ...current, catalogueTotal: null });
          void loadCount(account, count);
        }
        return current;
      }
      const id = ++request, window = publicationWindowForRange(range, timestamp);
      set({ status: 'loading', range, catalogueTotal: count.total });
      try {
        const selected = loadMatchingCatalogue(platform, window);
        if (refreshCount) void loadCount(account, count);
        const { jobs, total } = await selected;
        if (id !== request) return current;
        let written = false;
        await store.update(state => {
          if (id !== request || identityKey(state) !== account || savedPublicationRange(state.career ?? {}) !== range) return;
          const career = state.career ??= createCareerState();
          replaceFeedCache(career, jobs, window);
          written = true;
        });
        if (id !== request) return current;
        const latest = store.get();
        if (!written || identityKey(latest) !== account || savedPublicationRange(latest.career ?? {}) !== range)
          return set({ status: 'idle' });
        loadedAt = now();
        return set({ status: 'ready', range, total, catalogueTotal: count.total });
      } catch (error) {
        if (id !== request) return current;
        const latest = store.get();
        if (identityKey(latest) !== account || savedPublicationRange(latest.career ?? {}) !== range)
          return set({ status: 'idle' });
        return set({ status: 'failed', range, reason: catalogueFailure(error), catalogueTotal: count.total });
      }
    },
  };
}
