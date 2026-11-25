'use strict';

// Grades the project view's files panel (PLAN.md step 3.6). "Done when: an edit is committed with history, and an agent write to a locked file is refused."
//   src/runtime/pods/files.js          createPodFiles({ store?, audit, podFolder, isBlocked?, emit?, now?, lockMinutes? })
//     .tree({ podId })                         -> { files: [{ path, size }], truncated }          the project's files, read from its folder
//     .read({ podId, path })                   -> { path, content, locked }
//     .history({ podId, path?, limit? })       -> { commits: [{ id, author, date, message }] }    read from the project's git history
//     .beginEdit({ podId, path })              -> { path, expiresAt }                             the founder opens a file: agents are locked out of it
//     .endEdit({ podId, path })                -> { released }                                    the founder closes it without saving
//     .save({ podId, path, content, message? })-> { path, commit }                                writes, commits, unlocks and tells agents to reload
//     .upload({ podId, path, content })        -> { path, commit }                                a NEW file, committed
//     .isLocked({ podId, path })               -> boolean                                         what the agent's write tool asks
//     errors are PodFilesError with a `code` and a plain sentence
//   src/runtime/tools/pod-files.js     createPodFileTools({ podFolder, isLocked? }): `pod.write_file` is refused for a file the founder has open
//   src/runtime/commands.js            files.pods, files.tree, files.read, files.history, files.beginEdit, files.endEdit, files.save, files.upload
//   src/preload.js                     window.api.files.*
//   src/renderer/files.mjs             treeView, historyView, shouldRefetch (the logic behind FilesPanel.jsx)
//
// Runs against a REAL Postgres with the migrations and REAL git in three real pods (shared with `engineering-tools`).
//
//   - the done-when: a saved edit is a real commit by the founder with history that shows it, and an agent's write to a file the founder has open is
//     refused (and works again once the founder has saved or closed it); the lock is for that pod and that file only
//   - a save needs the lock for an existing file, a lock runs out, and a new file is added with `upload`, never over an existing one
//   - nothing outside the pod's folder, no secret file name, no link, no `.git`, no key-looking text and no binary file is ever read or written
//   - a save commits only the file saved (never what an agent left uncommitted); two saves at the same moment both land
//   - everything is audited before it is done; when it cannot be audited, the runtime is blocked or the history cannot record it, nothing changes
//   - the window's commands check their arguments, never put a file's words in the audit log, and the panel shows text only, with no timer

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');
const { buildWorld, tempDir } = require('../engineering-world');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const RANDOM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const NOW = new Date('2026-11-25T12:00:00.000Z');

async function world() {
  const w = await buildWorld('podfiles');
  const { createPodFiles } = loadSubject('src/runtime/pods/files.js');
  const { createPodFileTools } = loadSubject('src/runtime/tools/pod-files.js');
  const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
  const events = [];
  let clock = NOW;
  const make = (over = {}) => createPodFiles({ store: w.store, audit: w.audit, podFolder: (id) => w.pods.folderFor(id), emit: (type, data) => events.push({ type, data }), now: () => clock, ...over });
  const files = make();
  const loaderFor = async (service) => {
    const loader = createToolLoader({ tools: createPodFileTools({ podFolder: (id) => w.pods.folderFor(id), isLocked: (q) => service.isLocked(q) }), hasRule: async (tool) => w.policy.isBuiltIn(tool) });
    await loader.load();
    return loader;
  };
  const agentWrite = async (loader, podId, file, content) => {
    try {
      const out = await loader.run({ action: { tool: 'pod.write_file', access: 'write', args: { path: file, content } }, key: 'k', context: { team: 'product_engineering', agent: 'Dev', podId } });
      return { ok: true, text: out.text ?? '' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
  const fail = async (promise) => {
    try {
      await promise;
      return null;
    } catch (err) {
      return { code: err.code, message: String(err.message), name: err.name };
    }
  };
  const logOf = (folder, n = 5) => w.git(folder, 'log', `-n${n}`, '--format=%an|%s');
  return { w, files, make, events, loaderFor, agentWrite, fail, logOf, setClock: (d) => { clock = d; }, A: w.A, B: w.B, C: w.C };
}

const cases = [
  {
    id: 'a-tree-lists-the-pods-own-files-and-never-secrets-history-or-links',
    async run() {
      const x = await world();
      const dir = x.A.folder;
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs', 'tree-notes.md'), '# notes\n');
      fs.writeFileSync(path.join(dir, '.env'), 'SECRET=ALPHA-KEY\n');
      fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x');
      try { fs.symlinkSync(path.join(x.B.folder, 'app.js'), path.join(dir, 'tree-link.js')); } catch { /* links may be refused on this machine */ }
      const { files } = await x.files.tree({ podId: x.A.podId });
      const paths = files.map((f) => f.path);
      const bad = paths.filter((p) => /(^|\/)(\.env|\.git|node_modules)(\/|$)/.test(p) || p === 'tree-link.js' || /BETA/.test(p));
      const sorted = [...paths].sort();
      const sizes = files.every((f) => Number.isInteger(f.size) && f.size >= 0);
      const other = (await x.files.tree({ podId: x.B.podId })).files.map((f) => f.path);
      return verdict(paths.includes('app.js') && paths.includes('docs/tree-notes.md') && bad.length === 0 && json(paths) === json(sorted) && sizes && other.includes('app.js') && !other.includes('docs/tree-notes.md'),
        `tree gave ${json(paths)}; wrongly present: ${json(bad)}; sorted ${json(paths) === json(sorted)}; other pod ${json(other)}`);
    },
  },
  {
    id: 'b-read-gives-the-text-and-refuses-anything-outside-secret-linked-or-binary',
    async run() {
      const x = await world();
      const dir = x.A.folder;
      fs.writeFileSync(path.join(dir, '.env'), 'SECRET=ALPHA-KEY\n');
      fs.writeFileSync(path.join(dir, 'read-binary.bin'), Buffer.from([1, 2, 0, 3, 255]));
      try { fs.symlinkSync(path.join(x.B.folder, 'app.js'), path.join(dir, 'read-link.js')); } catch { /* ignore */ }
      const ok = await x.files.read({ podId: x.A.podId, path: 'app.js' });
      const bads = ['../' + path.basename(x.B.folder) + '/app.js', path.join(x.B.folder, 'app.js'), '/etc/hosts', '~/x', '.env', '.git/config', 'node_modules/x', 'read-binary.bin', 'read-link.js', 'missing.txt', 'docs', '', 'a\u0000b', 'x'.repeat(400)];
      const notPlain = [];
      for (const p of bads) {
        const err = await x.fail(x.files.read({ podId: x.A.podId, path: p }));
        if (!err || err.name !== 'PodFilesError' || /\/Users\/|\/private\/|ENOENT|EACCES/.test(err.message)) notPlain.push(`${JSON.stringify(p).slice(0, 40)} -> ${json(err)}`);
      }
      const wrongPod = [await x.fail(x.files.read({ podId: RANDOM_ID, path: 'app.js' })), await x.fail(x.files.read({ podId: 'not-an-id', path: 'app.js' }))];
      return verdict(/ALPHA-APP/.test(ok.content) && ok.path === 'app.js' && ok.locked === false && !/BETA/.test(ok.content) && notPlain.length === 0 && wrongPod.every((e) => e && e.code),
        `read gave ${json(ok)}; not refused as plain errors: ${json(notPlain)}; unknown pods: ${json(wrongPod)}`);
    },
  },
  {
    id: 'c-history-comes-from-the-projects-own-git-log-for-the-whole-project-or-one-file',
    async run() {
      const x = await world();
      const dir = x.A.folder;
      fs.writeFileSync(path.join(dir, 'hist-only.txt'), 'one\n');
      x.w.git(dir, 'add', 'hist-only.txt');
      x.w.git(dir, 'commit', '-q', '-m', 'Add hist-only');
      const all = await x.files.history({ podId: x.A.podId });
      const one = await x.files.history({ podId: x.A.podId, path: 'hist-only.txt' });
      const none = await x.files.history({ podId: x.A.podId, path: 'never-existed.txt' });
      const limited = await x.files.history({ podId: x.A.podId, limit: 1 });
      const shape = all.commits.every((c) => /^[0-9a-f]{7,12}$/.test(c.id) && typeof c.author === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(c.date) && typeof c.message === 'string');
      const bads = await Promise.all([x.fail(x.files.history({ podId: x.A.podId, limit: 0 })), x.fail(x.files.history({ podId: x.A.podId, limit: 1000 })), x.fail(x.files.history({ podId: x.A.podId, path: '../x' })), x.fail(x.files.history({ podId: x.A.podId, path: '.env' }))]);
      return verdict(all.commits[0].message === 'Add hist-only' && all.commits.some((c) => /ALPHA-COMMIT-SECRET/.test(c.message)) && !all.commits.some((c) => /BETA/.test(c.message)) && shape
        && one.commits.length === 1 && one.commits[0].message === 'Add hist-only' && none.commits.length === 0 && limited.commits.length === 1 && bads.every(Boolean),
        `history gave ${json(all.commits.slice(0, 3))}; one file ${json(one)}; none ${json(none)}; limit ${json(limited)}; bad inputs ${json(bads)}`);
    },
  },
  {
    id: 'd-done-when-a-saved-edit-is-a-commit-by-the-founder-with-history-and-only-that-file-is-in-it',
    async run() {
      const x = await world();
      const dir = x.A.folder;
      fs.writeFileSync(path.join(dir, 'd-stray.txt'), 'left by an agent, not committed\n');
      const before = x.w.git(dir, 'rev-parse', 'HEAD');
      const sentinel = `EDIT-WORDS-${Date.now()}`;
      const lock = await x.files.beginEdit({ podId: x.A.podId, path: 'app.js' });
      const saved = await x.files.save({ podId: x.A.podId, path: 'app.js', content: `// ALPHA-APP\n// ${sentinel}\n`, message: 'Change the heading' });
      const after = x.w.git(dir, 'rev-parse', 'HEAD');
      const log = x.logOf(dir, 1);
      const stat = x.w.git(dir, 'show', '--name-only', '--format=', 'HEAD');
      const status = x.w.git(dir, 'status', '--porcelain');
      const history = await x.files.history({ podId: x.A.podId, path: 'app.js' });
      const event = x.events.find((e) => e.type === 'pod.file_changed');
      const rows = await x.w.store.select('audit_log', { where: { action: 'pod.file_saved' }, limit: 100 });
      const mine = rows.filter((r) => r.pod_id === x.A.podId);
      return verdict(typeof lock.expiresAt === 'string' && saved.path === 'app.js' && before !== after && /^[0-9a-f]{7,12}$/.test(saved.commit) && fs.readFileSync(path.join(dir, 'app.js'), 'utf8').includes(sentinel)
        && /^Founder\|Change the heading$/.test(log) && stat.trim() === 'app.js' && /\?\? d-stray\.txt/.test(status) && history.commits[0].message === 'Change the heading' && history.commits[0].author === 'Founder'
        && x.files.isLocked({ podId: x.A.podId, path: 'app.js' }) === false && event && event.data.podId === x.A.podId && event.data.path === 'app.js' && event.data.by === 'founder'
        && mine.length >= 1 && !json(mine).includes(sentinel),
        `commit ${before.slice(0, 7)} -> ${after.slice(0, 7)}; log ${log}; files in it ${json(stat)}; status ${json(status)}; history ${json(history.commits[0])}; event ${json(event)}; audit rows ${mine.length}; words in audit ${json(mine).includes(sentinel)}`);
    },
  },
  {
    id: 'e-done-when-an-agent-write-to-a-file-the-founder-has-open-is-refused-and-works-again-after-save-or-close',
    async run() {
      const x = await world();
      const loader = await x.loaderFor(x.files);
      const file = path.join(x.A.folder, 'app.js');
      const original = fs.readFileSync(file, 'utf8');
      const free = await x.agentWrite(loader, x.A.podId, 'e-free.txt', 'fine');
      await x.files.beginEdit({ podId: x.A.podId, path: 'app.js' });
      const refused = await x.agentWrite(loader, x.A.podId, 'app.js', 'AGENT OVERWRITE');
      const refusedDotted = await x.agentWrite(loader, x.A.podId, './app.js', 'AGENT OVERWRITE');
      const refusedUpper = await x.agentWrite(loader, x.A.podId, 'APP.JS', 'AGENT OVERWRITE');
      const untouched = fs.readFileSync(file, 'utf8') === original;
      const otherFile = await x.agentWrite(loader, x.A.podId, 'e-other.txt', 'fine too');
      const otherPod = await x.agentWrite(loader, x.B.podId, 'app.js', '// BETA-APP changed by its own agent\n');
      await x.files.endEdit({ podId: x.A.podId, path: 'app.js' });
      const afterClose = await x.agentWrite(loader, x.A.podId, 'app.js', `${original}// by the agent\n`);
      await x.files.beginEdit({ podId: x.A.podId, path: 'app.js' });
      const again = await x.agentWrite(loader, x.A.podId, 'app.js', 'AGENT OVERWRITE 2');
      await x.files.save({ podId: x.A.podId, path: 'app.js', content: 'founder text\n', message: 'Founder rewrite' });
      const afterSave = await x.agentWrite(loader, x.A.podId, 'app.js', 'agent after save\n');
      const said = (r) => r.ok && /^Not done:.*(editing|open)/i.test(r.text) && !/Saved /.test(r.text);
      return verdict(free.ok && /Saved/.test(free.text) && said(refused) && said(refusedDotted) && said(refusedUpper) && said(again) && untouched
        && /Saved/.test(otherFile.text) && /Saved/.test(otherPod.text) && /Saved/.test(afterClose.text) && /Saved/.test(afterSave.text),
        `free ${json(free)}; locked ${json(refused)}; dotted ${json(refusedDotted)}; upper case ${json(refusedUpper)}; file untouched ${untouched}; other file ${json(otherFile)}; other pod ${json(otherPod)}; after close ${json(afterClose)}; locked again ${json(again)}; after save ${json(afterSave)}`);
    },
  },
  {
    id: 'f-a-save-needs-the-lock-a-lock-runs-out-and-opening-again-renews-it',
    async run() {
      const x = await world();
      const dir = x.A.folder;
      fs.writeFileSync(path.join(dir, 'f-file.txt'), 'start\n');
      x.w.git(dir, 'add', 'f-file.txt');
      x.w.git(dir, 'commit', '-q', '-m', 'Add f-file');
      const unlocked = await x.fail(x.files.save({ podId: x.A.podId, path: 'f-file.txt', content: 'no lock\n' }));
      const missing = await x.fail(x.files.beginEdit({ podId: x.A.podId, path: 'f-missing.txt' }));
      const secret = await x.fail(x.files.beginEdit({ podId: x.A.podId, path: '.env' }));
      const first = await x.files.beginEdit({ podId: x.A.podId, path: 'f-file.txt' });
      x.setClock(new Date(NOW.getTime() + 20 * 60_000));
      const stillLocked = x.files.isLocked({ podId: x.A.podId, path: 'f-file.txt' });
      const renewed = await x.files.beginEdit({ podId: x.A.podId, path: 'f-file.txt' });
      x.setClock(new Date(NOW.getTime() + 20 * 60_000 + 40 * 60_000));
      const ranOut = x.files.isLocked({ podId: x.A.podId, path: 'f-file.txt' });
      const lateSave = await x.fail(x.files.save({ podId: x.A.podId, path: 'f-file.txt', content: 'too late\n' }));
      const released = await x.files.endEdit({ podId: x.A.podId, path: 'f-file.txt' });
      x.setClock(NOW);
      return verdict(unlocked?.code === 'not_locked' && missing?.code && secret?.code && stillLocked === true && Date.parse(renewed.expiresAt) > Date.parse(first.expiresAt) && ranOut === false && lateSave?.code === 'not_locked'
        && released.released === false && fs.readFileSync(path.join(dir, 'f-file.txt'), 'utf8') === 'start\n',
        `unlocked ${json(unlocked)}; missing ${json(missing)}; secret ${json(secret)}; locked at 20 min ${stillLocked}; renewed ${renewed.expiresAt} vs ${first.expiresAt}; after the time ${ranOut}; late save ${json(lateSave)}; released ${json(released)}`);
    },
  },
  {
    id: 'g-upload-adds-a-new-file-with-a-commit-and-never-replaces-one-or-takes-secrets-or-odd-names',
    async run() {
      const x = await world();
      const dir = x.A.folder;
      const up = await x.files.upload({ podId: x.A.podId, path: 'uploads/brief.md', content: '# Brief from the founder\n' });
      const log = x.logOf(dir, 1);
      const history = await x.files.history({ podId: x.A.podId, path: 'uploads/brief.md' });
      const exists = await x.fail(x.files.upload({ podId: x.A.podId, path: 'uploads/brief.md', content: 'again' }));
      const bads = ['.env', 'uploads/.env.local', 'id_rsa', 'deploy.pem', '.git/hooks/pre-commit', 'node_modules/x.js', '../escape.txt', path.join(x.B.folder, 'evil.txt'), '/etc/evil.txt', 'a//b.txt', 'up/', '', 'x\u0000y.txt', 'a'.repeat(400)];
      const taken = [];
      for (const p of bads) if (!(await x.fail(x.files.upload({ podId: x.A.podId, path: p, content: 'hello' })))) taken.push(p);
      const content = [['key.txt', `token = gsk_${'a1B2c3D4'.repeat(4)}\n`], ['nul.txt', 'a\u0000b'], ['big.txt', 'x'.repeat(100_001)], ['num.txt', 42], ['none.txt', undefined]];
      const notTaken = [];
      for (const [p, c] of content) if (!(await x.fail(x.files.upload({ podId: x.A.podId, path: p, content: c })))) notTaken.push(p);
      const leftovers = ['key.txt', 'nul.txt', 'big.txt', 'num.txt', 'none.txt', 'escape.txt'].filter((n) => fs.existsSync(path.join(dir, n)) || fs.existsSync(path.join(path.dirname(dir), n)));
      const empty = await x.files.upload({ podId: x.A.podId, path: 'uploads/empty.txt', content: '' });
      return verdict(up.path === 'uploads/brief.md' && /^Founder\|Add uploads\/brief\.md$/.test(log) && history.commits.length === 1 && exists?.code === 'exists' && taken.length === 0 && notTaken.length === 0 && leftovers.length === 0 && empty.path === 'uploads/empty.txt',
        `upload ${json(up)}; log ${log}; history ${json(history.commits)}; again ${json(exists)}; names that were taken ${json(taken)}; contents that were taken ${json(notTaken)}; files left behind ${json(leftovers)}`);
    },
  },
  {
    id: 'h-nothing-changes-when-the-audit-log-is-down-the-runtime-is-blocked-or-the-history-cannot-record-it',
    async run() {
      const x = await world();
      const dir = x.A.folder;
      fs.writeFileSync(path.join(dir, 'h-file.txt'), 'safe\n');
      x.w.git(dir, 'add', 'h-file.txt');
      x.w.git(dir, 'commit', '-q', '-m', 'Add h-file');
      const head = x.w.git(dir, 'rev-parse', 'HEAD');
      const eventsBefore = x.events.length;

      const down = x.make({ audit: { append: async () => { throw new Error('database down'); } } });
      const blocked = x.make({ isBlocked: () => 'The runtime is blocked for a test.' });
      const attempts = [
        ['audit begin', () => down.beginEdit({ podId: x.A.podId, path: 'h-file.txt' }), 'audit_unavailable'],
        ['audit upload', () => down.upload({ podId: x.A.podId, path: 'h-new.txt', content: 'x' }), 'audit_unavailable'],
        ['blocked begin', () => blocked.beginEdit({ podId: x.A.podId, path: 'h-file.txt' }), 'blocked'],
        ['blocked upload', () => blocked.upload({ podId: x.A.podId, path: 'h-new2.txt', content: 'x' }), 'blocked'],
      ];
      const wrong = [];
      for (const [label, attempt, code] of attempts) {
        const err = await x.fail(attempt());
        if (err?.code !== code || /database down/.test(err.message)) wrong.push(`${label}: ${json(err)}`);
      }
      // A save with the audit log down: the lock was taken while the log worked, then the log failed.
      const toggled = { down: false };
      const flaky = x.make({ audit: { append: async (e) => { if (toggled.down) throw new Error('database down'); return x.w.audit.append(e); } } });
      await flaky.beginEdit({ podId: x.A.podId, path: 'h-file.txt' });
      toggled.down = true;
      const saveDown = await x.fail(flaky.save({ podId: x.A.podId, path: 'h-file.txt', content: 'CHANGED\n' }));
      toggled.down = false;
      await flaky.endEdit({ podId: x.A.podId, path: 'h-file.txt' });
      const untouched = fs.readFileSync(path.join(dir, 'h-file.txt'), 'utf8') === 'safe\n' && x.w.git(dir, 'rev-parse', 'HEAD') === head && !fs.existsSync(path.join(dir, 'h-new.txt')) && !fs.existsSync(path.join(dir, 'h-new2.txt'));
      const noLockFromDown = down.isLocked({ podId: x.A.podId, path: 'h-file.txt' }) === false && blocked.isLocked({ podId: x.A.podId, path: 'h-file.txt' }) === false;

      // A folder whose history cannot take the commit: the file is put back, or never made.
      const broken = tempDir();
      fs.mkdirSync(path.join(broken, '.git'));
      fs.writeFileSync(path.join(broken, 'keep.txt'), 'original\n');
      const odd = x.make({ podFolder: async () => broken });
      await odd.beginEdit({ podId: x.A.podId, path: 'keep.txt' });
      const saveBroken = await x.fail(odd.save({ podId: x.A.podId, path: 'keep.txt', content: 'changed\n' }));
      const uploadBroken = await x.fail(odd.upload({ podId: x.A.podId, path: 'fresh.txt', content: 'new\n' }));
      const restored = fs.readFileSync(path.join(broken, 'keep.txt'), 'utf8') === 'original\n' && !fs.existsSync(path.join(broken, 'fresh.txt'));
      const noRepo = tempDir();
      fs.writeFileSync(path.join(noRepo, 'a.txt'), 'a\n');
      const bare = x.make({ podFolder: async () => noRepo });
      const noRepoUpload = await x.fail(bare.upload({ podId: x.A.podId, path: 'b.txt', content: 'b' }));
      return verdict(wrong.length === 0 && saveDown?.code === 'audit_unavailable' && untouched && noLockFromDown && x.events.length === eventsBefore
        && saveBroken && uploadBroken && restored && noRepoUpload && !fs.existsSync(path.join(noRepo, 'b.txt')),
        `wrong answers ${json(wrong)}; save with the log down ${json(saveDown)}; untouched ${untouched}; no lock from a failed audit ${noLockFromDown}; events ${x.events.length - eventsBefore}; broken history: save ${json(saveBroken)}, upload ${json(uploadBroken)}, restored ${restored}; no repository ${json(noRepoUpload)}`);
    },
  },
  {
    id: 'i-two-saves-at-the-same-moment-both-land-as-their-own-commits',
    async run() {
      const x = await world();
      const dir = x.A.folder;
      for (const n of ['i-one.txt', 'i-two.txt']) {
        fs.writeFileSync(path.join(dir, n), 'start\n');
        x.w.git(dir, 'add', n);
        x.w.git(dir, 'commit', '-q', '-m', `Add ${n}`);
        await x.files.beginEdit({ podId: x.A.podId, path: n });
      }
      const [a, b] = await Promise.all([
        x.files.save({ podId: x.A.podId, path: 'i-one.txt', content: 'one\n', message: 'Save one' }),
        x.files.save({ podId: x.A.podId, path: 'i-two.txt', content: 'two\n', message: 'Save two' }),
      ]);
      const log = x.logOf(dir, 2).split('\n').sort();
      const status = x.w.git(dir, 'status', '--porcelain');
      return verdict(a.commit !== b.commit && json(log) === json(['Founder|Save one', 'Founder|Save two']) && !/i-one|i-two/.test(status),
        `commits ${a.commit} ${b.commit}; log ${json(log)}; status ${json(status)}`);
    },
  },
  {
    id: 'j-a-pod-reaches-only-its-own-folder-and-never-another-pods-files-history-or-lock',
    async run() {
      const x = await world();
      const bName = path.basename(x.B.folder);
      const results = await Promise.all([
        x.fail(x.files.read({ podId: x.A.podId, path: `../${bName}/app.js` })),
        x.fail(x.files.save({ podId: x.A.podId, path: `../${bName}/app.js`, content: 'x' })),
        x.fail(x.files.upload({ podId: x.A.podId, path: `../${bName}/new.txt`, content: 'x' })),
        x.fail(x.files.beginEdit({ podId: x.A.podId, path: `../${bName}/app.js` })),
        x.fail(x.files.tree({ podId: RANDOM_ID })),
        x.fail(x.files.tree({ podId: x.A.podId, path: 'x' })),
      ]);
      await x.files.beginEdit({ podId: x.A.podId, path: 'app.js' });
      const lockOnlyHere = x.files.isLocked({ podId: x.A.podId, path: 'app.js' }) && !x.files.isLocked({ podId: x.B.podId, path: 'app.js' });
      await x.files.endEdit({ podId: x.A.podId, path: 'app.js' });
      const b = await x.files.read({ podId: x.B.podId, path: 'app.js' });
      const historyB = await x.files.history({ podId: x.B.podId });
      const leaked = fs.existsSync(path.join(x.B.folder, 'new.txt'));
      return verdict(results.every(Boolean) && lockOnlyHere && /BETA-APP/.test(b.content) && !/ALPHA/.test(b.content) && !historyB.commits.some((c) => /ALPHA/.test(c.message)) && !leaked,
        `refusals ${json(results.map((r) => r && r.code))}; lock is only for the pod ${lockOnlyHere}; pod B reads ${json(b.content)}; pod B history ${json(historyB.commits.map((c) => c.message))}; new file in pod B ${leaked}`);
    },
  },
  {
    id: 'k-the-windows-commands-check-their-arguments-and-never-put-a-files-words-in-the-audit-log',
    async run() {
      const x = await world();
      const { createRuntime } = loadSubject('src/runtime/runtime.js');
      const { registerCommands } = loadSubject('src/runtime/commands.js');
      const entries = [];
      const audit = { append: async (e) => { entries.push(e); } };
      const runtime = createRuntime({ audit });
      registerCommands(runtime, { store: x.w.store, podFiles: x.files, pods: x.w.pods });
      const bare = createRuntime({ audit });
      registerCommands(bare, { store: x.w.store });
      const call = (rt, name, args) => rt.invoke(name, args, { actor: 'founder' });
      const sentinel = `CMD-WORDS-${Date.now()}`;
      const podsList = await call(runtime, 'files.pods', {});
      const tree = await call(runtime, 'files.tree', { podId: x.A.podId });
      const lock = await call(runtime, 'files.beginEdit', { podId: x.A.podId, path: 'app.js' });
      const saved = await call(runtime, 'files.save', { podId: x.A.podId, path: 'app.js', content: `// ALPHA-APP ${sentinel}\n`, message: 'Through the window' });
      const uploaded = await call(runtime, 'files.upload', { podId: x.A.podId, path: 'k-up.txt', content: sentinel });
      const history = await call(runtime, 'files.history', { podId: x.A.podId, path: 'app.js' });
      const opened = await call(runtime, 'files.read', { podId: x.A.podId, path: 'app.js' });
      const closed = await call(runtime, 'files.endEdit', { podId: x.A.podId, path: 'app.js' });
      const bad = [
        await call(runtime, 'files.read', { podId: 'nope', path: 'app.js' }),
        await call(runtime, 'files.read', { podId: x.A.podId, path: 5 }),
        await call(runtime, 'files.read', { podId: x.A.podId, path: 'app.js', extra: 1 }),
        await call(runtime, 'files.save', { podId: x.A.podId, path: 'app.js', content: 5 }),
        await call(runtime, 'files.save', { podId: x.A.podId, path: 'app.js', content: 'x'.repeat(100_001) }),
        await call(runtime, 'files.history', { podId: x.A.podId, limit: 'many' }),
        await call(runtime, 'files.tree', {}),
      ];
      const offline = await call(bare, 'files.tree', { podId: x.A.podId });
      const fileLogged = json(entries).includes(sentinel);
      const listed = podsList.ok && Array.isArray(podsList.data.pods) && podsList.data.pods.some((p) => p.id === x.A.podId && typeof p.name === 'string' && typeof p.priority === 'string');
      return verdict(listed && tree.ok && tree.data.files.some((f) => f.path === 'app.js') && lock.ok && saved.ok && /^[0-9a-f]{7,12}$/.test(saved.data.commit) && uploaded.ok && history.ok && opened.ok && closed.ok
        && bad.every((r) => r.ok === false && r.error.code !== undefined) && offline.ok === false && offline.error.code === 'not_available' && !fileLogged,
        `pods ${json(podsList).slice(0, 120)}; tree ${tree.ok}; save ${json(saved).slice(0, 150)}; upload ${json(uploaded).slice(0, 120)}; bad inputs answered ${json(bad.map((r) => r.ok))}; offline ${json(offline)}; file words in the audit log ${fileLogged}`);
    },
  },
  {
    id: 'l-the-preload-exposes-the-files-functions-and-the-panel-shows-text-only-with-no-timer',
    check() {
      const preload = read('src/preload.js');
      const panel = read('src/renderer/FilesPanel.jsx');
      const app = read('src/renderer/App.jsx');
      const wanted = ['pods', 'tree', 'read', 'history', 'beginEdit', 'endEdit', 'save', 'upload'];
      const missing = wanted.filter((n) => !new RegExp(`files\\.${n}\\b`).test(preload));
      const problems = [
        ...missing.map((n) => `preload lacks files.${n}`),
        ...(/dangerouslySetInnerHTML|innerHTML/.test(panel) ? ['the panel builds markup'] : []),
        ...(/setInterval/.test(panel) ? ['the panel has a timer'] : []),
        ...(/window\.api\.files\./.test(panel) ? [] : ['the panel does not call window.api.files']),
        ...(/pod\.file_changed|shouldRefetch/.test(panel) ? [] : ['the panel does not refresh on pod.file_changed']),
        ...(/FilesPanel/.test(app) ? [] : ['App.jsx does not show the panel']),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'm-the-panels-logic-nests-the-tree-labels-history-and-knows-which-events-matter',
    async run() {
      const mod = await loadSubject('src/renderer/files.mjs');
      const nodes = mod.treeView([{ path: 'src/b.js', size: 10 }, { path: 'app.js', size: 3 }, { path: 'src/a/deep.js', size: 1 }, { path: 'README.md', size: 2 }, { path: 'src/a.js', size: 4 }]);
      const top = nodes.map((n) => `${n.kind}:${n.name}`);
      const src = nodes.find((n) => n.name === 'src');
      const inner = src ? src.children.map((n) => `${n.kind}:${n.name}`) : [];
      const deep = src?.children.find((n) => n.name === 'a')?.children?.[0];
      const odd = mod.treeView([null, { path: 5 }, { path: '' }, 'x', { path: '<img src=x>.md', size: 1 }]);
      const rows = mod.historyView([{ id: 'abc1234', author: 'Founder', date: '2026-11-25T11:00:00.000Z', message: 'Fix <b>it</b>' }, { id: 'def5678', author: 'Dev', date: '2026-11-24T12:00:00.000Z', message: 'Earlier' }], NOW);
      return verdict(json(top) === json(['folder:src', 'file:README.md', 'file:app.js']) && json(inner) === json(['folder:a', 'file:a.js', 'file:b.js']) && deep?.path === 'src/a/deep.js'
        && Array.isArray(odd) && odd.length === 1 && odd[0].name === '<img src=x>.md' && rows.length === 2 && rows[0].message === 'Fix <b>it</b>' && /hour ago/.test(rows[0].when) && /Dev/.test(rows[1].who)
        && mod.shouldRefetch({ type: 'pod.file_changed', data: { podId: 'p1' } }, 'p1') === true && mod.shouldRefetch({ type: 'pod.file_changed', data: { podId: 'p2' } }, 'p1') === false
        && mod.shouldRefetch({ type: 'tasks.changed', data: {} }, 'p1') === false && mod.shouldRefetch(null, 'p1') === false,
        `top ${json(top)}; src ${json(inner)}; deep ${json(deep)}; odd ${json(odd)}; history rows ${json(rows)}`);
    },
  },
];

module.exports = {
  name: 'pod-files',
  description: 'The project files panel (step 3.6): files and history read from the pod folder, founder edits locked and committed, agent writes to a locked file refused',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check ? c.check() : c.run();
  },
};
