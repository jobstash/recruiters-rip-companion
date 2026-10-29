// The toolbar gesture grants activeTab; opening the sidebar selector does not.
export function createPageAccess({ sidePanel, sidebarAction, tabs, scripting, action, onAccess = () => {}, onError }) {
  const firefox = !!sidebarAction;
  const failure = (code, message) => Object.assign(new Error(message), { code });
  if (!firefox) void sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(onError);
  action?.onClicked.addListener(tab => {
    if (!Number.isInteger(tab.id)) return;
    // open() must run directly in the toolbar gesture, before any await.
    void (firefox ? sidebarAction.open() : sidePanel.open({ tabId: tab.id })).then(() => onAccess(tab.id)).catch(onError);
  });
  return async function inject(tabId, func, args = [], documentId = null) {
    if (!Number.isInteger(tabId)) throw failure('PAGE_PERMISSION_REQUIRED', 'On the job page, click the recruiters.rip icon beside the address bar to allow access, then choose Read page.');
    const tab = await tabs.get(tabId);
    // Tab metadata can omit URL. Do not confuse redacted metadata with an
    // unsupported page: scripting enforces the grant, and injected functions
    // validate the actual HTTP(S) location before collecting or writing data.
    if (tab.url && !/^https?:\/\//.test(tab.url)) throw failure('PAGE_UNSUPPORTED', 'This browser page cannot be read. Open a job advert or application website, then click the recruiters.rip toolbar icon.');
    let results;
    try {
      results = await scripting.executeScript({
        target: { tabId, ...(firefox ? { frameIds: [0] } : documentId ? { documentIds: [documentId] } : {}) },
        func,
        // Firefox versions without documentIds must check the isolated-world
        // token inside the SAME injection, before reading or arming anything.
        args: firefox ? [args[0] ?? null, documentId] : args,
      });
    }
    catch (cause) {
      const denied = /cannot access|missing host permission|must request permission|not allowed to access/i.test(cause?.message ?? '');
      throw documentId ? failure('PAGE_CHANGED', 'The page changed or access expired. Click the recruiters.rip toolbar icon on this tab, then choose Read page.')
        : denied ? failure('PAGE_PERMISSION_REQUIRED', 'Allow access to this job page: click the recruiters.rip icon beside the address bar, not the sidebar button, then choose Read page.')
          : failure('PAGE_READ_FAILED', 'The page could not be read. Reload it, then choose Read page.');
    }
    const result = results.find(item => item.frameId === 0) ?? (results.length === 1 && results[0].frameId === undefined ? results[0] : null);
    if (result?.error || !result?.result) throw failure('PAGE_READ_FAILED', 'The page changed or could not be read. Click the recruiters.rip toolbar icon, then choose Read page.');
    const { documentToken, ...page } = result.result;
    const boundDocument = firefox ? documentId || documentToken : result.documentId;
    if (!boundDocument) throw failure('PAGE_READ_FAILED', 'The browser could not identify this page. Choose Read page to try again.');
    return { page, documentId: boundDocument };
  };
}

export function preparedPageSender(sender, message, state, firefox = false) {
  return sender.tab?.id === state.tabId && sender.frameId === 0 && !!state.documentId &&
    (firefox ? message.documentToken === state.documentId : sender.documentId === state.documentId);
}
