import { createCareerState } from './mcp/state.mjs';
import { loadMatchingCatalogue, replaceFeedCache } from './mcp/matching-tools.mjs';
import { savedPublicationRange } from './mcp/review-queue.mjs';
import { publicationWindowForRange } from './mcp/publication-range.mjs';

const FRESH_MS = 15 * 60 * 1000;

/** Why the job feed could not load, in the terms the Jobs empty state acts on. */
export function catalogueFailure(error) {
  if (error?.code === 'PAIRING_REQUIRED') return 'not_connected';
  if (error?.status === 403 && /membership/i.test(error.message ?? '')) return 'membership';
  if (error?.code === 'DEVICE_UNAUTHORIZED') return 'reconnect';
  if (error?.code === 'DEVICE_OFFLINE') return 'offline';
  return 'failed';
}

/** Companion loads the selected publication window's jobs itself, so Jobs shows the real count and rows before any AI review.
 *  States: idle (no account), loading, ready ({total}) or failed ({reason}). A newer load or reset discards an older result. */
export function createJobsCatalogue({ store, platform, onChange = () => {}, now = Date.now }) {
  let current = { status: 'idle' }, request = 0, loadedAt = 0;
  const set = next => { current = next; onChange(current); return current; };
  return {
    state: () => current,
    reset() { request++; loadedAt = 0; if (current.status !== 'idle') set({ status: 'idle' }); },
    async load({ force = false } = {}) {
      const saved = store.get();
      if (!saved.pairing) { request++; return current.status === 'idle' ? current : set({ status: 'idle' }); }
      const range = savedPublicationRange(saved.career ?? {});
      if (!force && current.range === range && (current.status === 'loading' || (current.status === 'ready' && now() - loadedAt < FRESH_MS)))
        return current;
      const id = ++request, window = publicationWindowForRange(range, now());
      set({ status: 'loading', range });
      try {
        const { jobs, total } = await loadMatchingCatalogue(platform, window);
        if (id !== request) return current;
        let written = false;
        await store.update(state => {
          const career = state.career ??= createCareerState();
          if (savedPublicationRange(career) !== range) return;
          replaceFeedCache(career, jobs, window);
          written = true;
        });
        if (id !== request) return current;
        if (!written) return set({ status: 'idle' });
        loadedAt = now();
        return set({ status: 'ready', range, total });
      } catch (error) {
        return id === request ? set({ status: 'failed', range, reason: catalogueFailure(error) }) : current;
      }
    },
  };
}
