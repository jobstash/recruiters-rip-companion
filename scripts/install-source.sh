#!/bin/sh
# Inspectable bootstrap. No sudo, global packages, security-policy changes or app binaries.
set -eu
umask 077
command -v git >/dev/null 2>&1 || { printf '%s\n' 'Install Git, then run this command again.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Install Node.js 24 (including npm), then run this command again.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' 'npm is missing. Install Node.js 24 including npm.' >&2; exit 1; }
node -e 'if (!/^24\./.test(process.versions.node)) { console.error("Source installation requires Node.js 24."); process.exit(1); }'
checkout=''
commit=''
expect=''
for argument in "$@"; do
  if [ "$expect" = checkout ]; then checkout=$argument; expect=''; continue; fi
  if [ "$expect" = commit ]; then commit=$argument; expect=''; continue; fi
  if [ "$argument" = '--checkout' ]; then expect=checkout; fi
  if [ "$argument" = '--commit' ]; then expect=commit; fi
done
if [ -n "$checkout" ]; then
  # Validate before executing any candidate script, then validate again inside it.
  [ -n "$commit" ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$commit" ] || { printf '%s\n' 'A local checkout requires its exact --commit.' >&2; exit 1; }
  [ -z "$(git -C "$checkout" status --porcelain=v1 --untracked-files=all)" ] || { printf '%s\n' 'The explicit local checkout must be clean.' >&2; exit 1; }
  exec node "$checkout/scripts/install-source.mjs" "$@"
fi
command -v curl >/dev/null 2>&1 || { printf '%s\n' 'curl is required to fetch the public source installer.' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/recruiters-source.XXXXXXXX")
trap 'rm -f "$work/install-source.mjs" "$work/SHA256SUMS.txt"; rmdir "$work"' EXIT HUP INT TERM
base='https://github.com/jobstash/recruiters-rip-companion/releases/latest/download'
curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 20 --max-time 120 --max-filesize 1048576 "$base/install-source.mjs" -o "$work/install-source.mjs"
curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 20 --max-time 120 --max-filesize 1048576 "$base/SHA256SUMS.txt" -o "$work/SHA256SUMS.txt"
node --input-type=module - "$work" <<'NODE'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = process.argv[2];
const matches = readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/).filter(line => /^[a-f0-9]{64}  install-source\.mjs$/.test(line));
if (matches.length !== 1 || createHash('sha256').update(readFileSync(path.join(root, 'install-source.mjs'))).digest('hex') !== matches[0].slice(0, 64)) throw new Error('The source bootstrap checksum did not match the official release. Retry after publication completes.');
NODE
node "$work/install-source.mjs" "$@"
