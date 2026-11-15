import { fail } from './state.mjs';

/** A socket's pending operations never inherit a later account or profile epoch. */
export function createScopedAccess(store, { assertAvailable, epoch }) {
  const generation = epoch();
  let deviceId;
  function guard(mutation) {
    assertAvailable(mutation);
    if (epoch() !== generation)
      fail('IDENTITY_CHANGED', 'The local device connection changed. Reconnect the MCP server and read the current account before continuing.');
  }
  function identity(current) {
    if (deviceId === undefined) deviceId = current;
    if (current !== deviceId)
      fail('IDENTITY_CHANGED', 'The local device connection changed. Reconnect the MCP server and read the current account before continuing.');
  }
  function check(mutation) {
    guard(mutation);
    identity(store.select ? store.select(state => state.deviceId) : store.get().deviceId);
  }
  return {
    assertAvailable: check,
    store: {
      get() {
        guard(false);
        const state = store.get();
        identity(state.deviceId);
        return state;
      },
      select(project) {
        guard(false);
        const select = state => { identity(state.deviceId); return project(state); };
        return store.select ? store.select(select) : structuredClone(select(store.get()));
      },
      update(change, { beforeCommit } = {}) {
        check(true);
        return store.update(async state => {
          check(true);
          if (state.deviceId !== deviceId) fail('IDENTITY_CHANGED', 'The local account changed. Reconnect before saving.');
          await change(state);
          check(true);
        }, { beforeCommit: () => { check(true); beforeCommit?.(); } });
      },
    },
  };
}
