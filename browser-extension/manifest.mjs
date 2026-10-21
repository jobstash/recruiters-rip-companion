export function createManifest(identity, version, local = false) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Root package version must be a Chrome numeric version.');
  return {
    manifest_version: 3,
    name: `Recruiters.rip${local ? ' (local)' : ''}`,
    version,
    minimum_chrome_version: '125',
    description: 'Save jobs to Companion, paste prepared application answers with ⌘V, and let your own AI fill or submit only what you approve.',
    key: identity.key,
    permissions: ['nativeMessaging', 'activeTab', 'scripting', 'sidePanel', 'clipboardWrite'],
    background: { service_worker: 'background.mjs', type: 'module' },
    action: { default_title: 'Read this page: jobs or application form', default_icon: 'brand/favicon-32.png' },
    icons: { 32: 'brand/favicon-32.png' },
    side_panel: { default_path: 'panel.html' },
    externally_connectable: { matches: [`${identity.productOrigin}/*`] },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  };
}
