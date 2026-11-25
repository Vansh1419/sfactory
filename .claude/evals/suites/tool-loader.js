'use strict';

// Grades the tool loader and its first tool (PLAN.md step 1.10, the loader part):
//   src/runtime/tools/index.js     createToolLoader({ tools, hasRule, timeoutMs? })
//                                    -> { load(), describe(), run({ action, key }) }
//   src/runtime/tools/builtin.js   BUILTIN_TOOLS: the tools that ship with the app (today: docs.create_draft)
//
// A tool definition is { name, access: 'read' | 'write', summary, args, checkArgs(args) -> problem | null,
//                        run({ args, key }) -> anything }
//   name      "server.tool", the same shape the policy table uses
//   summary   one plain sentence, shown to the planner
//   args      one line telling the planner which arguments the tool takes
//
// What the loader promises (each is a case below):
//   - it REFUSES to load a tool that has no policy rule (the plan: "refuse to load a tool that has neither a built-in
//     rule nor an active rule from the founder"), and it checks the rule again on every call, so a rule removed later
//     stops the tool at once
//   - run() only runs a loaded tool, with the access tag it declares and arguments its own check accepts
//   - a tool's result is reduced to `{ text }` (a string, cut to a limit); everything else it returns is dropped
//   - no error text from a tool ever reaches the caller, and a tool that hangs is stopped
//
// `hasRule(toolName) -> Promise<boolean>` is supplied by the app (built-in rule or an active rule of the founder's).

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const LOADER = 'src/runtime/tools/index.js';
const BUILTIN = 'src/runtime/tools/builtin.js';
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

const tool = (over = {}) => ({
  name: 'acme.echo',
  access: 'read',
  summary: 'Repeats the text it is given.',
  args: '{ "text": the text to repeat }',
  checkArgs: (args) => (typeof args?.text === 'string' ? null : 'text must be text'),
  run: async ({ args }) => ({ text: args.text }),
  ...over,
});

const act = (over = {}) => ({ tool: 'acme.echo', access: 'read', args: { text: 'hi' }, ...over });
const allow = (...names) => async (name) => names.includes(name);

const makeLoader = (tools, over = {}) => loadSubject(LOADER).createToolLoader({ tools, hasRule: allow('acme.echo', 'acme.other'), ...over });

async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return err;
  }
}

const cases = [
  // ---- Loading: only a tool with a rule ----------------------------------------------------------------
  {
    id: 'a-tool-with-a-rule-is-loaded-and-described-for-the-planner',
    async check() {
      const loader = makeLoader([tool()]);
      const report = await loader.load();
      const [d] = loader.describe();
      const ok = report.loaded.join() === 'acme.echo' && report.refused.length === 0 && d.tool === 'acme.echo' && d.access === 'read' && d.summary === 'Repeats the text it is given.' && d.args.includes('text');
      return verdict(ok, json({ report, described: loader.describe() }));
    },
  },
  {
    id: 'a-tool-with-no-rule-is-refused-and-cannot-be-described-or-run',
    async check() {
      const loader = makeLoader([tool({ name: 'acme.unruled' })]);
      const report = await loader.load();
      const err = await rejects(() => loader.run({ action: act({ tool: 'acme.unruled' }), key: 'k' }));
      return verdict(report.loaded.length === 0 && report.refused.length === 1 && /rule/i.test(report.refused[0].reason) && loader.describe().length === 0 && err, json({ report }));
    },
  },
  {
    id: 'if-the-rule-check-itself-fails-the-tool-is-refused',
    async check() {
      const loader = makeLoader([tool()], { hasRule: async () => { throw new Error(`policy table down ${SECRET}`); } });
      const report = await loader.load();
      return verdict(report.loaded.length === 0 && report.refused.length === 1 && !json(report).includes(SECRET), json(report));
    },
  },
  {
    id: 'malformed-definitions-and-duplicate-names-are-refused-and-the-good-ones-still-load',
    async check() {
      const bad = [
        tool({ name: 'Bad Name' }),
        tool({ name: 'nodot' }),
        tool({ name: 'acme.other', access: 'admin' }),
        tool({ name: 'acme.other', summary: '' }),
        tool({ name: 'acme.other', run: 'not a function' }),
        tool({ name: 'acme.other', checkArgs: undefined }),
        null,
        5,
        'x',
      ];
      const loader = makeLoader([...bad, tool(), tool({ summary: 'A duplicate of the first' })]);
      const report = await loader.load();
      return verdict(report.loaded.join() === 'acme.echo' && report.refused.length === bad.length + 1, json({ loaded: report.loaded, refused: report.refused.length }));
    },
  },
  {
    id: 'loading-never-throws-on-garbage-input',
    async check() {
      for (const tools of [undefined, null, 5, 'x', {}, [null], [[]]]) {
        const err = await rejects(async () => {
          const loader = makeLoader(tools);
          await loader.load();
          loader.describe();
        });
        if (err) return verdict(false, `threw on ${json(tools)}: ${err.message}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'the-description-is-a-copy-the-caller-cannot-use-to-change-the-loader',
    async check() {
      const loader = makeLoader([tool()]);
      await loader.load();
      const first = loader.describe();
      first[0].summary = 'changed';
      first.push({ tool: 'evil.tool' });
      return verdict(loader.describe().length === 1 && loader.describe()[0].summary === 'Repeats the text it is given.', json(loader.describe()));
    },
  },

  // ---- Running ---------------------------------------------------------------------------------------------------
  {
    id: 'a-loaded-tool-runs-and-returns-only-its-text',
    async check() {
      const loader = makeLoader([tool({ run: async () => ({ text: 'hello', token: SECRET, extra: { deep: 1 }, ok: true }) })]);
      await loader.load();
      const out = await loader.run({ action: act(), key: 'k' });
      return verdict(json(out) === json({ text: 'hello' }), json(out));
    },
  },
  {
    id: 'a-result-with-no-text-or-with-text-that-is-not-a-string-gives-no-text',
    async check() {
      const results = [undefined, null, 5, 'a bare string', {}, { text: 5 }, { text: ['a'] }, { text: null }];
      for (const result of results) {
        const loader = makeLoader([tool({ run: async () => result })]);
        await loader.load();
        const out = await loader.run({ action: act(), key: 'k' });
        if ('text' in out) return verdict(false, `kept text for ${json(result)}: ${json(out)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'text-is-passed-through-exactly-including-indentation-and-line-breaks',
    async check() {
      const code = 'def add(a, b):\n    return a + b\n\n\nprint(add(1, 2))\n';
      const loader = makeLoader([tool({ run: async () => ({ text: code }) })]);
      await loader.load();
      const out = await loader.run({ action: act(), key: 'k' });
      return verdict(out.text === code, json(out.text));
    },
  },
  {
    id: 'very-long-text-is-cut-to-a-limit',
    async check() {
      const loader = makeLoader([tool({ run: async () => ({ text: 'x'.repeat(100_000) }) })]);
      await loader.load();
      const out = await loader.run({ action: act(), key: 'k' });
      return verdict(typeof out.text === 'string' && out.text.length > 1000 && out.text.length <= 20_000, `length ${out.text && out.text.length}`);
    },
  },
  {
    id: 'a-tool-that-was-never-loaded-is-refused-as-not-connected',
    async check() {
      const loader = makeLoader([tool()]);
      await loader.load();
      const err = await rejects(() => loader.run({ action: act({ tool: 'acme.other' }), key: 'k' }));
      const before = makeLoader([tool()]);
      const early = await rejects(() => before.run({ action: act(), key: 'k' }));
      return verdict(err && /not connected|not available/i.test(err.message) && early, json({ err: err && err.message, early: early && early.message }));
    },
  },
  {
    id: 'a-tool-name-is-matched-like-the-policy-matches-it-and-look-alikes-do-not-match',
    async check() {
      const loader = makeLoader([tool()]);
      await loader.load();
      const same = await loader.run({ action: act({ tool: '  ACME.Echo ' }), key: 'k' });
      const lookalike = await rejects(() => loader.run({ action: act({ tool: 'acme.echо' }), key: 'k' })); // a Cyrillic o
      const zeroWidth = await rejects(() => loader.run({ action: act({ tool: 'acme.ec​ho' }), key: 'k' }));
      return verdict(same.text === 'hi' && lookalike && zeroWidth, json({ same, lookalike: Boolean(lookalike), zeroWidth: Boolean(zeroWidth) }));
    },
  },
  {
    id: 'the-access-tag-must-match-what-the-tool-declares',
    async check() {
      const loader = makeLoader([tool({ access: 'write' })]);
      await loader.load();
      const claimedRead = await rejects(() => loader.run({ action: act({ access: 'read' }), key: 'k' }));
      const missing = await rejects(() => loader.run({ action: { tool: 'acme.echo', args: { text: 'x' } }, key: 'k' }));
      const right = await loader.run({ action: act({ access: 'write' }), key: 'k' });
      return verdict(claimedRead && missing && right.text === 'hi', json({ claimedRead: Boolean(claimedRead), missing: Boolean(missing) }));
    },
  },
  {
    id: 'arguments-the-tool-does-not-accept-are-refused-before-it-runs',
    async check() {
      let ran = 0;
      const loader = makeLoader([tool({ run: async ({ args }) => { ran += 1; return { text: args.text }; } })]);
      await loader.load();
      const bad = [act({ args: { text: 5 } }), act({ args: {} }), act({ args: undefined }), act({ args: null }), act({ args: 'x' }), act({ args: ['x'] })];
      const errs = [];
      for (const action of bad) errs.push(await rejects(() => loader.run({ action, key: 'k' })));
      return verdict(errs.every(Boolean) && ran === 0, json({ refused: errs.map(Boolean), ran }));
    },
  },
  {
    id: 'an-argument-check-that-throws-counts-as-a-refusal-and-its-text-is-never-shown',
    async check() {
      const loader = makeLoader([tool({ checkArgs: () => { throw new Error(`bad ${SECRET}`); } })]);
      await loader.load();
      const err = await rejects(() => loader.run({ action: act(), key: 'k' }));
      return verdict(err && !err.message.includes(SECRET) && !String(err.stack).includes(SECRET), err && err.message);
    },
  },
  {
    id: 'a-rule-removed-after-loading-stops-the-tool-on-the-next-call',
    async check() {
      let ruled = true;
      const loader = makeLoader([tool()], { hasRule: async () => ruled });
      await loader.load();
      const before = await loader.run({ action: act(), key: 'k' });
      ruled = false;
      const after = await rejects(() => loader.run({ action: act(), key: 'k' }));
      return verdict(before.text === 'hi' && after && /rule/i.test(after.message), json({ before, after: after && after.message }));
    },
  },
  {
    id: 'a-rule-check-that-fails-at-call-time-stops-the-tool',
    async check() {
      let broken = false;
      const loader = makeLoader([tool()], { hasRule: async () => { if (broken) throw new Error(`down ${SECRET}`); return true; } });
      await loader.load();
      broken = true;
      const err = await rejects(() => loader.run({ action: act(), key: 'k' }));
      return verdict(err && !err.message.includes(SECRET), err && err.message);
    },
  },
  {
    id: 'the-tool-gets-a-copy-of-the-arguments-and-the-idempotency-key',
    async check() {
      let seen;
      const loader = makeLoader([tool({ run: async ({ args, key }) => { seen = { key, args }; args.text = 'changed by the tool'; return { text: 'ok' }; } })]);
      await loader.load();
      const action = act({ args: { text: 'original' } });
      await loader.run({ action, key: 'thread-1:t1' });
      return verdict(seen.key === 'thread-1:t1' && action.args.text === 'original', json({ seen, original: action.args }));
    },
  },
  {
    id: 'the-tool-gets-a-copy-of-the-runs-context-and-an-odd-context-becomes-an-empty-one',
    async check() {
      const seen = [];
      const loader = makeLoader([tool({ run: async ({ args, context }) => { seen.push(structuredClone(context)); context.team = 'changed by the tool'; return { text: args.text }; } })]);
      await loader.load();
      const context = { team: 'support', agent: 'Sam' };
      await loader.run({ action: act(), key: 'k', context });
      for (const odd of [undefined, null, 5, 'x', [], () => 1]) await loader.run({ action: act(), key: 'k', context: odd });
      return verdict(json(seen[0]) === json({ team: 'support', agent: 'Sam' }) && context.team === 'support' && seen.length === 7 && seen.slice(1).every((c) => json(c) === '{}'), json({ context, seen }));
    },
  },
  {
    id: 'a-tool-that-throws-gives-a-generic-error-with-none-of-its-text',
    async check() {
      const loader = makeLoader([tool({ run: async () => { throw new Error(`connection string postgres://user:${SECRET}@host failed`); } })]);
      await loader.load();
      const err = await rejects(() => loader.run({ action: act(), key: 'k' }));
      return verdict(err && !err.message.includes(SECRET) && !err.message.includes('postgres') && !String(err.stack).includes(SECRET), err && err.message);
    },
  },
  {
    id: 'a-tool-that-hangs-is-stopped-and-the-next-call-still-works',
    async check() {
      let first = true;
      const loader = makeLoader([tool({ run: async ({ args }) => { if (first) { first = false; return new Promise(() => {}); } return { text: args.text }; } })], { timeoutMs: 80 });
      await loader.load();
      const hung = await rejects(() => loader.run({ action: act(), key: 'k1' }));
      const fine = await loader.run({ action: act(), key: 'k2' });
      return verdict(hung && /too long|stopped/i.test(hung.message) && fine.text === 'hi', json({ hung: hung && hung.message, fine }));
    },
  },
  {
    id: 'a-request-that-is-not-an-action-is-refused-without-throwing-anything-odd',
    async check() {
      const loader = makeLoader([tool()]);
      await loader.load();
      for (const request of [undefined, null, 5, {}, { action: null }, { action: 'acme.echo' }, { action: {} }]) {
        const err = await rejects(() => loader.run(request));
        if (!(err instanceof Error)) return verdict(false, `no clean refusal for ${json(request)}`);
      }
      return verdict(true);
    },
  },

  // ---- Files: a tool may hand back one file (name + content) ------------------------------------------------------
  {
    id: 'a-file-a-tool-returns-is-kept-exactly-with-its-text',
    async check() {
      const content = 'def add(a, b):\n    return a + b\n';
      const loader = makeLoader([tool({ run: async () => ({ text: 'ok', file: { name: 'add.py', content, extra: SECRET }, token: SECRET }) })]);
      await loader.load();
      const out = await loader.run({ action: act(), key: 'k' });
      return verdict(json(out) === json({ text: 'ok', file: { name: 'add.py', content } }), json(out));
    },
  },
  {
    id: 'a-file-name-is-reduced-to-a-safe-plain-name',
    async check() {
      const names = { '../../etc/passwd': 'passwd', 'C:\\Users\\me\\notes.txt': 'notes.txt', 'a/b/c.py': 'c.py', 'bad:na*me?.py': 'bad_na_me_.py', '.hidden': 'hidden', '  spaced.txt  ': 'spaced.txt', 'ok\u0000name.py': 'ok_name.py' };
      for (const [given, expected] of Object.entries(names)) {
        const loader = makeLoader([tool({ run: async () => ({ file: { name: given, content: 'x' } }) })]);
        await loader.load();
        const out = await loader.run({ action: act(), key: 'k' });
        if (!out.file || out.file.name !== expected) return verdict(false, `${json(given)} became ${json(out.file && out.file.name)}, expected ${expected}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-file-that-is-not-usable-is-dropped-but-the-rest-of-the-result-stays',
    async check() {
      const bad = [null, 'x', 5, [], {}, { name: 'a.py' }, { content: 'x' }, { name: '', content: 'x' }, { name: '..', content: 'x' }, { name: '/', content: 'x' }, { name: 5, content: 'x' }, { name: 'a.py', content: 5 }, { name: 'a.py', content: 'x'.repeat(20_001) }, { name: 'n'.repeat(500), content: 'x' }];
      for (const file of bad) {
        const loader = makeLoader([tool({ run: async () => ({ text: 'still here', file }) })]);
        await loader.load();
        const out = await loader.run({ action: act(), key: 'k' });
        if ('file' in out || out.text !== 'still here') return verdict(false, `kept ${json(file)} -> ${json(out)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'an-empty-file-is-allowed',
    async check() {
      const loader = makeLoader([tool({ run: async () => ({ file: { name: 'empty.txt', content: '' } }) })]);
      await loader.load();
      const out = await loader.run({ action: act(), key: 'k' });
      return verdict(out.file && out.file.name === 'empty.txt' && out.file.content === '', json(out));
    },
  },
  {
    id: 'the-draft-tool-also-returns-the-script-as-a-file-named-by-its-title',
    async check() {
      const { BUILTIN_TOOLS } = loadSubject(BUILTIN);
      const loader = makeLoader(BUILTIN_TOOLS, { hasRule: allow('docs.create_draft') });
      await loader.load();
      const code = 'def add(a, b):\n    return a + b\n';
      const run = (title) => loader.run({ action: { tool: 'docs.create_draft', access: 'write', args: { title, content: code } }, key: 'k' });
      const a = await run('add_two_numbers.py');
      const b = await run('Meeting notes');
      const c = await run('../../evil.sh');
      return verdict(a.file && a.file.name === 'add_two_numbers.py' && a.file.content === code && b.file && b.file.name === 'Meeting notes.txt' && c.file && c.file.name === 'evil.sh', json({ a: a.file && a.file.name, b: b.file && b.file.name, c: c.file && c.file.name }));
    },
  },

  // ---- The first built-in tool: docs.create_draft ------------------------------------------------------------------
  {
    id: 'the-built-in-draft-tool-is-a-routine-write-the-policy-already-allows',
    async check() {
      const { BUILTIN_TOOLS } = loadSubject(BUILTIN);
      const draft = BUILTIN_TOOLS.find((t) => t.name === 'docs.create_draft');
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const verdictNow = policy.checkAction({ tool: 'docs.create_draft', access: 'write', args: {} });
      return verdict(draft && draft.access === 'write' && verdictNow.allowed === true && policy.isBuiltIn('docs.create_draft') && draft.summary.length > 10 && draft.args.includes('title') && draft.args.includes('content'), json({ draft: draft && [draft.name, draft.access], allowed: verdictNow }));
    },
  },
  {
    id: 'the-draft-tool-returns-the-title-and-the-content-as-text',
    async check() {
      const { BUILTIN_TOOLS } = loadSubject(BUILTIN);
      const loader = makeLoader(BUILTIN_TOOLS, { hasRule: allow('docs.create_draft') });
      await loader.load();
      const code = 'def add(a, b):\n    return a + b\n';
      const out = await loader.run({ action: { tool: 'docs.create_draft', access: 'write', args: { title: 'add.py', content: code } }, key: 'k' });
      return verdict(typeof out.text === 'string' && out.text.includes('add.py') && out.text.includes(code), json(out));
    },
  },
  {
    id: 'the-draft-tool-refuses-missing-blank-odd-or-oversized-arguments',
    async check() {
      const { BUILTIN_TOOLS } = loadSubject(BUILTIN);
      const draft = BUILTIN_TOOLS.find((t) => t.name === 'docs.create_draft');
      const good = { title: 'Note', content: 'Some text' };
      const bad = [{}, { title: 'Note' }, { content: 'x' }, { title: '', content: 'x' }, { title: 'Note', content: '   ' }, { title: 5, content: 'x' }, { title: 'Note', content: 5 }, { title: 'x'.repeat(201), content: 'x' }, { title: 'Note', content: 'x'.repeat(10_001) }, { ...good, extra: 'nope' }, null, 'x', ['x']];
      const problems = bad.map((args) => draft.checkArgs(args));
      return verdict(draft.checkArgs(good) === null && problems.every((p) => typeof p === 'string' && p.length > 0), json(problems));
    },
  },
];

module.exports = {
  name: 'tool-loader',
  description: 'Tool loader: only tools with a policy rule load, a rule removed later stops them, results shrink to plain text, no tool error text escapes, a hung tool is stopped; plus the built-in draft tool',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
