export function createManifest(identity, version, local = false) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Root package version must be a Chrome numeric version.');
  return {
    manifest_version: 3,
    name: `Recruiters.rip${local ? ' (local)' : ''}`,
    version,
    minimum_chrome_version: '125',
    description: 'Save jobs to Companion and review application values before copying or filling. Never submits applications.',
    key: identity.key,
    permissions: ['nativeMessaging', 'activeTab', 'scripting', 'sidePanel'],
    background: { service_worker: 'background.mjs', type: 'module' },
    action: { default_title: 'Save jobs or review application values', default_icon: 'brand/favicon-32.png' },
    icons: { 32: 'brand/favicon-32.png' },
    side_panel: { default_path: 'panel.html' },
    externally_connectable: { matches: [`${identity.productOrigin}/*`] },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  };
}
