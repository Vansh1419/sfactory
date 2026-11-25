'use strict';

// Grades the Audit log page (PLAN.md step 4.3). "Done when: any action from the gate tests can be found by search."
//   src/runtime/audit-search.js   createAuditSearch({ store, now? })
//     .search({ text?, action?, actorType?, podId?, since?, until?, before?, limit? })
//        -> { entries: [{ id, at, actorType, action, target, podId, summary }], more, scanned }
//   src/runtime/commands.js       audit.search (read only)
//   src/renderer/audit.mjs        searchFormView(form), auditRowsView(result, now)  (the logic behind AuditPanel.jsx)
//   src/preload.js                window.api.audit.search
//
// Runs against a REAL Postgres with the real migrations and the real services of the engineering test world (pods opened from founder cards, decisions,
// the audit writer), plus the kind of entries the gates leave (agent tool runs, tasks, outbound messages).
//
//   - the done-when: every action the gate scenarios write is found by its exact name, and by words from it
//   - filters combine: who did it (founder, an agent, the system), which project, a time range; words all have to match, in any letter case
//   - results are newest first, page by page (`before`), with `more` and an honest `scanned` (the store filters on equality only, so a search reads a
//     bounded window of the newest entries and says how many it looked at)
//   - an entry is shown in plain words: never a secret (they are removed when written, and again here), never a control character, never too long
//   - bad arguments are refused; odd entries never throw; the page shows text only and has no timer

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');
const { buildWorld } = require('../engineering-world');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SECRET = 'gsk_a1B2c3D4a1B2c3D4a1B2c3D4a1B2c3D4';
const AGENT = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const NOW = new Date('2026-11-26T12:00:00.000Z');

// What the gate scenarios write (scripts/gate1.js, gate2.js and gate3.js name these in their audit checks), written here the way the services write them.
const GATE_ACTIONS = [
  ['system', 'runtime.started', {}], ['system', 'decision.created', { category: 'spend', tool: 'refund.issue' }], ['founder', 'decision.resolve', { id: 'x', decision: 'approved' }],
  ['agent', 'task.created', { team: 'support', title: 'Answer a ticket' }], ['agent', 'task.status_changed', { team: 'support', from: 'queued', to: 'in_progress' }],
  ['agent', 'agent.tool_run', { team: 'marketing_sales', agent: 'Scout', tool: 'search.web', step: 1 }], ['agent', 'agent.tool_run', { team: 'product_engineering', agent: 'Dev', tool: 'git.push_branch', step: 6 }],
  ['system', 'outbound.drafted', { team: 'support' }], ['system', 'outbound.reviewed', { verdict: 'pass' }], ['system', 'outbound.awaiting_founder', {}], ['system', 'outbound.sent', { to: 'a@example.com' }],
  ['system', 'pod.opened', { name: 'Alpha Site' }], ['system', 'orchestrator.waiting', {}], ['founder', 'tasks.rebalanced', {}], ['system', 'digest.sent', { date: '2026-11-26' }],
];

async function world() {
  const w = await buildWorld('auditsearch');
  const { createAuditSearch } = loadSubject('src/runtime/audit-search.js');
  const search = createAuditSearch({ store: w.store, now: () => NOW });
  if (!w.seeded) {
    w.seeded = true;
    for (const [actorType, action, detail] of GATE_ACTIONS) {
      await w.audit.append({ actorType, ...(actorType === 'agent' ? { actorId: AGENT } : {}), action, detail });
    }
    await w.audit.append({ actorType: 'agent', actorId: AGENT, podId: w.A.podId, action: 'agent.tool_run', detail: { team: 'product_engineering', agent: 'Dev', tool: 'pod.write_file', token: SECRET, note: `used ${SECRET} here` } });
    await w.audit.append({ actorType: 'system', action: 'weird.entry', detail: { nested: { deep: { deeper: ['a', { b: 'c'.repeat(5000) }] } }, text: 'line one\nline two\u0007bell' } });
  }
  return { w, search };
}

const cases = [
  {
    id: 'a-done-when-every-action-the-gates-write-is-found-by-its-name-and-by-words-from-it',
    async run() {
      const { w, search } = await world();
      const all = await w.store.select('audit_log', { where: {}, limit: 5000 });
      const actions = [...new Set(all.map((r) => r.action))];
      const missed = [];
      for (const action of actions) {
        const byName = await search.search({ action });
        const byWords = await search.search({ text: action });
        if (byName.entries.length === 0 || !byName.entries.every((e) => e.action === action) || !byWords.entries.some((e) => e.action === action)) missed.push(action);
      }
      const tool = await search.search({ text: 'git.push_branch' });
      const word = await search.search({ text: 'Scout search.web' });
      const gate = GATE_ACTIONS.every(([, action]) => actions.includes(action));
      return verdict(missed.length === 0 && actions.length >= 15 && gate && tool.entries.length >= 1 && tool.entries.every((e) => /git\.push_branch/.test(JSON.stringify(e))) && word.entries.length >= 1,
        `actions ${actions.length}; not found ${json(missed)}; gate actions present ${gate}; tool ${tool.entries.length}; words ${word.entries.length}`);
    },
  },
  {
    id: 'b-filters-combine-who-which-project-and-when-and-all-the-words-must-match-in-any-letter-case',
    async run() {
      const { w, search } = await world();
      const founder = await search.search({ actorType: 'founder' });
      const agent = await search.search({ actorType: 'agent' });
      const pod = await search.search({ podId: w.A.podId });
      const both = await search.search({ actorType: 'agent', podId: w.A.podId });
      const upper = await search.search({ text: 'PRODUCT_ENGINEERING dev' });
      const none = await search.search({ text: 'dev nothing-like-this-word' });
      const future = await search.search({ since: '2999-01-01T00:00:00.000Z' });
      const past = await search.search({ until: '2000-01-01T00:00:00.000Z' });
      const window = await search.search({ since: '2000-01-01T00:00:00.000Z', until: '2999-01-01T00:00:00.000Z', limit: 5 });
      return verdict(founder.entries.length >= 2 && founder.entries.every((e) => e.actorType === 'founder') && agent.entries.every((e) => e.actorType === 'agent') && pod.entries.length >= 1 && pod.entries.every((e) => e.podId === w.A.podId)
        && both.entries.length === 1 && upper.entries.length >= 2 && none.entries.length === 0 && future.entries.length === 0 && past.entries.length === 0 && window.entries.length === 5,
        `founder ${founder.entries.length}; agent ${agent.entries.length}; pod ${pod.entries.length}; both ${both.entries.length}; upper ${upper.entries.length}; none ${none.entries.length}; future ${future.entries.length}; past ${past.entries.length}; window ${window.entries.length}`);
    },
  },
  {
    id: 'c-results-come-newest-first-page-by-page-with-more-and-an-honest-count-of-what-was-looked-at',
    async run() {
      const { search } = await world();
      const first = await search.search({ limit: 4 });
      const second = await search.search({ limit: 4, before: first.entries.at(-1).id });
      const ids = [...first.entries, ...second.entries].map((e) => e.id);
      const descending = ids.every((id, i) => i === 0 || id < ids[i - 1]);
      const everything = await search.search({ limit: 100 });
      const last = await search.search({ limit: 100, before: everything.entries.at(-1).id });
      return verdict(first.entries.length === 4 && first.more === true && second.entries.length === 4 && descending && new Set(ids).size === 8 && Number.isInteger(first.scanned) && first.scanned >= 4 && first.scanned <= 5000
        && last.entries.length === 0 && last.more === false && everything.entries.length <= 100, `first ${first.entries.length}/${first.more}; second ${second.entries.length}; descending ${descending}; scanned ${first.scanned}; after the last ${last.entries.length}/${last.more}`);
    },
  },
  {
    id: 'd-an-entry-is-plain-words-with-no-secret-no-control-character-and-nothing-too-long-and-odd-entries-never-throw',
    async run() {
      const { w, search } = await world();
      const result = await search.search({ limit: 100 });
      const text = json(result);
      const weird = result.entries.find((e) => e.action === 'weird.entry');
      const secretRow = result.entries.find((e) => e.podId === w.A.podId && e.action === 'agent.tool_run');
      // eslint-disable-next-line no-control-regex
      const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
      const { createAuditSearch } = loadSubject('src/runtime/audit-search.js');
      const odd = createAuditSearch({ store: { select: async () => [{ id: 1, at: 'not a date', actor_type: 'agent', action: 'x.y', detail: null }, { id: 2, at: NOW.toISOString(), actor_type: 'system', action: 'a.b', detail: 'a string' }, { id: 3, at: NOW.toISOString(), actor_type: 'system', action: 'c.d', detail: { sb: `key ${SECRET}` } }, null] }, now: () => NOW });
      const survived = await odd.search({});
      return verdict(!text.includes(SECRET) && secretRow && /redacted/.test(secretRow.summary) && weird && weird.summary.length <= 300 && !controls && result.entries.every((e) => e.summary.length <= 300 && typeof e.summary === 'string')
        && survived.entries.length === 3 && !json(survived).includes(SECRET),
        `secret leaked ${text.includes(SECRET)}; controls ${controls}; weird summary ${weird?.summary?.length}; odd rows ${survived.entries.length}; secret row ${secretRow?.summary}`);
    },
  },
  {
    id: 'e-bad-arguments-are-refused-and-the-limit-is-held',
    async run() {
      const { search } = await world();
      const refused = [];
      for (const bad of [null, 'x', [], { limit: 0 }, { limit: 101 }, { limit: 'many' }, { text: 5 }, { text: 'x'.repeat(201) }, { action: '' }, { action: 'a'.repeat(101) }, { actorType: 'robot' }, { podId: 'not-an-id' }, { since: 'yesterday' }, { until: 5 }, { before: -1 }, { before: 'x' }, { extra: 1 }]) {
        try {
          await search.search(bad);
          refused.push(`accepted ${json(bad).slice(0, 40)}`);
        } catch (err) {
          if (err.name !== 'AuditSearchError' || !err.code) refused.push(`odd error ${json(bad).slice(0, 40)}`);
        }
      }
      const empty = await search.search({});
      const defaults = empty.entries.length <= 50;
      return verdict(refused.length === 0 && defaults, `${json(refused)}; default page ${empty.entries.length}`);
    },
  },
  {
    id: 'f-the-command-searches-read-only-checks-its-arguments-and-needs-the-service',
    async run() {
      const { w, search } = await world();
      const { createRuntime } = loadSubject('src/runtime/runtime.js');
      const { registerCommands } = loadSubject('src/runtime/commands.js');
      const entries = [];
      const runtime = createRuntime({ audit: { append: async (e) => { entries.push(e); } } });
      registerCommands(runtime, { store: w.store, auditSearch: search });
      const bare = createRuntime({ audit: { append: async () => {} } });
      registerCommands(bare, { store: w.store });
      const call = (rt, args) => rt.invoke('audit.search', args, { actor: 'founder' });
      const before = (await w.store.select('audit_log', { where: {}, limit: 5000 })).length;
      const ok = await call(runtime, { text: 'git.push_branch', limit: 5 });
      const bad = [await call(runtime, { limit: 500 }), await call(runtime, { actorType: 'robot' }), await call(runtime, { podId: 'x' }), await call(runtime, { extra: 1 }), await call(runtime, { text: 5 })];
      const offline = await call(bare, {});
      const after = (await w.store.select('audit_log', { where: {}, limit: 5000 })).length;
      return verdict(ok.ok && Array.isArray(ok.data.entries) && ok.data.entries.length >= 1 && bad.every((r) => r.ok === false && r.error.code === 'invalid_args') && offline.ok === false && offline.error.code === 'not_available' && after === before && entries.some((e) => e.action === 'command.audit.search'),
        `ok ${json(ok).slice(0, 120)}; bad ${json(bad.map((r) => r.error?.code))}; offline ${json(offline)}; rows ${before} -> ${after}`);
    },
  },
  {
    id: 'g-the-pages-logic-turns-the-form-into-a-search-and-the-result-into-plain-rows-in-indias-time',
    async run() {
      const mod = await loadSubject('src/renderer/audit.mjs');
      const form = mod.searchFormView({ text: '  git.push_branch  ', action: '', who: 'agent', hours: '24', podId: '' }, NOW);
      const plain = mod.searchFormView({ text: '', who: '', hours: '' }, NOW);
      const bad = [mod.searchFormView(null, NOW), mod.searchFormView({ text: 'x'.repeat(300) }, NOW), mod.searchFormView({ hours: '-3' }, NOW), mod.searchFormView({ who: 'robot' }, NOW)];
      const rows = mod.auditRowsView({ entries: [{ id: 9, at: '2026-11-26T05:00:00.000Z', actorType: 'agent', action: 'agent.tool_run', target: '', podId: null, summary: 'team: support · tool: <b>git.commit</b>' }, null, { id: 8, at: 'garbage', actorType: 'weird', action: 'x.y', summary: 5 }], more: true, scanned: 120 }, NOW);
      return verdict(form.ok && form.args.text === 'git.push_branch' && form.args.actorType === 'agent' && form.args.since === '2026-11-25T12:00:00.000Z' && plain.ok && Object.keys(plain.args).length === 0
        && bad.every((r) => r.ok === false && typeof r.problem === 'string') && rows.rows.length === 2 && rows.rows[0].when === '26 Nov 2026, 10:30 IST' && rows.rows[0].who === 'An agent' && /<b>git\.commit<\/b>/.test(rows.rows[0].summary)
        && rows.rows[1].when === '' && rows.rows[1].summary === '' && rows.more === true && /120/.test(rows.note),
        `form ${json(form)}; plain ${json(plain)}; rows ${json(rows)}`);
    },
  },
  {
    id: 'h-the-page-shows-text-only-has-no-timer-and-the-app-and-preload-wire-it-in',
    check() {
      const panel = fs.existsSync(path.join(ROOT, 'src/renderer/AuditPanel.jsx')) ? read('src/renderer/AuditPanel.jsx') : '';
      const app = read('src/renderer/App.jsx');
      const preload = read('src/preload.js');
      const runtime = read('src/runtime/index.js');
      const problems = [
        ...(/dangerouslySetInnerHTML|innerHTML/.test(panel) ? ['the page builds markup'] : []),
        ...(/setInterval/.test(panel) ? ['the page has a timer'] : []),
        ...(/window\.api\.audit\.search/.test(panel) ? [] : ['the page does not call window.api.audit.search']),
        ...(/AuditPanel/.test(app) ? [] : ['App.jsx does not show the page']),
        ...(/audit:\s*\{\s*search/.test(preload) && /audit\.search/.test(preload) ? [] : ['the preload lacks audit.search']),
        ...(/createAuditSearch\(/.test(runtime) && /auditSearch/.test(runtime) ? [] : ['createApp does not build and register the search']),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
];

module.exports = {
  name: 'audit-search',
  description: 'The Audit log page (step 4.3): every action searchable by name, words, who, project and time, in plain words with no secret',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check ? c.check() : c.run();
  },
};
