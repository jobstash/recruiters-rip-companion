import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { validateMacExecutable } = createRequire(import.meta.url)('../src/update-macho.cjs');
const ARM64 = 0x0100000c, X64 = 0x01000007;
function thin(cpu = ARM64, little = true) {
  const bytes = Buffer.alloc(32);
  const write = (value, offset) => little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  write(0xfeedfacf, 0); write(cpu, 4); write(2, 12);
  return bytes;
}
function universal({ wide = false, little = false, cpus = [X64, ARM64] } = {}) {
  const stride = wide ? 32 : 20, tableEnd = 8 + cpus.length * stride;
  const bytes = Buffer.alloc(tableEnd + cpus.length * 32);
  const write = (value, offset) => little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  const writeWide = (value, offset) => little ? bytes.writeBigUInt64LE(BigInt(value), offset) : bytes.writeBigUInt64BE(BigInt(value), offset);
  write(wide ? 0xcafebabf : 0xcafebabe, 0); write(cpus.length, 4);
  cpus.forEach((cpu, index) => {
    const entry = 8 + index * stride, offset = tableEnd + index * 32;
    write(cpu, entry);
    if (wide) { writeWide(offset, entry + 8); writeWide(32, entry + 16); }
    else { write(offset, entry + 8); write(32, entry + 12); }
    thin(cpu).copy(bytes, offset);
  });
  return bytes;
}
async function fixture(t, bytes) {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-macho-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic-executable');
  await writeFile(file, bytes);
  return file;
}

test('ARM64 thin and bounded FAT/FAT64 executables validate without developer tools', async t => {
  const images = [thin(), thin(ARM64, false), universal(), universal({ little: true }), universal({ wide: true }), universal({ wide: true, little: true })];
  // Exact published 3.10 executable header, observed through bounded ZIP reads.
  images.push(Buffer.from('cffaedfe0c000001000000000200000010000000200400008500200000000000', 'hex'));
  for (const bytes of images) await validateMacExecutable(await fixture(t, bytes));
});

test('architecture validation rejects other architectures, truncated images and forged universal tables', async t => {
  const excessiveCount = universal(); excessiveCount.writeUInt32BE(0xffffffff, 4);
  const forgedSlice = universal(); forgedSlice.writeUInt32LE(X64, forgedSlice.length - 32 + 4);
  const overflow = universal({ wide: true }); overflow.writeBigUInt64BE(0xffffffffffffffffn, 8 + 32 + 8);
  const insideTable = universal(); insideTable.writeUInt32BE(8, 8 + 20 + 8);
  const truncatedSlice = universal(); truncatedSlice.writeUInt32BE(4096, 8 + 20 + 12);
  for (const bytes of [Buffer.alloc(32), thin(X64), thin().subarray(0, 8), universal({ cpus: [X64] }), excessiveCount, forgedSlice, overflow, insideTable, truncatedSlice]) {
    await assert.rejects(validateMacExecutable(await fixture(t, bytes)), { code: 'INVALID_MACHO' });
  }
});

test('architecture validation observes cancellation without invoking a subprocess', async t => {
  const controller = new AbortController();
  controller.abort(new Error('synthetic cancellation'));
  await assert.rejects(validateMacExecutable(await fixture(t, thin()), controller.signal), /synthetic cancellation/);
});
