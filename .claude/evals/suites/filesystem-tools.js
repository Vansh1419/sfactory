'use strict';

// Grades the Filesystem tools (PLAN.md step 1.10: "Filesystem, limited to the project folder"):
//   src/runtime/tools/filesystem.js   createFilesystemTools({ root }) -> [tool, tool]  (the loader's tool shape)
//
//   filesystem.read_file       { path }  -> { text }   the text of one file inside the folder
//   filesystem.list_directory  { path }  -> { text }   the names inside one folder ("." is the folder itself)
//
// Both are read-only. `path` is RELATIVE to the folder. What the tools promise (each is a case below):
//   - anything that leads outside the folder is refused: "..", absolute paths, a sibling folder whose name starts
//     the same, and a symlink inside the folder that points outside (checked after links are followed)
//   - files that hold secrets or are not the project's own are never read or listed, whatever the letter case:
//     .env files, .git, node_modules, keys and credentials
//   - only text: binary files and very large files are refused; long text is cut and says so
//   - nothing in an error ever shows the folder's real path or the system's error text
//
// The suite builds its own temporary folder (with a sibling folder, an outside folder and links) when its cases are
// listed, and removes it when the process exits.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/tools/filesystem.js';
const LOADER = 'src/runtime/tools/index.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

let base;
let root;
const write = (rel, content = 'x') => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

function setup() {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-tools-')));
  process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
  root = path.join(base, 'root');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'outside'));
  fs.mkdirSync(path.join(base, 'root-evil'));
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'OUTSIDE');
  fs.writeFileSync(path.join(base, 'root-evil', 'secret.txt'), 'SIBLING');
  write('README.md', '# Project\nHello\n');
  write('src/app.js', 'console.log("hi");\n');
  write('src/deep/er/file.txt', 'deep');
  write('.env', 'SECRET=hunter2');
  write('.env.local', 'SECRET=hunter3');
  write('sub/.env', 'SECRET=hunter4');
  write('.git/config', '[core]');
  write('node_modules/pkg/index.js', 'x');
  write('server.pem', '-----BEGIN-----');
  write('id_rsa', 'KEY');
  write('credentials.json', '{"k":1}');
  write('blob.bin', Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04, 0x00, 0xff]));
  write('big.txt', 'a'.repeat(300_000));
  write('long.txt', `START${'b'.repeat(50_000)}`);
  write('empty.txt', '');
  fs.symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(root, 'link-out.txt'));
  fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'dir-out'));
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'link-env.txt'));
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'link-in.md'));
}

const tools = (over = {}) => loadSubject(SUBJECT).createFilesystemTools({ root, ...over });
const find = (name, over) => tools(over).find((t) => t.name === name);

/** Runs a tool the way the app does: through the loader. */
async function call(name, args, over) {
  const loader = loadSubject(LOADER).createToolLoader({ tools: tools(over), hasRule: async () => true });
  await loader.load();
  try {
    const out = await loader.run({ action: { tool: name, access: 'read', args }, key: 'k' });
    return { ok: true, text: out.text };
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return { ok: false, message: err.message };
  }
}
const read = (p, over) => call('filesystem.read_file', { path: p }, over);
const list = (p, over) => call('filesystem.list_directory', { path: p }, over);

/** Runs the tool directly, to read its own error text (the loader would hide it). */
async function directError(name, args, over) {
  try {
    await find(name, over).run({ args, key: 'k' });
    return null;
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return err;
  }
}

const cases = [
  // ---- The tools as tools --------------------------------------------------------------------------
  {
    id: 'both-tools-are-read-only-with-a-summary-and-a-policy-rule',
    check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const t = tools();
      const names = t.map((x) => x.name).sort().join();
      const ok = names === 'filesystem.list_directory,filesystem.read_file' && t.every((x) => x.access === 'read' && x.summary.length > 10 && x.args.includes('path') && policy.isBuiltIn(x.name) && policy.checkAction({ tool: x.name, access: 'read', args: { path: 'a' } }).allowed === true);
      return verdict(ok, names);
    },
  },
  {
    id: 'without-a-folder-no-tools-are-made',
    check() {
      const none = [undefined, null, '', 5, {}, 'relative/folder'].map((r) => loadSubject(SUBJECT).createFilesystemTools({ root: r }).length);
      return verdict(none.every((n) => n === 0) && loadSubject(SUBJECT).createFilesystemTools().length === 0, json(none));
    },
  },
  {
    id: 'a-folder-that-does-not-exist-never-reads-anything-else',
    async check() {
      // package.json exists in the folder the eval runs from, so a fall-back to the current folder would be seen.
      const r = await read('package.json', { root: path.join(base, 'no-such-folder') });
      const l = await list('.', { root: path.join(base, 'no-such-folder') });
      return verdict(r.ok === false && l.ok === false, json({ r, l }));
    },
  },
  {
    id: 'arguments-must-be-one-plain-relative-path',
    check() {
      const t = find('filesystem.read_file');
      const good = ['README.md', 'src/app.js', '.', 'a b/c d.txt'].map((p) => t.checkArgs({ path: p }));
      const bad = [{}, { path: '' }, { path: '   ' }, { path: 5 }, { path: null }, { path: ['a'] }, { path: 'a\u0000b' }, { path: 'x'.repeat(501) }, { path: 'a', extra: 1 }, null, 'a', ['a']];
      const problems = bad.map((a) => t.checkArgs(a));
      return verdict(good.every((g) => g === null) && problems.every((p) => typeof p === 'string' && p.length > 0), json({ good, problems }));
    },
  },

  // ---- Reading inside the folder -------------------------------------------------------------------
  {
    id: 'a-file-inside-the-folder-is-read-exactly',
    async check() {
      const a = await read('README.md');
      const b = await read('src/deep/er/file.txt');
      const c = await read('./src/../src/app.js');
      const d = await read('empty.txt');
      return verdict(a.ok && a.text === '# Project\nHello\n' && b.ok && b.text === 'deep' && c.ok && c.text.includes('console.log') && d.ok && d.text === '', json({ a, b, c, d }));
    },
  },
  {
    id: 'a-link-that-stays-inside-the-folder-is-fine',
    async check() {
      const r = await read('link-in.md');
      return verdict(r.ok && r.text === '# Project\nHello\n', json(r));
    },
  },
  {
    id: 'long-text-is-cut-and-says-so',
    async check() {
      const r = await read('long.txt');
      return verdict(r.ok && r.text.startsWith('START') && r.text.length < 25_000 && /cut|shortened|larger/i.test(r.text.slice(-200)), `length ${r.text && r.text.length}`);
    },
  },
  {
    id: 'a-very-large-file-is-refused-not-loaded',
    async check() {
      const r = await read('big.txt');
      return verdict(r.ok === false, json({ ok: r.ok, length: r.text && r.text.length }));
    },
  },
  {
    id: 'a-binary-file-is-refused',
    async check() {
      const r = await read('blob.bin');
      return verdict(r.ok === false, json(r));
    },
  },
  {
    id: 'a-folder-cannot-be-read-as-a-file-and-a-file-cannot-be-listed',
    async check() {
      const a = await read('src');
      const b = await list('README.md');
      return verdict(a.ok === false && b.ok === false, json({ a, b }));
    },
  },

  // ---- Staying inside the folder -------------------------------------------------------------------
  {
    id: 'paths-that-lead-outside-the-folder-are-refused',
    async check() {
      const attempts = ['../outside/secret.txt', 'src/../../outside/secret.txt', '../../etc/passwd', path.join(base, 'outside', 'secret.txt'), '/etc/passwd', '..', '../', 'src/../..', '..\\outside\\secret.txt', '~/secret', 'C:\\Windows\\win.ini'];
      for (const p of attempts) {
        const r = await read(p);
        if (r.ok) return verdict(false, `read ${json(p)}: ${json(r.text).slice(0, 80)}`);
        const l = await list(p);
        if (l.ok) return verdict(false, `listed ${json(p)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'an-absolute-path-is-refused-even-when-it-points-inside-the-folder',
    async check() {
      const inside = path.join(root, 'README.md');
      const r = await read(inside);
      const l = await list(root);
      return verdict(r.ok === false && l.ok === false, json({ r, l }));
    },
  },
  {
    id: 'a-sibling-folder-with-the-same-start-of-name-is-outside',
    async check() {
      const r = await read('../root-evil/secret.txt');
      const l = await list('../root-evil');
      return verdict(r.ok === false && l.ok === false, json({ r, l }));
    },
  },
  {
    id: 'a-link-inside-the-folder-that-points-outside-is-refused',
    async check() {
      const file = await read('link-out.txt');
      const viaDir = await read('dir-out/secret.txt');
      const dir = await list('dir-out');
      return verdict(file.ok === false && viaDir.ok === false && dir.ok === false && !json([file, viaDir, dir]).includes('OUTSIDE'), json({ file, viaDir, dir }));
    },
  },

  // ---- Secrets and files that are not the project's -----------------------------------------------
  {
    id: 'secret-files-and-tool-folders-are-never-read',
    async check() {
      const names = ['.env', '.env.local', 'sub/.env', '.git/config', 'node_modules/pkg/index.js', 'server.pem', 'id_rsa', 'credentials.json', 'link-env.txt', './.env', 'src/../.env'];
      for (const p of names) {
        const r = await read(p);
        if (r.ok) return verdict(false, `read ${p}: ${json(r.text).slice(0, 60)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'the-same-names-in-other-letter-case-are-refused-too',
    async check() {
      for (const p of ['.ENV', '.Env.Local', '.GIT/config', 'Node_Modules/pkg/index.js', 'SERVER.PEM', 'ID_RSA', 'Credentials.JSON']) {
        const r = await read(p);
        if (r.ok) return verdict(false, `read ${p}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-listing-shows-folders-and-files-sorted-and-hides-secrets',
    async check() {
      const r = await list('.');
      const names = r.ok ? r.text.split('\n').map((l) => l.trim()).filter(Boolean) : [];
      const shown = names.join('|');
      const hidden = ['.env', '.git', 'node_modules', 'server.pem', 'id_rsa', 'credentials.json', 'link-env.txt', 'link-out.txt', 'dir-out'].filter((n) => names.some((x) => x === n || x === `${n}/`));
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      return verdict(r.ok && names.includes('src/') && names.includes('README.md') && !names.includes('src') && hidden.length === 0 && json(names) === json(sorted), json({ shown, hidden }));
    },
  },
  {
    id: 'a-folder-inside-the-folder-can-be-listed-and-a-hidden-one-cannot',
    async check() {
      const ok = await list('src');
      const deep = await list('src/deep');
      const git = await list('.git');
      const nm = await list('node_modules');
      return verdict(ok.ok && ok.text.includes('app.js') && ok.text.includes('deep/') && deep.ok && deep.text.includes('er/') && git.ok === false && nm.ok === false, json({ ok, deep, git, nm }));
    },
  },
  {
    id: 'a-huge-folder-listing-is-capped-and-says-so',
    async check() {
      for (let i = 0; i < 260; i += 1) write(`many/f${String(i).padStart(3, '0')}.txt`, '');
      const r = await list('many');
      const lines = r.ok ? r.text.split('\n').filter(Boolean) : [];
      return verdict(r.ok && lines.length <= 205 && /more|cut|first/i.test(r.text), `lines ${lines.length}`);
    },
  },

  // ---- Errors ----------------------------------------------------------------------------------
  {
    id: 'errors-never-show-the-real-path-or-the-systems-error-text',
    async check() {
      const tries = [
        ['filesystem.read_file', { path: 'no-such-file.txt' }],
        ['filesystem.read_file', { path: '../outside/secret.txt' }],
        ['filesystem.read_file', { path: '.env' }],
        ['filesystem.read_file', { path: 'src' }],
        ['filesystem.list_directory', { path: 'nope' }],
        ['filesystem.read_file', { path: 'link-out.txt' }],
      ];
      for (const [name, args] of tries) {
        const err = await directError(name, args);
        if (!err) return verdict(false, `no error for ${name} ${json(args)}`);
        const shown = `${err.message}\n${err.stack}`;
        if (shown.includes(base) || shown.includes(root) || /ENOENT|EACCES|ENOTDIR|EISDIR|errno|syscall/i.test(err.message)) return verdict(false, `leaked: ${err.message}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'the-tools-never-change-anything-in-the-folder',
    async check() {
      const snapshot = () => json(fs.readdirSync(root, { recursive: true }).sort().map((n) => [n, fs.lstatSync(path.join(root, n)).size]));
      const before = snapshot();
      await read('README.md');
      await read('../outside/secret.txt');
      await list('.');
      await list('src');
      return verdict(snapshot() === before, 'the folder changed');
    },
  },
];

module.exports = {
  name: 'filesystem-tools',
  description: 'Filesystem tools: read a file or list a folder only inside the project folder; refuse "..", absolute paths, sibling folders and links that point outside; never read secrets or tool folders; text only; no path or system error text in errors',
  threshold: 1,
  cases: () => {
    if (!base) setup();
    return cases;
  },
  run: (c) => c.check(),
};
