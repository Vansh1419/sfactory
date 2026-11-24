'use strict';

// Grades the zip builder behind the window's Download button (src/renderer/zip.mjs):
//   makeZip(files) -> Uint8Array     files: [{ name, content }] (names and text); the result is a real .zip
//
// Files are stored (not compressed): scripts and notes are small, and stored zips are simple to get exactly right.
// The cases read the bytes back with their own small reader (and, where `unzip` exists, with the system's one).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSubject } = require('../lib');

const SUBJECT = 'src/renderer/zip.mjs';
const zip = () => loadSubject(SUBJECT);
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A deliberately independent reader: finds the end record, walks the central directory, checks every entry. */
function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no end record');
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdStart = v.getUint32(eocd + 16, true);
  let at = cdStart;
  const out = [];
  for (let n = 0; n < count; n += 1) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('bad central entry');
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = v.getUint16(local + 26, true);
    const lExtraLen = v.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + size);
    out.push({ name, flags, method, crcOk: crc32(data) === crc, size, content: new TextDecoder().decode(data) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (at - cdStart !== cdSize || at !== eocd || eocd + 22 !== bytes.length) throw new Error('the end record does not match the directory');
  return out;
}

const cases = [
  {
    id: 'a-zip-holds-every-file-with-its-exact-content-and-a-correct-checksum',
    check() {
      const files = [{ name: 'add.py', content: 'def add(a, b):\n    return a + b\n' }, { name: 'notes.txt', content: 'line one\r\nline two\n\ttabbed' }, { name: 'README.md', content: '# Title\n' }];
      const got = readZip(zip().makeZip(files));
      const ok = got.length === 3 && got.every((g, i) => g.name === files[i].name && g.content === files[i].content && g.crcOk && g.method === 0);
      return verdict(ok, json(got));
    },
  },
  {
    id: 'it-returns-bytes-and-starts-like-a-zip',
    check() {
      const out = zip().makeZip([{ name: 'a.txt', content: 'x' }]);
      return verdict(out instanceof Uint8Array && out[0] === 0x50 && out[1] === 0x4b && out[2] === 3 && out[3] === 4, json(Array.from(out.subarray(0, 4))));
    },
  },
  {
    id: 'names-and-text-with-non-english-characters-survive',
    check() {
      const files = [{ name: 'résumé-数学.txt', content: 'नमस्ते — ₹500 😀' }];
      const [g] = readZip(zip().makeZip(files));
      return verdict(g.name === files[0].name && g.content === files[0].content && g.crcOk && (g.flags & 0x0800) !== 0, json(g));
    },
  },
  {
    id: 'an-empty-file-and-an-empty-list-both-work',
    check() {
      const one = readZip(zip().makeZip([{ name: 'empty.txt', content: '' }]));
      const none = readZip(zip().makeZip([]));
      return verdict(one.length === 1 && one[0].size === 0 && one[0].crcOk && none.length === 0, json({ one, none }));
    },
  },
  {
    id: 'a-large-file-and-many-files-are-intact',
    check() {
      const big = 'abcdefghij\n'.repeat(20000);
      const many = Array.from({ length: 300 }, (_, i) => ({ name: `f${i}.txt`, content: `file ${i}` }));
      const a = readZip(zip().makeZip([{ name: 'big.txt', content: big }]));
      const b = readZip(zip().makeZip(many));
      return verdict(a[0].content === big && a[0].crcOk && b.length === 300 && b.every((g, i) => g.content === `file ${i}` && g.crcOk), `big ${a[0] && a[0].size}, many ${b.length}`);
    },
  },
  {
    id: 'the-same-input-always-gives-the-same-bytes',
    check() {
      const files = [{ name: 'a.txt', content: 'x' }, { name: 'b.txt', content: 'y' }];
      const a = Buffer.from(zip().makeZip(files));
      const b = Buffer.from(zip().makeZip(files));
      return verdict(a.equals(b), 'two builds differed');
    },
  },
  {
    id: 'the-input-is-not-changed',
    check() {
      const files = [{ name: 'a.txt', content: 'x' }];
      const copy = json(files);
      zip().makeZip(files);
      return verdict(json(files) === copy, json(files));
    },
  },
  {
    id: 'odd-input-gives-a-clear-error-or-skips-never-a-broken-zip',
    check() {
      for (const bad of [undefined, null, 5, 'x', [null], [{ name: 5, content: 'x' }], [{ name: 'a', content: 5 }], [{ content: 'x' }]]) {
        let out;
        try {
          out = zip().makeZip(bad);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          continue; // a clear refusal is fine
        }
        try {
          readZip(out); // otherwise it must at least be a valid (possibly empty) zip
        } catch {
          return verdict(false, `broken zip for ${json(bad)}`);
        }
      }
      return verdict(true);
    },
  },
  {
    id: 'the-systems-unzip-accepts-it-and-extracts-the-same-text',
    check() {
      const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0) return verdict(true); // no system unzip on this machine: the cases above still ran
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipcheck-'));
      try {
        const file = path.join(dir, 'x.zip');
        const content = 'def add(a, b):\n    return a + b\n';
        fs.writeFileSync(file, zip().makeZip([{ name: 'add.py', content }, { name: 'b.txt', content: 'two' }]));
        const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
        const out = path.join(dir, 'out');
        spawnSync('unzip', ['-o', file, '-d', out]);
        const same = fs.readFileSync(path.join(out, 'add.py'), 'utf8') === content;
        return verdict(test.status === 0 && same, `${test.stdout} ${test.stderr}`.slice(0, 300));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

module.exports = {
  name: 'zip-file',
  description: 'Zip builder for the Download button: every file intact with correct checksums, non-English text, empty and large inputs, deterministic, and accepted by the system unzip',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
