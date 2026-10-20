// Let Chrome open the stable panel from its native toolbar action.
export function createPageAccess({ sidePanel, tabs, scripting, onError }) {
  void sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(onError);
  return async function inject(tabId, func, args = [], documentId = null) {
    if (!Number.isInteger(tabId)) throw new Error('Click the Recruiters.rip toolbar icon on the job or application tab, then try again.');
    const tab = await tabs.get(tabId);
    // Tab metadata can omit URL. Do not confuse redacted metadata with an
    // unsupported page: scripting enforces the grant, and injected functions
    // validate the actual HTTP(S) location before collecting or writing data.
    if (tab.url && !/^https?:\/\//.test(tab.url)) throw new Error('Open a job or application on an HTTP or HTTPS page.');
    let results;
    try { results = await scripting.executeScript({ target: { tabId, ...(documentId ? { documentIds: [documentId] } : {}) }, func, args }); }
    catch {
      throw new Error(documentId ? 'The page changed or Chrome access expired. Inspect the form again.' : 'Chrome could not access this page. Click the Recruiters.rip toolbar icon on this tab, then try again.');
    }
    if (!results[0]?.result) throw new Error('Chrome could not read this page. Reload it and open this panel again.');
    return { page: results[0].result, documentId: results[0].documentId };
  };
}
