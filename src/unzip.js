/**
 * Minimal ZIP reader, so the CLI can extract a packet without a dependency.
 * Supports STORE (0) and DEFLATE (8), which is everything our writer and any
 * standard zip tool produce for this use case.
 *
 * Every entry name is returned as-is; it is the caller's job to validate it
 * before touching the filesystem (see packet.js:isSafeRelativePath).
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip archive: no end-of-central-directory record');
}

/**
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer, crc: number, method: number}>}
 */
export function readZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CD_SIG) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== LFH_SIG) {
      throw new Error(`corrupt local header for entry ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported compression method ${method} for entry ${name}`);

    if (data.length !== uncompressedSize) {
      throw new Error(`size mismatch for entry ${name}`);
    }

    entries.push({ name, data, crc, method });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
