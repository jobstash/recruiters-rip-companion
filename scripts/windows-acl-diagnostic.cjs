'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runtime = require(path.join(process.cwd(), 'src/platform-runtime.cjs'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-acl-diagnostic-'));
let call;
runtime.protectPrivatePath(directory, { platform: 'win32', directory: true, run(executable, args, options) { call = { executable, args, options }; } });
const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
const marked = "[Console]::Error.WriteLine('entered');" + script
  .replace('$a=Get-Acl -LiteralPath $p;', "$a=Get-Acl -LiteralPath $p;[Console]::Error.WriteLine('acl-read');")
  .replace('$a.SetAccessRuleProtection', "[Console]::Error.WriteLine('protect-start');$a.SetAccessRuleProtection")
  .replace('Set-Acl -LiteralPath $p -AclObject $a;', "[Console]::Error.WriteLine('set-start');Set-Acl -LiteralPath $p -AclObject $a;[Console]::Error.WriteLine('set-done');")
  + ";[Console]::Error.WriteLine('finished');exit 0";
for (const [label, source, env, stdio, input] of [
  ['simple-clean-env', "[Console]::Out.WriteLine('ready');exit 0", call.options.env, ['ignore', 'pipe', 'pipe'], undefined],
  ['acl-clean-env-stdin-ignored', marked, call.options.env, ['ignore', 'pipe', 'pipe'], undefined],
  ['acl-full-env-stdin-ignored', marked, process.env, ['ignore', 'pipe', 'pipe'], undefined],
  ['acl-clean-env-explicit-eof', marked, call.options.env, 'pipe', ''],
]) {
  const args = [...call.args.slice(0, -1), Buffer.from(source, 'utf16le').toString('base64')];
  const started = Date.now();
  const result = spawnSync(call.executable, args, { env, stdio, input, windowsHide: true, timeout: 10000, encoding: 'utf8' });
  console.log(JSON.stringify({ label, elapsed: Date.now()-started, status: result.status, error: result.error?.code, stdout: result.stdout, stderr: result.stderr }));
}
fs.rmSync(directory, { recursive: true, force: true });
