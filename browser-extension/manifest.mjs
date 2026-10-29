export function createManifest(identity, version, local = false, browser = 'chrome') {
  if (!['chrome', 'firefox'].includes(browser)) throw new Error('Browser must be chrome or firefox.');
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Root package version must be a numeric extension version.');
  const firefox = browser === 'firefox';
  if (firefox && !identity.firefoxExtensionId) throw new Error('Firefox add-on identity is required.');
  return {
    manifest_version: 3,
    name: `Recruiters.rip${local ? ' (local)' : ''}`,
    version,
    description: 'Save jobs to Companion and prepare application answers for native paste. Your own AI fills forms or submits only when you ask.',
    permissions: ['nativeMessaging', 'activeTab', 'scripting', ...(!firefox ? ['sidePanel'] : []), 'clipboardWrite'],
    background: firefox ? { scripts: ['background.mjs'], type: 'module' } : { service_worker: 'background.mjs', type: 'module' },
    action: { default_title: 'Read this page: jobs or application form', default_icon: 'brand/favicon-32.png' },
    icons: { 32: 'brand/favicon-32.png' },
    ...(firefox ? {
      browser_specific_settings: { gecko: {
        id: identity.firefoxExtensionId,
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['websiteContent', 'personallyIdentifyingInfo'] },
      } },
      sidebar_action: { default_panel: 'panel.html', default_title: 'Recruiters.rip', default_icon: 'brand/favicon-32.png', open_at_install: false },
    } : {
      minimum_chrome_version: '125',
      key: identity.key,
      side_panel: { default_path: 'panel.html' },
      externally_connectable: { matches: [`${identity.productOrigin}/*`] },
    }),
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  };
}
