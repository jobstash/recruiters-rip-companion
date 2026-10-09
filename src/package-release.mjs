import { build, Platform, Arch } from 'electron-builder';

// This command builds locally; it never publishes. Production distribution needs
// the operator's Developer ID certificate and Apple notarization authorization.
const certificate = Boolean((process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD) || (process.env.CSC_NAME && process.env.CSC_NAME !== '-'));
const notarization = Boolean((process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID));
if (process.platform !== 'darwin' || !certificate || !notarization || process.env.CSC_NAME === '-') {
  process.stderr.write('Release packaging requires macOS, a Developer ID Application certificate (CSC_LINK and CSC_KEY_PASSWORD, or CSC_NAME for a keychain identity), and Apple notarization credentials. Ad-hoc signing is not a notarized release. Use package:adhoc for an explicitly unnotarized production-origin build, or package:local for development.\n');
  process.exitCode = 1;
} else {
  try {
    await build({
      targets: Platform.MAC.createTarget(['zip', 'dmg'], Arch.arm64),
      publish: 'never',
      config: {
        directories: { output: 'dist/release' },
        forceCodeSigning: true,
        mac: { hardenedRuntime: true, notarize: true },
        extraMetadata: { localProduct: false },
      },
    });
  } catch {
    process.stderr.write('Release signing or notarization failed. No release was published.\n');
    process.exitCode = 1;
  }
}
