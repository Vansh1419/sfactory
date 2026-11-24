// Builds a .zip for the Goals panel's Download button. Graded by the `zip-file` eval. Plain functions: no React,
// no `window`. Files are stored, not compressed: scripts and notes are small, and a stored zip is simple to get
// exactly right. The same input always gives the same bytes (the stamp on every file is a fixed date).

const MAX_FILES = 65_535;
const MAX_BYTES = 0xffffffff;
const UTF8_FLAG = 0x0800; // names are UTF-8
const VERSION = 20;
const FIXED_DOS_DATE = 0x0021; // 1980-01-01, the earliest date a zip can hold
const FIXED_DOS_TIME = 0;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{ name: string, content: string }[]} files @returns {Uint8Array} */
export function makeZip(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new TypeError('A list of files is needed.');
  const encoder = new TextEncoder();
  const entries = files.map((file) => {
    if (file === null || typeof file !== 'object' || typeof file.name !== 'string' || typeof file.content !== 'string') {
      throw new TypeError('Each file needs a name and text content.');
    }
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    return { name, data, crc: crc32(data) };
  });

  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const total = localSize + centralSize + 22;
  if (total > MAX_BYTES) throw new RangeError('The files are too large for one zip.');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v) => { view.setUint32(at, v, true); at += 4; };
  const bytes = (b) => { out.set(b, at); at += b.length; };

  const offsets = [];
  for (const e of entries) {
    offsets.push(at);
    u32(0x04034b50); u16(VERSION); u16(UTF8_FLAG); u16(0); u16(FIXED_DOS_TIME); u16(FIXED_DOS_DATE);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0);
    bytes(e.name); bytes(e.data);
  }
  const centralStart = at;
  entries.forEach((e, i) => {
    u32(0x02014b50); u16(VERSION); u16(VERSION); u16(UTF8_FLAG); u16(0); u16(FIXED_DOS_TIME); u16(FIXED_DOS_DATE);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(offsets[i]);
    bytes(e.name);
  });
  const centralBytes = at - centralStart; // measured before the end record moves `at`
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length); u32(centralBytes); u32(centralStart); u16(0);
  return out;
}
