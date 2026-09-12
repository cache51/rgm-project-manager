/**
 * Server-side ZIP (STORE method — no compression) so a packet can be produced
 * without a dependency. Validated against the real `unzip` tool.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * @param {Array<{name:string, data:Uint8Array}>} files
 * @returns {Uint8Array} a valid .zip archive
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const u16 = (n) => new Uint8Array([n & 255, (n >> 8) & 255]);
  const u32 = (n) => new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]);

  const d = new Date();
  const tm = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dt = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  const local = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nb = enc.encode(f.name);
    const db = f.data instanceof Uint8Array ? f.data : enc.encode(String(f.data));
    const crc = crc32(db);

    const lh = concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(tm), u16(dt),
      u32(crc), u32(db.length), u32(db.length), u16(nb.length), u16(0)
    ]);
    local.push(lh, nb, db);

    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(tm), u16(dt),
      u32(crc), u32(db.length), u32(db.length), u16(nb.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
    ]), nb);

    offset += lh.length + nb.length + db.length;
  }

  const cd = concat(central);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0)
  ]);

  return concat([...local, cd, eocd]);
}
