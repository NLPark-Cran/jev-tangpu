// ZIP (store-only, no compression) writer — dependency-free.
// Used to export the player's take-home skill as a single .zip artifact.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp so exports are reproducible: 2026-01-01 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

function writeU16(v, out) {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}
function writeU32(v, out) {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

/**
 * @param {{path: string, text: string}[]} files
 * @returns {Blob} application/zip
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.path);
    const data = enc.encode(f.text);
    const crc = crc32(data);

    const local = [];
    writeU32(0x04034b50, local);
    writeU16(20, local); // version needed
    writeU16(0x0800, local); // flags: UTF-8 names
    writeU16(0, local); // method: store
    writeU16(DOS_TIME, local);
    writeU16(DOS_DATE, local);
    writeU32(crc, local);
    writeU32(data.length, local);
    writeU32(data.length, local);
    writeU16(name.length, local);
    writeU16(0, local); // extra length
    localParts.push(new Uint8Array(local), name, data);

    const central = [];
    writeU32(0x02014b50, central);
    writeU16(20, central); // version made by
    writeU16(20, central); // version needed
    writeU16(0x0800, central);
    writeU16(0, central);
    writeU16(DOS_TIME, central);
    writeU16(DOS_DATE, central);
    writeU32(crc, central);
    writeU32(data.length, central);
    writeU32(data.length, central);
    writeU16(name.length, central);
    writeU16(0, central); // extra
    writeU16(0, central); // comment
    writeU16(0, central); // disk start
    writeU16(0, central); // internal attrs
    writeU32(0, central); // external attrs
    writeU32(offset, central);
    centralParts.push(new Uint8Array(central), name);

    offset += local.length + name.length + data.length;
  }

  const cdSize = centralParts.reduce((n, p) => n + p.length, 0);
  const eocd = [];
  writeU32(0x06054b50, eocd);
  writeU16(0, eocd);
  writeU16(0, eocd);
  writeU16(files.length, eocd);
  writeU16(files.length, eocd);
  writeU32(cdSize, eocd);
  writeU32(offset, eocd);
  writeU16(0, eocd);

  return new Blob([...localParts, ...centralParts, new Uint8Array(eocd)], {
    type: 'application/zip',
  });
}

export function downloadZip(filename, files) {
  const url = URL.createObjectURL(makeZip(files));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
