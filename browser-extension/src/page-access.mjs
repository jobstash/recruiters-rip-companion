// The extension action is the user gesture that grants activeTab. Opening
// Chrome's side-panel selector alone is not a grant.
export function createPageAccess({ sidePanel, tabs, scripting, action, onAccess = () => {}, onError }) {
  void sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(onError);
  action?.onClicked.addListener(tab => {
    if (!Number.isInteger(tab.id)) return;
    // open() must run directly in the toolbar gesture, before any await.
    void sidePanel.open({ tabId: tab.id }).then(() => onAccess(tab.id)).catch(onError);
  });
  return async function inject(tabId, func, args = [], documentId = null) {
    if (!Number.isInteger(tabId)) throw new Error('Click the Recruiters.rip toolbar icon on the job or application tab, then try again.');
    const tab = await tabs.get(tabId);
    // Tab metadata can omit URL. Do not confuse redacted metadata with an
    // unsupported page: scripting enforces the grant, and injected functions
    // validate the actual HTTP(S) location before collecting or writing data.
    if (tab.url && !/^https?:\/\//.test(tab.url)) throw new Error('Open a job or application on an HTTP or HTTPS page.');
    let results;
    try { results = await scripting.executeScript({ target: { tabId, ...(documentId ? { documentIds: [documentId] } : {}) }, func, args }); }
    catch (cause) {
      const denied = /cannot access|missing host permission|must request permission|not allowed to access/i.test(cause?.message ?? '');
      throw new Error(documentId ? 'The page changed or Chrome access expired. Inspect the form again.'
        : denied ? 'Page access is not granted. Click the black rr extension icon beside Chrome’s address bar—not Chrome’s side-panel button. It will read this tab automatically.'
          : 'The page could not be inspected. Reload it, then choose Read this page again.');
    }
    if (!results[0]?.result) throw new Error('Chrome could not read this page. Reload it and open this panel again.');
    return { page: results[0].result, documentId: results[0].documentId };
  };
}
