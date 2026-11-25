'use strict';

// Grades the Engineering team's tools (PLAN.md step 3.3). "Tools: GitHub (pull requests only, never a merge to production), Playwright, Context7."
//   src/runtime/tools/pod-files.js   pod.write_file: one file, inside the run's pod folder only
//   src/runtime/tools/git.js         git.create_branch, git.commit, git.push_branch: branches only, never the main line, never forced, never a secret
//   src/runtime/tools/github.js      in a pod run: the pod's own repository only, never a pull request from the main line, never a merge
//   src/runtime/tools/pod.js         pod.info
//   src/runtime/tools/context7.js    context7.search_library, context7.get_docs: one host, a fixed shape of address
//   src/runtime/tools/browser.js     browser.check_page: public https pages only, through a driver (a stand-in here; Playwright when installed)
//
// Real Postgres with the migrations, real folders and REAL git (every GitHub repository is a bare repository in a temporary folder, so a push really
// happens); GitHub's API, Context7 and the browser are stand-ins that record what they were asked. The world is shared with `engineering-team`
// (`.claude/evals/engineering-world.js`). Cases take turns on pod A, so each leaves it as the next one expects.

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject } = require('../lib');
const { buildWorld, git, TOKEN } = require('../engineering-world');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const RANDOM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';
const gitOut = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => !String(f).startsWith('.git')).sort().join('|');

const cases = [
  {
    id: 'the-world-is-built-three-pods-two-with-repositories-and-every-engineering-tool-loads',
    async check() {
      const w = await buildWorld('tools');
      const want = ['pod.write_file', 'git.create_branch', 'git.commit', 'git.push_branch', 'git.status', 'git.log', 'git.diff', 'pod.info', 'github.create_pull_request', 'github.read_file', 'github.list_pull_requests', 'github.merge_pull_request'];
      const repos = [await w.pods.repoFor(w.A.podId), await w.pods.repoFor(w.B.podId), await w.pods.repoFor(w.C.podId), await w.pods.repoFor('x'), await w.pods.repoFor(RANDOM_ID)];
      return verdict(w.loaded.refused.length === 0 && want.every((t) => w.loaded.loaded.includes(t)) && json(repos) === json(['acme/site-a', 'acme/site-b', null, null, null]), json({ refused: w.loaded.refused, repos }));
    },
  },
  {
    id: 'write-file-a-pod-writes-files-in-its-own-folder-and-nowhere-else-through-any-path-or-link',
    async check() {
      const w = await buildWorld('tools');
      const B = path.basename(w.B.folder);
      const before = { b: tree(w.B.folder), company: fs.readdirSync(w.company).sort().join('|'), podsRoot: fs.readdirSync(w.podsRoot).sort().join('|') };
      const wrote = [
        await w.use(w.A.podId, 'pod.write_file', 'write', { path: 'src/deep/new-file.js', content: 'export const a = 1;\n' }),
        await w.use(w.A.podId, 'pod.write_file', 'write', { path: 'src/deep/new-file.js', content: 'export const a = 2;\n' }),
        await w.use(w.A.podId, 'pod.write_file', 'write', { path: 'docs\\windows.md', content: '# hi\n' }),
      ];
      const content = fs.readFileSync(path.join(w.A.folder, 'src/deep/new-file.js'), 'utf8');
      // Links inside pod A that point out of it: the file must never be written through them.
      fs.symlinkSync(w.B.folder, path.join(w.A.folder, 'link-dir'));
      fs.symlinkSync(path.join(w.B.folder, 'app.js'), path.join(w.A.folder, 'link-file.js'));
      const refused = [];
      try {
        for (const p of [
          '../x.txt', `../${B}/app.js`, path.join(w.B.folder, 'app.js'), `/${B}/x`, '~/x', '..', '.', 'src/', '', 'link-dir/evil.txt', 'link-file.js', 'link-dir', 'src/../../x.txt',
          '.git/config', '.git/hooks/pre-commit', '.env', '.env.local', 'config/.env', 'node_modules/x/index.js', 'id_rsa', 'keys/server.pem', 'credentials.json', 'a\u0000b',
        ]) refused.push([p, await w.use(w.A.podId, 'pod.write_file', 'write', { path: p, content: 'EVIL\n' })]);
        for (const args of [{ path: 'ok.txt' }, { path: 'ok.txt', content: 5 }, { path: 'ok.txt', content: 'a\u0000b' }, { path: 'ok.txt', content: 'x'.repeat(100_001) }, { path: 'ok.txt', content: 'x', podId: w.B.podId }, { path: 'ok.txt', content: 'x', mode: '777' }]) refused.push([json(args).slice(0, 40), await w.use(w.A.podId, 'pod.write_file', 'write', args)]);
        for (const id of [undefined, RANDOM_ID, 'not-a-uuid', 'x', '', null, 5]) refused.push([`pod ${json(id)}`, await w.use(id, 'pod.write_file', 'write', { path: 'ok.txt', content: 'x' })]);
      } finally {
        fs.unlinkSync(path.join(w.A.folder, 'link-dir'));
        fs.unlinkSync(path.join(w.A.folder, 'link-file.js'));
      }
      const after = { b: tree(w.B.folder), company: fs.readdirSync(w.company).sort().join('|'), podsRoot: fs.readdirSync(w.podsRoot).sort().join('|') };
      const leaked = [...wrote, ...refused.map(([, r]) => r)].some((r) => /sfactory-eng|\/tmp\/|EACCES|ENOENT/.test(r.text ?? r.error ?? ''));
      const ok = wrote.every((r) => r.ok) && wrote[0].text.startsWith('Saved src/deep/new-file.js') && content === 'export const a = 2;\n' && fs.existsSync(path.join(w.A.folder, 'docs/windows.md'))
        && refused.every(([, r]) => !r.ok) && json(before) === json(after) && !fs.existsSync(path.join(w.A.folder, '.env')) && !fs.existsSync(path.join(w.A.folder, 'credentials.json')) && !leaked
        && fs.readFileSync(path.join(w.B.folder, 'app.js'), 'utf8') === '// BETA-APP\n';
      return verdict(ok, json({ wrote: wrote.map((r) => r.ok), written: refused.filter(([, r]) => r.ok).map(([p]) => p), same: json(before) === json(after), leaked }));
    },
  },
  {
    id: 'branches-and-commits-work-only-on-a-safe-branch-never-the-main-line-never-a-secret-and-hooks-never-run',
    async check() {
      const w = await buildWorld('tools');
      const mainBefore = git(w.A.folder, 'rev-parse', 'main');
      fs.writeFileSync(path.join(w.A.folder, 'change.txt'), 'a real change\n');
      fs.mkdirSync(path.join(w.A.folder, '.git/hooks'), { recursive: true });
      fs.writeFileSync(path.join(w.A.folder, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch "${w.A.folder}/HOOK-RAN"\n`, { mode: 0o755 });

      const onMain = await w.use(w.A.podId, 'git.commit', 'write', { message: 'sneaky commit on main' });
      const mainStill = git(w.A.folder, 'rev-parse', 'main') === mainBefore;

      const badNames = [];
      for (const name of ['main', 'master', 'develop', 'production', 'release/1.0', 'Feature/X', 'feature/', 'feature', 'feature/a b', 'feature/../x', 'feature/x.lock', 'feature/x.', '--force', '-b', 'feature/x;rm', 'feature/ä', 'x'.repeat(70), 'feature/' + 'y'.repeat(70), '']) {
        badNames.push([name, await w.use(w.A.podId, 'git.create_branch', 'write', { name })]);
      }
      const created = await w.use(w.A.podId, 'git.create_branch', 'write', { name: 'feature/one' });
      const duplicate = await w.use(w.A.podId, 'git.create_branch', 'write', { name: 'feature/one' });
      const extraArgs = [await w.use(w.A.podId, 'git.create_branch', 'write', { name: 'feature/two', from: 'main' }), await w.use(w.A.podId, 'git.create_branch', 'write', {})];

      const committed = await w.use(w.A.podId, 'git.commit', 'write', { message: '-n --amend add a change file' });
      const head = gitOut(w.A.folder, 'log', '-1', '--format=%an|%s');
      const nothing = await w.use(w.A.podId, 'git.commit', 'write', { message: 'nothing changed' });

      // A key in a file, and a file whose name holds secrets: both refused, nothing stays staged, nothing is saved.
      fs.writeFileSync(path.join(w.A.folder, 'settings.txt'), `the key is ${SECRET}\n`);
      const withKey = await w.use(w.A.podId, 'git.commit', 'write', { message: 'add settings' });
      const stagedAfterKey = gitOut(w.A.folder, 'diff', '--cached', '--name-only');
      fs.unlinkSync(path.join(w.A.folder, 'settings.txt'));
      fs.writeFileSync(path.join(w.A.folder, 'credentials.json'), '{}\n');
      const withDenied = await w.use(w.A.podId, 'git.commit', 'write', { message: 'add credentials' });
      const stagedAfterDenied = gitOut(w.A.folder, 'diff', '--cached', '--name-only');
      fs.unlinkSync(path.join(w.A.folder, 'credentials.json'));

      const badMessages = [];
      for (const args of [{ message: '' }, { message: '   ' }, { message: 'x'.repeat(501) }, { message: 'a\u0000b' }, { message: 'ok', amend: true }, { message: 'ok', author: 'someone else' }, {}]) badMessages.push(await w.use(w.A.podId, 'git.commit', 'write', args));
      const noPod = [await w.use(undefined, 'git.commit', 'write', { message: 'x' }), await w.use(RANDOM_ID, 'git.create_branch', 'write', { name: 'feature/x' }), await w.use('x', 'git.commit', 'write', { message: 'x' })];

      const refusedAsResult = (r, pattern) => r.ok && r.text.startsWith('Not done: ') && pattern.test(r.text);
      const ok = refusedAsResult(onMain, /not on a branch of your own/) && mainStill && badNames.every(([, r]) => !r.ok) && created.ok && !duplicate.ok && extraArgs.every((r) => !r.ok)
        && committed.ok && /^Saved 3 files on feature\/one as [0-9a-f]+\.$/.test(committed.text) && gitOut(w.A.folder, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort().join('|') === 'change.txt|docs/windows.md|src/deep/new-file.js' && head === 'Dev|-n --amend add a change file' && git(w.A.folder, 'rev-parse', 'main') === mainBefore
        && nothing.ok && nothing.text === 'Nothing to save: no files changed.'
        && refusedAsResult(withKey, /key or a password/) && stagedAfterKey === '' && refusedAsResult(withDenied, /key or a password/) && stagedAfterDenied === ''
        && badMessages.every((r) => !r.ok) && noPod.every((r) => !r.ok) && !fs.existsSync(path.join(w.A.folder, 'HOOK-RAN'))
        && !JSON.stringify([committed, withKey, onMain]).includes(SECRET);
      return verdict(ok, json({ onMain, mainStill, badNames: badNames.filter(([, r]) => r.ok).map(([n]) => n), created, duplicate: duplicate.ok, committed, head, nothing, withKey, stagedAfterKey, withDenied, stagedAfterDenied, hook: fs.existsSync(path.join(w.A.folder, 'HOOK-RAN')) }));
    },
  },
  {
    id: 'pushing-sends-only-a-safe-branch-to-the-pods-own-repository-never-the-main-line-never-forced-and-never-shows-the-token',
    async check() {
      const w = await buildWorld('tools');
      const remoteA = w.remotes['acme/site-a'];
      const remoteB = w.remotes['acme/site-b'];
      const localSha = git(w.A.folder, 'rev-parse', 'HEAD');
      const pushed = await w.use(w.A.podId, 'git.push_branch', 'write', {});
      const remoteBranches = gitOut(remoteA, 'branch', '--list', '--format=%(refname:short)');
      const remoteSha = gitOut(remoteA, 'rev-parse', 'feature/one');

      // The main line is never sent, from a pod on it: B is on main, and so is C (which also has nowhere to send).
      const fromMain = await w.use(w.B.podId, 'git.push_branch', 'write', {});
      git(w.C.folder, 'switch', '-q', '-c', 'feature/gamma');
      const noRepo = await w.use(w.C.podId, 'git.push_branch', 'write', {});
      git(w.B.folder, 'switch', '-q', '-c', 'feature/beta');
      const fromB = await w.use(w.B.podId, 'git.push_branch', 'write', {});

      const withArgs = [];
      for (const args of [{ force: true }, { remote: remoteB }, { branch: 'main' }, { repo: 'acme/site-b' }, { 'force-with-lease': true }]) withArgs.push(await w.use(w.A.podId, 'git.push_branch', 'write', args));

      // Rewriting history is not a fast-forward: the push is refused and the repository keeps what it had.
      git(w.A.folder, 'commit', '-q', '--amend', '-m', 'rewritten history');
      const rewritten = await w.use(w.A.podId, 'git.push_branch', 'write', {});
      const remoteAfter = gitOut(remoteA, 'rev-parse', 'feature/one');

      // The token: a web address with a token set and a refused connection. It must never show up anywhere.
      const { createGitTools } = loadSubject('src/runtime/tools/git.js');
      const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
      const web = async (githubToken) => {
        const loader = createToolLoader({ tools: createGitTools({ podFolder: (id) => w.pods.folderFor(id), podRepo: (id) => w.pods.repoFor(id), githubToken, remoteUrl: () => 'https://127.0.0.1:9/x.git' }), hasRule: async () => true });
        await loader.load();
        return loader.run({ action: { tool: 'git.push_branch', access: 'write', args: {} }, key: 'k', context: { team: 't', agent: 'Dev', podId: w.A.podId } }).then((r) => ({ ok: true, text: r.text }), (e) => ({ ok: false, error: e.message }));
      };
      const withToken = await web(TOKEN);
      const noToken = await web(undefined);
      const config = fs.readFileSync(path.join(w.A.folder, '.git/config'), 'utf8');

      const ok = pushed.ok && pushed.text === 'Sent feature/one to acme/site-a.' && remoteBranches === 'feature/one' && remoteSha === localSha
        && fromMain.ok && /^Not done: .*branch/.test(fromMain.text) && noRepo.ok && /^Not done: This project has no GitHub repository/.test(noRepo.text) && fromB.ok && gitOut(remoteB, 'branch', '--list', '--format=%(refname:short)') === 'feature/beta'
        && gitOut(remoteA, 'branch', '--list', '--format=%(refname:short)') === 'feature/one' && gitOut(remoteA, 'rev-parse', 'main') === null
        && withArgs.every((r) => !r.ok) && !rewritten.ok && remoteAfter === remoteSha
        && !withToken.ok && !String(withToken.error).includes(TOKEN) && noToken.ok && /^Not done: GitHub is not connected/.test(noToken.text) && !config.includes(TOKEN) && !/\[remote/.test(config)
        && ![pushed, fromMain, noRepo, fromB, rewritten, withToken, noToken].some((r) => JSON.stringify(r).includes(TOKEN) || /sfactory-eng|fatal|remote:/i.test(r.error ?? ''));
      return verdict(ok, json({ pushed, remoteBranches, fromMain: fromMain.text, noRepo: noRepo.text, fromB, rewritten: rewritten.error, withToken: withToken.error, noToken: noToken.text }));
    },
  },
  {
    id: 'github-in-a-pod-run-only-the-pods-own-repository-never-a-pull-request-from-the-main-line-and-never-a-merge',
    async check() {
      const w = await buildWorld('tools');
      const calls = w.github.calls;
      calls.length = 0;
      const pr = (podId, repo, extra = {}) => w.use(podId, 'github.create_pull_request', 'write', { repo, title: 'Add a thing', head: 'feature/one', base: 'main', body: 'What changed and why.', ...extra });
      const own = await pr(w.A.podId, 'acme/site-a');
      const sent = calls.slice();
      const ownUpper = await pr(w.A.podId, 'ACME/Site-A');
      calls.length = 0;

      const refused = [
        await pr(w.A.podId, 'acme/site-b'), await pr(w.A.podId, 'acme/other'), await pr(w.A.podId, 'acme/not-listed'), await pr(w.C.podId, 'acme/site-a'), await pr(w.C.podId, 'acme/other'),
        await pr(w.A.podId, 'acme/site-a', { head: 'main' }), await pr(w.A.podId, 'acme/site-a', { head: 'master' }), await pr(w.A.podId, 'acme/site-a', { head: 'Production' }), await pr(w.A.podId, 'acme/site-a', { head: 'release/1' }),
        await pr(RANDOM_ID, 'acme/site-a'), await pr('x', 'acme/site-a'),
        await w.use(w.A.podId, 'github.list_pull_requests', 'read', { repo: 'acme/site-b' }), await w.use(w.A.podId, 'github.read_file', 'read', { repo: 'acme/other', path: 'README.md' }),
        await w.use(w.A.podId, 'github.merge_pull_request', 'write', { repo: 'acme/site-a', number: 7 }), await w.use(w.B.podId, 'github.merge_pull_request', 'write', { repo: 'acme/site-b', number: 1 }),
      ];
      const requestsForRefused = calls.length;
      const listOwn = await w.use(w.A.podId, 'github.list_pull_requests', 'read', { repo: 'acme/site-a' });
      const readOwn = await w.use(w.A.podId, 'github.read_file', 'read', { repo: 'acme/site-a', path: 'README.md' });
      const companyRun = [await w.use(undefined, 'github.list_pull_requests', 'read', { repo: 'acme/other' }), await w.use(undefined, 'github.create_pull_request', 'write', { repo: 'acme/other', title: 't', head: 'feature/x', base: 'main' })];
      const verdictOnMerge = w.policy.checkAction({ tool: 'github.merge_pull_request', access: 'write', args: { repo: 'acme/site-a', number: 7 } });
      const ok = own.ok && /Opened pull request #7: https:\/\/github\.com\/acme\/site-a\/pull\/7/.test(own.text) && sent.length === 1 && sent[0].url === 'https://api.github.com/repos/acme/site-a/pulls' && sent[0].method === 'POST'
        && sent[0].body.head === 'feature/one' && sent[0].body.base === 'main' && ownUpper.ok && refused.every((r) => !r.ok) && requestsForRefused === 0
        && listOwn.ok && readOwn.ok && companyRun.every((r) => r.ok) && verdictOnMerge.allowed === false && verdictOnMerge.category === 'launch_or_pricing'
        && !json([own, listOwn, readOwn, refused]).includes(TOKEN);
      return verdict(ok, json({ own, sent, refused: refused.map((r) => r.ok), requestsForRefused, companyRun: companyRun.map((r) => r.ok), verdictOnMerge }));
    },
  },
  {
    id: 'pod-info-tells-a-run-its-own-project-and-repository-and-nothing-of-another',
    async check() {
      const w = await buildWorld('tools');
      const a = await w.use(w.A.podId, 'pod.info', 'read', {});
      const c = await w.use(w.C.podId, 'pod.info', 'read', {});
      const bad = [await w.use(undefined, 'pod.info', 'read', {}), await w.use('x', 'pod.info', 'read', {}), await w.use(RANDOM_ID, 'pod.info', 'read', {}), await w.use(w.A.podId, 'pod.info', 'read', { podId: w.B.podId })];
      const ok = a.ok && a.text.includes('Project: Alpha Site') && a.text.includes('GitHub repository: acme/site-a') && !/Beta|site-b/.test(a.text) && c.ok && /GitHub repository: none/.test(c.text) && bad.every((r) => !r.ok);
      return verdict(ok, json({ a: a.text, c: c.text, bad: bad.map((r) => r.ok) }));
    },
  },
  {
    id: 'context7-reaches-one-host-with-a-fixed-address-shape-and-sends-no-secret-and-never-follows-a-redirect',
    async check() {
      const { createContext7Tools } = loadSubject('src/runtime/tools/context7.js');
      const seen = [];
      const answer = (url) => {
        if (String(url).includes('/search?')) return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ id: '/reactjs/react.dev', title: 'React', description: 'A library\nfor user interfaces.' }, { id: 'https://evil.example/x', title: 'Bad id' }, { id: '/vercel/next.js', title: 'Next.js', description: 'The framework.' }] }) };
        if (String(url).includes('/redirected/')) return { ok: false, status: 302, text: async () => 'Moved' };
        if (String(url).includes('/big/')) return { ok: true, status: 200, text: async () => 'x'.repeat(40_000) };
        if (String(url).includes('/empty/')) return { ok: true, status: 200, text: async () => '  ' };
        return { ok: true, status: 200, text: async () => '### Use the hook\n\nCall it at the top level.' };
      };
      const fetchImpl = async (url, init) => { seen.push({ url: String(url), init }); return answer(url); };
      const make = (apiKey) => createContext7Tools({ apiKey, fetchImpl });
      const run = async (tools, name, args) => {
        const t = tools.find((x) => x.name === name);
        const problem = t.checkArgs(args);
        if (problem) return { refused: problem };
        try { return { text: (await t.run({ args, context: {} })).text }; } catch (err) { return { error: err.message }; }
      };
      const open = make(undefined);
      const keyed = make('ctx7sk-TESTKEY');
      const search = await run(open, 'context7.search_library', { name: 'react' });
      const docs = await run(open, 'context7.get_docs', { libraryId: '/reactjs/react.dev', topic: 'useEffect', tokens: 800 });
      const plain = await run(open, 'context7.get_docs', { libraryId: '/vercel/next.js/v14.3.0' });
      const withSecret = await run(open, 'context7.get_docs', { libraryId: '/reactjs/react.dev', topic: `hooks ${SECRET}` });
      const searchSecret = await run(open, 'context7.search_library', { name: `react ${SECRET}` });
      await run(keyed, 'context7.search_library', { name: 'react' });
      const bad = [];
      for (const libraryId of ['react', '/a', '//x', '/a/b/c/d', 'https://evil.example/x', '/../etc/passwd', '/a/..', '/a/b?x=1', '/a/b#x', '/a b/c', '', 5, undefined]) bad.push(await run(open, 'context7.get_docs', { libraryId }));
      for (const args of [{ libraryId: '/a/b', tokens: 100 }, { libraryId: '/a/b', tokens: 99999 }, { libraryId: '/a/b', topic: '' }, { libraryId: '/a/b', topic: 'x'.repeat(101) }, { libraryId: '/a/b', topic: 'a\nb' }, { libraryId: '/a/b', host: 'evil' }]) bad.push(await run(open, 'context7.get_docs', args));
      for (const args of [{ name: '' }, { name: 'x'.repeat(101) }, { name: 'a\u0000' }, { name: 'react', host: 'evil' }, {}]) bad.push(await run(open, 'context7.search_library', args));
      const redirected = await run(open, 'context7.get_docs', { libraryId: '/redirected/x' });
      const big = await run(open, 'context7.get_docs', { libraryId: '/big/x' });
      const empty = await run(open, 'context7.get_docs', { libraryId: '/empty/x' });
      const hosts = new Set(seen.map((s) => new URL(s.url).host));
      const keyedCall = seen.find((s) => s.init.headers.Authorization);
      const sentSecret = seen.some((s) => s.url.includes('sb_secret'));
      const ok = search.text === '/reactjs/react.dev — React: A library for user interfaces.\n/vercel/next.js — Next.js: The framework.' && docs.text.startsWith('### Use the hook')
        && seen.some((s) => s.url === 'https://context7.com/api/v1/search?query=react') && seen.some((s) => s.url === 'https://context7.com/api/v1/reactjs/react.dev?tokens=800&type=txt&topic=useEffect')
        && plain.text.includes('hook') && seen.some((s) => s.url === 'https://context7.com/api/v1/vercel/next.js/v14.3.0?tokens=2000&type=txt')
        && !sentSecret && withSecret.text && searchSecret.text && bad.every((r) => r.refused) && redirected.error === 'The documentation service did not answer.' && big.text.length < 19_100 && big.text.endsWith('more than fits.]') && empty.text === 'No documentation found for that.'
        && hosts.size === 1 && hosts.has('context7.com') && seen.every((s) => s.init.redirect === 'manual') && keyedCall.init.headers.Authorization === 'Bearer ctx7sk-TESTKEY' && seen.filter((s) => s.init.headers.Authorization).length === 1
        && JSON.stringify([search, docs, redirected, big]).includes('ctx7sk') === false;
      return verdict(ok, json({ search, hosts: [...hosts], urls: seen.map((s) => s.url).slice(0, 6), badAccepted: bad.filter((r) => !r.refused), redirected, sentSecret }));
    },
  },
  {
    id: 'browser-check-visits-only-public-https-pages-reports-plain-facts-and-has-no-tool-without-a-browser',
    async check() {
      const { createBrowserTools, allowedAddress, loadPlaywrightDriver } = loadSubject('src/runtime/tools/browser.js');
      const pub = [{ address: '93.184.216.34', family: 4 }];
      const lookupOf = (map) => async (host) => { if (!(host in map)) throw new Error('no such host'); return map[host]; };
      const lookup = lookupOf({
        'example.com': pub, 'www.example.com': pub, 'mixed.example': [...pub, { address: '10.0.0.5', family: 4 }], 'private.example': [{ address: '10.1.2.3', family: 4 }], 'loop.example': [{ address: '127.0.0.1', family: 4 }],
        'meta.example': [{ address: '169.254.169.254', family: 4 }], 'v6private.example': [{ address: 'fc00::1', family: 6 }], 'v6.example': [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }], 'empty.example': [],
      });
      const allowed = [];
      for (const url of ['https://example.com/', 'https://www.example.com/a?b=c#d', 'https://v6.example/', 'https://example.com:443/x']) allowed.push([url, await allowedAddress(url, lookup)]);
      const denied = [];
      for (const url of ['http://example.com/', 'https://user:pass@example.com/', 'https://example.com:8443/', 'https://mixed.example/', 'https://private.example/', 'https://loop.example/', 'https://meta.example/', 'https://v6private.example/', 'https://empty.example/', 'https://nonexistent.example/', 'https://localhost/', 'https://app.localhost/', 'https://printer.local/', 'https://db.internal/', 'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://[::1]/', 'https://10.0.0.1/', 'https://127.0.0.1/', 'not a url', '']) {
        denied.push([url, await allowedAddress(url, lookup)]);
      }

      const visits = [];
      const driver = { async visit(url, { allow }) { visits.push({ url, canAsk: typeof allow === 'function', blocksPrivate: await allow('https://private.example/x') === false, allowsPublic: await allow('https://example.com/y') === true }); return { status: 200, finalUrl: 'https://example.com/home', title: 'Example\nHome', text: 'Welcome   to the\nsite. '.repeat(400), consoleErrors: ['TypeError: x is undefined', 'Failed to load resource'], failedRequests: ['https://cdn.example/a.js'] }; } };
      const tools = createBrowserTools({ driver, lookup });
      const tool = tools[0];
      const good = await tool.run({ args: { url: 'https://example.com/' }, context: {} });
      const refusedRun = await tool.run({ args: { url: 'https://private.example/' }, context: {} }).then(() => 'ran', (e) => e.message);
      const argProblems = [{}, { url: 'http://example.com' }, { url: 'https://x.com', wait: 5 }, { url: 'x'.repeat(501) }, { url: 'https://a b.com' }].map((a) => tool.checkArgs(a));
      const broken = await createBrowserTools({ driver: { visit: async () => { throw new Error('browser crashed at /home/me/secret'); } }, lookup })[0].run({ args: { url: 'https://example.com/' }, context: {} }).then(() => 'ran', (e) => e.message);
      const garbage = await createBrowserTools({ driver: { visit: async () => 'nonsense' }, lookup })[0].run({ args: { url: 'https://example.com/' }, context: {} }).then(() => 'ran', (e) => e.message);
      const none = [createBrowserTools({}), createBrowserTools({ driver: {} }), createBrowserTools({ driver: null })];
      const real = (() => { try { require.resolve('playwright'); return 'installed'; } catch { return 'missing'; } })();
      const driverNow = loadPlaywrightDriver();

      const ok = allowed.every(([, a]) => a) && denied.every(([, a]) => !a) && visits.length === 1 && visits[0].canAsk && visits[0].blocksPrivate && visits[0].allowsPublic
        && /^Status: 200\nFinal address: https:\/\/example\.com\/home\nTitle: Example Home\nErrors the page showed: 2\n- TypeError: x is undefined\n- Failed to load resource\nRequests that failed: 1\n- https:\/\/cdn\.example\/a\.js\nVisible text \(first 1500 characters\): Welcome to the site\./.test(good.text)
        && good.text.length < 2200 && !good.text.includes('\n\n') && refusedRun === 'The page could not be checked.' && visits.length === 1 && argProblems.every((p) => typeof p === 'string')
        && broken === 'The page could not be checked.' && garbage === 'The page could not be checked.' && none.every((t) => t.length === 0) && tool.podAccess === 'neutral' && tool.access === 'read'
        && ((real === 'missing' && driverNow === null) || (real === 'installed' && driverNow && typeof driverNow.visit === 'function'));
      return verdict(ok, json({ allowedWrong: allowed.filter(([, a]) => !a), deniedWrong: denied.filter(([, a]) => a), good: good.text.slice(0, 300), refusedRun, broken, garbage, real }));
    },
  },
];

module.exports = {
  name: 'engineering-tools',
  description: 'The Engineering team\'s tools (step 3.3): files, branches, commits and pushes only inside a pod and never on the main line or with a secret; pull requests only in the pod\'s own repository and never a merge; library documentation from one host; browser checks of public pages only',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
