'use strict';

// Grades the per-team tool configuration (PLAN.md step 1.10: "Read shared.yaml plus a team YAML, tag every tool
// read or write"):
//   src/runtime/tools/config.js
//     loadToolConfig({ dir, team? }) -> { tools: { [name]: 'read' | 'write' }, problems: [string] }
//     selectTools({ catalogue, config }) -> { tools: [definition], problems: [string], missing: [name] }
//
// A config file (config/mcp/shared.yaml, config/mcp/<team>.yaml) looks like
//     tools:
//       filesystem.read_file: read
//       github.create_pull_request: write
// shared.yaml is read first, then the team's file adds to it. The config is an ALLOW-LIST and a TAG CHECK:
//   - a tool that is not listed is never loaded; a listed tool is only used if its tag here equals the tag the tool
//     itself declares (so a file cannot call a write tool "read")
//   - it fails closed: a missing shared.yaml, a broken file or a wrong entry gives fewer tools, never more
//   - the team name cannot be used to read any other file
//   - the config only chooses among tools that exist; it can never create one, and the policy rule is still needed
//     (the loader checks that), so this is a second gate, not a replacement

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/tools/config.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const lib = () => loadSubject(SUBJECT);

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A fresh config folder holding the given files ({ 'shared.yaml': 'text', ... }). */
function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-config-'));
  made.push(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const SHARED = 'tools:\n  filesystem.read_file: read\n  docs.create_draft: write\n';

const def = (name, access) => ({ name, access, summary: 'A tool.', args: '{}', checkArgs: () => null, run: async () => ({}) });
const CATALOGUE = [def('filesystem.read_file', 'read'), def('docs.create_draft', 'write'), def('github.create_pull_request', 'write'), def('github.merge_pull_request', 'write'), def('fetch.get', 'read')];

const cases = [
  // ---- Reading the files ---------------------------------------------------------------------------
  {
    id: 'shared-tools-are-read-with-their-tags',
    check() {
      const c = lib().loadToolConfig({ dir: dirWith({ 'shared.yaml': SHARED }) });
      return verdict(json(c.tools) === json({ 'filesystem.read_file': 'read', 'docs.create_draft': 'write' }) && c.problems.length === 0, json(c));
    },
  },
  {
    id: 'a-team-file-adds-to-the-shared-tools',
    check() {
      const dir = dirWith({ 'shared.yaml': SHARED, 'marketing_sales.yaml': 'tools:\n  fetch.get: read\n  github.create_pull_request: write\n' });
      const c = lib().loadToolConfig({ dir, team: 'marketing_sales' });
      const names = Object.keys(c.tools).sort().join();
      return verdict(names === 'docs.create_draft,fetch.get,filesystem.read_file,github.create_pull_request' && c.tools['fetch.get'] === 'read' && c.problems.length === 0, json(c));
    },
  },
  {
    id: 'another-teams-file-is-never-read',
    check() {
      const dir = dirWith({ 'shared.yaml': SHARED, 'support.yaml': 'tools:\n  fetch.get: read\n', 'finance_legal_ops.yaml': 'tools:\n  github.merge_pull_request: write\n' });
      const c = lib().loadToolConfig({ dir, team: 'support' });
      return verdict(!('github.merge_pull_request' in c.tools) && c.tools['fetch.get'] === 'read', json(c));
    },
  },
  {
    id: 'a-team-name-that-is-not-a-plain-name-cannot-reach-any-other-file',
    check() {
      const dir = dirWith({ 'shared.yaml': SHARED });
      const outside = path.join(path.dirname(dir), 'outside-team.yaml');
      fs.writeFileSync(outside, 'tools:\n  github.merge_pull_request: write\n');
      made.push(outside);
      for (const team of ['../outside-team', '..', '/etc/passwd', 'a/b', 'a\\b', '', ' ', 'Support', 'a.b', 'x'.repeat(60), 5, {}, ['support'], 'sup\u0000port']) {
        const c = lib().loadToolConfig({ dir, team });
        if ('github.merge_pull_request' in c.tools) return verdict(false, `read a file for ${json(team)}`);
        if (c.problems.length === 0) return verdict(false, `no problem reported for ${json(team)}`);
        if (json(c.tools) !== json({ 'filesystem.read_file': 'read', 'docs.create_draft': 'write' })) return verdict(false, `tools changed for ${json(team)}: ${json(c.tools)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-team-with-no-file-gets-only-the-shared-tools-and-a-note',
    check() {
      const c = lib().loadToolConfig({ dir: dirWith({ 'shared.yaml': SHARED }), team: 'support' });
      return verdict(json(c.tools) === json({ 'filesystem.read_file': 'read', 'docs.create_draft': 'write' }) && c.problems.length === 1, json(c));
    },
  },

  // ---- Failing closed ------------------------------------------------------------------------------
  {
    id: 'no-shared-file-means-no-tools-at-all',
    check() {
      const dir = dirWith({ 'support.yaml': 'tools:\n  fetch.get: read\n' });
      const c = lib().loadToolConfig({ dir, team: 'support' });
      const none = lib().loadToolConfig({ dir: path.join(dir, 'does-not-exist') });
      return verdict(Object.keys(c.tools).length === 0 && c.problems.length > 0 && Object.keys(none.tools).length === 0 && none.problems.length > 0, json({ c, none }));
    },
  },
  {
    id: 'a-broken-or-odd-file-gives-no-tools-and-a-problem-and-never-throws',
    check() {
      const bad = ['tools: [unclosed', ':::', '\u0000\u0001', 'tools: 5', 'tools: [a, b]', 'tools: "x"', 'just text', '', '- a\n- b', 'tools:\n  a.b: [read]', 'tools: &x\n  a.b: read\nother: *x', 'tools:\n  filesystem.read_file: read\n  filesystem.read_file: write', 'tools:\n  x.y: read\n---\nsecond: doc'];
      for (const text of bad) {
        let c;
        try {
          c = lib().loadToolConfig({ dir: dirWith({ 'shared.yaml': text }) });
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(text)}: ${err.message}`);
        }
        if (Object.keys(c.tools).length > 0 || c.problems.length === 0) return verdict(false, `${json(text)} -> ${json(c)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-wrong-entry-is-skipped-with-a-problem-and-the-good-ones-stay',
    check() {
      const text = 'tools:\n  filesystem.read_file: read\n  Bad Name: read\n  nodot: read\n  a.b: admin\n  c.d: 5\n  e.f: null\n  docs.create_draft: write\n';
      const c = lib().loadToolConfig({ dir: dirWith({ 'shared.yaml': text }) });
      return verdict(json(c.tools) === json({ 'filesystem.read_file': 'read', 'docs.create_draft': 'write' }) && c.problems.length === 5, json(c));
    },
  },
  {
    id: 'a-team-file-that-gives-a-shared-tool-a-different-tag-removes-that-tool',
    check() {
      const dir = dirWith({ 'shared.yaml': SHARED, 'support.yaml': 'tools:\n  filesystem.read_file: write\n' });
      const c = lib().loadToolConfig({ dir, team: 'support' });
      return verdict(!('filesystem.read_file' in c.tools) && c.tools['docs.create_draft'] === 'write' && c.problems.length === 1, json(c));
    },
  },
  {
    id: 'tool-names-are-matched-the-way-the-policy-matches-them',
    check() {
      const c = lib().loadToolConfig({ dir: dirWith({ 'shared.yaml': 'tools:\n  Filesystem.Read_File: read\n  "filesystem.read_filе": read\n' }) });
      return verdict(json(c.tools) === json({ 'filesystem.read_file': 'read' }) && c.problems.length === 1, json(c));
    },
  },
  {
    id: 'a-huge-file-is-refused',
    check() {
      const c = lib().loadToolConfig({ dir: dirWith({ 'shared.yaml': `tools:\n${Array.from({ length: 20000 }, (_, i) => `  a.t${i}: read`).join('\n')}\n` }) });
      return verdict(Object.keys(c.tools).length === 0 && c.problems.length > 0, `tools ${Object.keys(c.tools).length}`);
    },
  },
  {
    id: 'the-result-cannot-be-changed-by-the-caller',
    check() {
      const dir = dirWith({ 'shared.yaml': SHARED });
      const c = lib().loadToolConfig({ dir });
      try {
        c.tools['github.merge_pull_request'] = 'write';
        c.problems.push('x');
      } catch {
        // a frozen object may throw in strict mode: that is fine too
      }
      const again = lib().loadToolConfig({ dir });
      return verdict(!('github.merge_pull_request' in c.tools) && c.problems.length === 0 && Object.keys(again.tools).length === 2, json(c));
    },
  },

  // ---- Choosing the tools --------------------------------------------------------------------------
  {
    id: 'only-listed-tools-with-a-matching-tag-are-selected',
    check() {
      const config = { tools: { 'filesystem.read_file': 'read', 'docs.create_draft': 'write' }, problems: [] };
      const s = lib().selectTools({ catalogue: CATALOGUE, config });
      return verdict(s.tools.map((t) => t.name).sort().join() === 'docs.create_draft,filesystem.read_file' && s.problems.length === 0, json({ names: s.tools.map((t) => t.name), problems: s.problems }));
    },
  },
  {
    id: 'a-config-cannot-call-a-write-tool-read',
    check() {
      const config = { tools: { 'github.merge_pull_request': 'read', 'docs.create_draft': 'read', 'fetch.get': 'write' }, problems: [] };
      const s = lib().selectTools({ catalogue: CATALOGUE, config });
      return verdict(s.tools.length === 0 && s.problems.length === 3, json({ names: s.tools.map((t) => t.name), problems: s.problems }));
    },
  },
  {
    id: 'a-listed-tool-that-does-not-exist-is-reported-as-missing-not-an-error',
    check() {
      const config = { tools: { 'filesystem.read_file': 'read', 'nothing.here': 'read' }, problems: [] };
      const s = lib().selectTools({ catalogue: CATALOGUE, config });
      return verdict(s.tools.length === 1 && s.missing.join() === 'nothing.here' && s.problems.length === 0, json(s.missing));
    },
  },
  {
    id: 'selecting-never-throws-on-odd-input-and-gives-nothing',
    check() {
      for (const input of [undefined, null, {}, { catalogue: null }, { catalogue: [null, 5, {}], config: { tools: { 'a.b': 'read' } } }, { catalogue: CATALOGUE, config: null }, { catalogue: CATALOGUE, config: { tools: null } }, { catalogue: CATALOGUE, config: { tools: [] } }]) {
        let s;
        try {
          s = lib().selectTools(input);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(input)}: ${err.message}`);
        }
        if (s.tools.length !== 0) return verdict(false, `selected for ${json(input)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'the-config-never-adds-a-tool-the-catalogue-does-not-have',
    check() {
      const config = { tools: { 'razorpay.create_payout': 'write', 'evil.run': 'write' }, problems: [] };
      const s = lib().selectTools({ catalogue: CATALOGUE, config });
      return verdict(s.tools.length === 0, json(s.tools.map((t) => t.name)));
    },
  },

  // ---- The files that ship ---------------------------------------------------------------------------
  {
    id: 'the-shipped-shared-file-loads-clean-and-every-tool-in-it-exists-with-the-same-tag',
    check() {
      const { BUILTIN_TOOLS } = loadSubject('src/runtime/tools/builtin.js');
      const { createFilesystemTools } = loadSubject('src/runtime/tools/filesystem.js');
      const catalogue = [...BUILTIN_TOOLS, ...createFilesystemTools({ root: ROOT })];
      const c = lib().loadToolConfig({ dir: path.join(ROOT, 'config/mcp') });
      const names = Object.keys(c.tools);
      const known = new Set(catalogue.map((t) => t.name));
      // Tools of servers that need a key (GitHub, Fetch, Supabase) are checked in their own suites; here every listed
      // tool that does exist must carry the tag the tool itself declares.
      const wrong = names.filter((n) => known.has(n) && catalogue.find((t) => t.name === n).access !== c.tools[n]);
      return verdict(c.problems.length === 0 && names.length >= 6 && names.includes('filesystem.read_file') && names.includes('docs.create_draft') && wrong.length === 0, json({ problems: c.problems, names, wrong }));
    },
  },
  {
    id: 'the-shipped-shared-file-never-lists-a-tool-that-asks-the-founder-or-has-no-rule',
    check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const c = lib().loadToolConfig({ dir: path.join(ROOT, 'config/mcp') });
      const asks = Object.keys(c.tools).filter((n) => policy.listRules().some((r) => r.tool === n && r.alwaysAsks));
      const unruled = Object.keys(c.tools).filter((n) => !policy.isBuiltIn(n));
      return verdict(asks.length === 0 && unruled.length === 0, json({ asks, unruled }));
    },
  },
];

module.exports = {
  name: 'tool-config',
  description: 'Per-team tool config: shared.yaml plus a team file, every tool tagged read or write, an allow-list that fails closed, tag mismatches refused, team names cannot reach other files',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
