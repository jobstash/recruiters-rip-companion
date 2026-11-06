import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/smoke-source-update.mjs', import.meta.url), 'utf8');
const quoteDefinition = source.split('\n').find(line => line.trim().startsWith('const quote = value =>') && line.includes('FromBase64String'));
assert.ok(quoteDefinition);
const quote = vm.runInNewContext(`${quoteDefinition}\nquote`, { Buffer });
const values = ["C:\\fixture's folder\\source", 'C:\\smart\u2018quote\u2019\\file', 'C:\\double\u201cquote\u201d\\file', 'literal $variable `tick ; (parenthesis) \nline'];

test('source smoke PowerShell arguments contain only a base64 data literal', () => {
  for (const value of values) {
    const expression = quote(value);
    const encoded = expression.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
    assert.ok(encoded);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), value);
    assert.equal(expression.includes(value), false);
  }
});

test('Windows PowerShell and PowerShell 7 preserve smart quotes and metacharacters as data', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; @(${values.map(quote).join(',')}) | ConvertTo-Json -Compress`;
  for (const executable of [powershell, 'pwsh']) {
    const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000 });
    assert.deepEqual(JSON.parse(stdout), values);
  }
});
