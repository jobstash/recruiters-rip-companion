// The toolbar gesture grants activeTab; opening the sidebar selector does not.
export function createPageAccess({ sidePanel, sidebarAction, tabs, scripting, action, onAccess = () => {}, onError }) {
  const firefox = !!sidebarAction;
  if (!firefox) void sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(onError);
  action?.onClicked.addListener(tab => {
    if (!Number.isInteger(tab.id)) return;
    // open() must run directly in the toolbar gesture, before any await.
    void (firefox ? sidebarAction.open() : sidePanel.open({ tabId: tab.id })).then(() => onAccess(tab.id)).catch(onError);
  });
  return async function inject(tabId, func, args = [], documentId = null) {
    if (!Number.isInteger(tabId)) throw new Error('Click the Recruiters.rip toolbar icon on the job or application tab, then try again.');
    const tab = await tabs.get(tabId);
    // Tab metadata can omit URL. Do not confuse redacted metadata with an
    // unsupported page: scripting enforces the grant, and injected functions
    // validate the actual HTTP(S) location before collecting or writing data.
    if (tab.url && !/^https?:\/\//.test(tab.url)) throw new Error('Open a job or application on an HTTP or HTTPS page.');
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
      throw new Error(documentId ? 'The page changed or browser access expired. Inspect the form again.'
        : denied ? 'Page access is not granted. Click the Recruiters.rip extension icon beside the address bar—not the browser sidebar button. It will read this tab automatically.'
          : 'The page could not be inspected. Reload it, then choose Read page.');
    }
    const result = results.find(item => item.frameId === 0) ?? (results.length === 1 && results[0].frameId === undefined ? results[0] : null);
    if (result?.error || !result?.result) throw new Error('The page changed or could not be read. Click the toolbar icon to inspect it again.');
    const { documentToken, ...page } = result.result;
    const boundDocument = firefox ? documentId || documentToken : result.documentId;
    if (!boundDocument) throw new Error('The browser did not identify this document. Inspect the page again.');
    return { page, documentId: boundDocument };
  };
}

export function preparedPageSender(sender, message, state, firefox = false) {
  return sender.tab?.id === state.tabId && sender.frameId === 0 && !!state.documentId &&
    (firefox ? message.documentToken === state.documentId : sender.documentId === state.documentId);
}
