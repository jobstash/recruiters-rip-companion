import { fail } from './state.mjs';

/** A socket's pending operations never inherit a later account or unlock epoch. */
export function createScopedAccess(store, { assertAvailable, epoch }) {
  const generation = epoch();
  let deviceId;
  function check(mutation) {
    assertAvailable(mutation);
    if (epoch() !== generation)
      fail('IDENTITY_CHANGED', 'The local device connection changed. Reconnect the MCP server and read the current account before continuing.');
    const current = store.get().deviceId;
    if (deviceId === undefined) deviceId = current;
    if (current !== deviceId)
      fail('IDENTITY_CHANGED', 'The local device connection changed. Reconnect the MCP server and read the current account before continuing.');
  }
  return {
    assertAvailable: check,
    store: {
      get() { check(false); return store.get(); },
      update(change) {
        check(true);
        return store.update(async state => {
          check(true);
          if (state.deviceId !== deviceId) fail('IDENTITY_CHANGED', 'The local account changed. Reconnect before saving.');
          await change(state);
          check(true);
        });
      },
    },
  };
}
