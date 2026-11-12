#!/usr/bin/env node
// Commands for a Companion that runs in a container, used from the host as `docker exec <container> companion …`:
//   companion url              print the address that opens Companion in a browser on the host
//   companion browser chrome   print a script the host runs to save the browser extension and connect it to this container
//   companion browser firefox
// The browser script is printed rather than run because only the host can write its browsers' settings:
//   docker exec <container> companion browser chrome | sh
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_IDENTITIES } from './browser-identity.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const usage = 'Usage: companion url | companion browser chrome | companion browser firefox';

export function containerSettings(env = process.env) {
  const port = Number(env.RECRUITERS_COMPANION_WEB_PORT);
  return {
    container: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(env.RECRUITERS_COMPANION_CONTAINER ?? '') ? env.RECRUITERS_COMPANION_CONTAINER : null,
    data: typeof env.RECRUITERS_COMPANION_DATA === 'string' && path.isAbsolute(env.RECRUITERS_COMPANION_DATA) ? env.RECRUITERS_COMPANION_DATA : null,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 43117,
  };
}

/** The script a host runs to use the browser extension with a Companion container. Every value is fixed here;
 *  the host supplies only its own home folder and Docker location. */
export function browserSetupScript({ browser, container, version, launcher, firefoxManifest, extension, identity = BROWSER_IDENTITIES.production }) {
  if (!['chrome', 'firefox'].includes(browser)) throw new Error(usage);
  const firefox = browser === 'firefox', label = firefox ? 'Firefox' : 'Chrome';
  if ([container, version, launcher, firefoxManifest, extension].some(value => typeof value !== 'string' || !value || /[\0\r\n]/.test(value))) throw new Error('Invalid browser setup values.');
  const [manifestStart, manifestEnd] = JSON.stringify({ name: identity.nativeHost, description: 'Recruiters.rip local job and application companion', path: '\0', type: 'stdio',
    ...(firefox ? { allowed_extensions: [identity.firefoxExtensionId] } : { allowed_origins: [`chrome-extension://${identity.extensionId}/`] }) }, null, 2).split('\\u0000');
  const locations = firefox
    ? { darwin: ['"$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"'], linux: ['"$HOME/.mozilla/native-messaging-hosts"'] }
    : { darwin: ['Google/Chrome', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge'].map(name => `"$HOME/Library/Application Support/${name}/NativeMessagingHosts"`),
      linux: ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map(name => `"\${XDG_CONFIG_HOME:-$HOME/.config}/${name}/NativeMessagingHosts"`) };
  const register = names => names.map(name => `    register ${name}`).join('\n');
  return `#!/bin/sh
# Recruiters.rip Companion ${version}: use the ${label} extension with the Companion container ${container}.
# It saves the extension to Downloads and tells ${label} how to reach the container. Run it again after updating the container.
set -eu
container=${quote(container)}
folder="$HOME/Downloads/Recruiters.rip ${label} extension"
home="$HOME/.recruiters-companion/$container"
host="$home/native-host"
firefox_folder="$HOME/.mozilla/native-messaging-hosts"

fail() { printf '%s\\n' "$1" >&2; exit 1; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g")"; }

[ -n "\${HOME:-}" ] || fail 'Your home folder is unknown. Run this from a normal terminal.'
docker=$(command -v docker) || fail 'Docker is not available in this terminal. Open a terminal where the docker command works, then run this again.'
case "$docker" in /*) ;; *) fail 'The docker command could not be located. Run this from a normal terminal.' ;; esac
case "$(uname -s)" in
  Darwin) system=darwin; firefox_folder="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  Linux) system=linux; if grep -qi microsoft /proc/version 2>/dev/null; then fail 'This terminal is Linux inside Windows, which cannot reach your Windows browsers. Use the Windows installer from https://recruiters.rip/downloads for the browser extension.'; fi ;;
  *) fail 'This command works on macOS and Linux. On Windows, use the installer from https://recruiters.rip/downloads for the browser extension.' ;;
esac
"$docker" exec "$container" true >/dev/null 2>&1 || fail "The Companion container $container is not running. Start it, then run this again."

# 1. The extension folder. Only a folder this command saved earlier is ever replaced.
if [ -L "$folder" ] || { [ -e "$folder" ] && [ ! -f "$folder/managed-update.json" ]; }; then
  fail "A \\"Recruiters.rip ${label} extension\\" folder that Companion did not create is already in Downloads. Rename or remove it, then run this again."
fi
mkdir -p "$HOME/Downloads"
staged="$HOME/Downloads/.Recruiters.rip ${label} extension.$$.tmp"
rm -rf "$staged"
trap 'rm -rf "$staged"' EXIT
"$docker" cp "$container:"${quote(`${extension}/.`)} "$staged" >/dev/null
[ -f "$staged/manifest.json" ] || fail 'The extension could not be copied from the container. Rebuild the container, then run this again.'
printf '%s' ${quote(JSON.stringify({ version }))} > "$staged/managed-update.json"
rm -rf "$folder"
mv "$staged" "$folder"

# 2. The connection: ${label} starts this file, which reaches Companion inside the container.
# Firefox names its own settings file when it starts the file; the container knows that file by another path.
mkdir -p "$home"
chmod 700 "$HOME/.recruiters-companion" "$home"
{
  printf '%s\\n' '#!/bin/sh'
  printf '%s\\n' "# Connects the recruiters.rip browser extensions to the Companion container $container."
  printf '%s\\n' "# Written by: docker exec $container companion browser ${browser} | sh"
  printf 'if [ "$#" -eq 2 ] && [ "$1" = %s ]; then set -- %s "$2"; fi\\n' "$(quote "$firefox_folder/${identity.nativeHost}.json")" ${quote(quote(firefoxManifest))}
  printf 'exec %s exec -i %s %s "$@"\\n' "$(quote "$docker")" "$(quote "$container")" ${quote(quote(launcher))}
} > "$host"
chmod 700 "$host"

json_host=$(printf '%s' "$host" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
register() {
  mkdir -p "$1"
  { printf '%s' ${quote(manifestStart)}; printf '%s' "$json_host"; printf '%s\\n' ${quote(manifestEnd)}; } > "$1/${identity.nativeHost}.json"
  chmod 600 "$1/${identity.nativeHost}.json"
}
if [ "$system" = darwin ]; then
${register(locations.darwin)}
else
${register(locations.linux)}
fi

printf '%s\\n' "Saved: $folder" "${label} can now reach the Companion container $container."
printf '%s\\n' ${quote(firefox ? 'Next: open about:debugging#/runtime/this-firefox in Firefox, choose Load Temporary Add-on and select manifest.json in that folder.'
    : 'Next: open chrome://extensions in Chrome, turn on Developer mode, choose Load unpacked and select that folder.')}
`;
}

async function main(argv, env) {
  const { container, data, port } = containerSettings(env);
  if (!container || !data) throw new Error('These commands work inside the Companion container: docker exec <container> companion …');
  const [command, argument] = argv;
  const read = async (filename, starting) => {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch { throw new Error(starting); }
  };
  if (command === 'url' && argument === undefined) {
    const { token } = await read(path.join(data, 'web-shell', 'access.json'), 'Companion is still starting. Try again in a few seconds.');
    return `http://127.0.0.1:${port}/#access=${token}\n`;
  }
  if (command === 'browser' && ['chrome', 'firefox'].includes(argument)) {
    const directory = path.join(data, 'device');
    const native = await read(path.join(directory, 'native-config.json'), 'Companion is still starting. Try again in a few seconds.');
    const { version } = await read(path.join(root, 'package.json'), 'The Companion files are incomplete. Rebuild the container.');
    return browserSetupScript({ browser: argument, container, version, launcher: path.join(directory, 'recruiters-native-host'),
      firefoxManifest: native.firefoxManifest, extension: path.join(root, 'browser-extension', 'dist', argument === 'firefox' ? 'firefox-production' : 'production') });
  }
  throw new Error(usage);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(await main(process.argv.slice(2), process.env)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
