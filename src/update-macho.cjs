'use strict';
const { constants } = require('node:fs');
const { open } = require(process.versions.electron ? 'original-fs' : 'node:fs').promises;

const ARM64 = 0x0100000c;
const INVALID = () => Object.assign(new Error('The executable is not a valid ARM64 Mach-O image.'), { code: 'INVALID_MACHO' });

// Architecture validation must not require Xcode or Command Line Tools on a
// user's Mac. Read only fixed headers and a bounded universal-binary table;
// codesign remains responsible for the complete bundle's signature integrity.
async function validateMacExecutable(file, signal) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 32) throw INVALID();
    const read = async (offset, length) => {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > stat.size) throw INVALID();
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, offset)).bytesRead !== length) throw INVALID();
      signal?.throwIfAborted();
      return bytes;
    };
    const arm64Slice = bytes => {
      const magic = bytes.readUInt32LE(0);
      if (magic === 0xfeedfacf) return bytes.readUInt32LE(4) === ARM64;
      if (magic === 0xcffaedfe) return bytes.readUInt32BE(4) === ARM64;
      return false;
    };
    const header = await read(0, 32);
    if (arm64Slice(header)) return;
    const magic = header.readUInt32BE(0);
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) throw INVALID();
    const u32 = (bytes, offset) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const u64 = (bytes, offset) => little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
    const count = u32(header, 4), stride = wide ? 32 : 20;
    if (count < 1 || count > 32) throw INVALID();
    const tableEnd = 8 + count * stride;
    const table = await read(8, count * stride);
    let found = false;
    for (let index = 0; index < count; index++) {
      const entry = index * stride;
      const offset = wide ? u64(table, entry + 8) : BigInt(u32(table, entry + 8));
      const size = wide ? u64(table, entry + 16) : BigInt(u32(table, entry + 12));
      if (offset < BigInt(tableEnd) || size < 32n || offset + size > BigInt(stat.size)) throw INVALID();
      if (u32(table, entry) !== ARM64) continue;
      if (!arm64Slice(await read(Number(offset), 32))) throw INVALID();
      found = true;
    }
    if (!found) throw INVALID();
  } finally { await handle.close(); }
}

module.exports = { validateMacExecutable };
