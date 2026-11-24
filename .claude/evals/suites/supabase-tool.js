'use strict';

// Grades the read-only Supabase tool (PLAN.md step 1.10: "Supabase (read-only for most agents)"):
//   src/runtime/tools/supabase.js   createSupabaseTools({ store }) -> [supabase.select]
//
//   supabase.select { table, where?, limit?, order? } -> { text }   rows as JSON, one per line
//
// The runtime's store uses the SERVICE key, which bypasses row-level security, so the tool is the only protection:
//   - only an allow-list of non-sensitive tables can be read (the audit log, decisions, the founder's policy table, run
//     checkpoints, memory, clients, pods and members are not on it)
//   - it can only SELECT: the store's insert and update are never reachable from it
//   - filters are equalities on plain column names; the limit is capped; the order is a plain "column.asc|desc"
//   - an error is one plain sentence: never the database's own message

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/tools/supabase.js';
const LOADER = 'src/runtime/tools/index.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';

/** A store with ONLY what the tool may use, recording every call. insert and update throw if they are ever touched. */
function fakeStore(rows = [{ id: 1, title: 'A task' }], over = {}) {
  const calls = [];
  const store = {
    calls,
    async select(table, options) {
      calls.push({ table, options });
      if (over.fails) throw new Error(`database said ${SECRET} postgres://user:pw@host/db`);
      return typeof rows === 'function' ? rows(table, options) : rows;
    },
    async insert() { throw new Error('INSERT REACHED'); },
    async update() { throw new Error('UPDATE REACHED'); },
  };
  return store;
}

async function run(store, args) {
  const tools = loadSubject(SUBJECT).createSupabaseTools({ store });
  const loader = loadSubject(LOADER).createToolLoader({ tools, hasRule: async () => true });
  await loader.load();
  try {
    const out = await loader.run({ action: { tool: 'supabase.select', access: 'read', args }, key: 'k' });
    return { ok: true, text: out.text };
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return { ok: false, message: err.message };
  }
}

const ALLOWED = ['tasks', 'projects', 'agents', 'scaling_rules'];
const NOT_ALLOWED = ['audit_log', 'decisions', 'policy_tools', 'graph_checkpoints', 'graph_writes', 'memory', 'clients', 'pods', 'pod_members', 'agent_events', 'TASKS', 'Tasks', 'tasks ', ' tasks', 'tasks?select=*', 'tasks;drop', '../tasks', 'public.tasks', 'pg_catalog.pg_user', 'information_schema.tables', '', 5, null, ['tasks'], {}];

const cases = [
  {
    id: 'the-tool-is-read-only-with-a-summary-and-a-policy-rule',
    check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const tools = loadSubject(SUBJECT).createSupabaseTools({ store: fakeStore() });
      const t = tools[0];
      return verdict(tools.length === 1 && t.name === 'supabase.select' && t.access === 'read' && t.summary.length > 10 && t.args.includes('table') && ALLOWED.every((a) => t.summary.includes(a) || t.args.includes(a)) && policy.isBuiltIn('supabase.select') && policy.checkAction({ tool: 'supabase.select', access: 'read', args: { table: 'tasks' } }).allowed === true, json(t && t.name));
    },
  },
  {
    id: 'without-a-store-that-can-select-there-is-no-tool',
    check() {
      const none = [undefined, null, {}, { select: 5 }, 'store'].map((store) => loadSubject(SUBJECT).createSupabaseTools({ store }).length);
      return verdict(none.every((n) => n === 0) && loadSubject(SUBJECT).createSupabaseTools().length === 0, json(none));
    },
  },
  {
    id: 'every-allowed-table-can-be-read-and-the-store-is-asked-exactly-once',
    async check() {
      for (const table of ALLOWED) {
        const store = fakeStore();
        const r = await run(store, { table });
        if (!r.ok || store.calls.length !== 1 || store.calls[0].table !== table) return verdict(false, `${table}: ${json(r)} calls ${store.calls.length}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'no-other-table-can-be-read-and-the-store-is-not-asked',
    async check() {
      const store = fakeStore();
      for (const table of NOT_ALLOWED) {
        const r = await run(store, { table });
        if (r.ok) return verdict(false, `read ${json(table)}`);
      }
      return verdict(store.calls.length === 0, `store calls: ${store.calls.length}`);
    },
  },
  {
    id: 'the-store-only-ever-gets-a-select-with-the-given-filters-limit-and-order',
    async check() {
      const store = fakeStore();
      const r = await run(store, { table: 'tasks', where: { status: 'queued', priority: 'P1', blocked_reason: null }, limit: 5, order: 'queued_at.desc' });
      const c = store.calls[0];
      return verdict(r.ok && json(c.options) === json({ where: { status: 'queued', priority: 'P1', blocked_reason: null }, order: 'queued_at.desc', limit: 5 }), json({ r, c }));
    },
  },
  {
    id: 'the-limit-defaults-to-twenty-and-more-than-fifty-is-refused',
    async check() {
      const store = fakeStore();
      await run(store, { table: 'tasks' });
      const def = store.calls[0].options.limit;
      const bad = [];
      for (const limit of [0, -1, 51, 1000, 1.5, '5', null, NaN, Infinity]) bad.push((await run(store, { table: 'tasks', limit })).ok);
      const fifty = await run(store, { table: 'tasks', limit: 50 });
      return verdict(def === 20 && bad.every((b) => b === false) && fifty.ok, json({ def, bad }));
    },
  },
  {
    id: 'filters-must-be-plain-columns-with-plain-values',
    async check() {
      const store = fakeStore();
      const bad = [{ 'a;b': 1 }, { 'a b': 1 }, { 'a.b': 1 }, { '': 1 }, { 'status=eq.x&select': 1 }, { status: { $ne: 'x' } }, { status: ['a'] }, { status: undefined }, { status: () => 1 }, 'status=queued', ['status'], 5, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`c${i}`, 1]))];
      for (const where of bad) {
        const r = await run(store, { table: 'tasks', where });
        if (r.ok) return verdict(false, `accepted ${json(where)}`);
      }
      const good = await run(store, { table: 'tasks', where: { status: 'queued', n: 5, flag: true, none: null } });
      return verdict(store.calls.length === 1 && good.ok, `store calls: ${store.calls.length}`);
    },
  },
  {
    id: 'the-order-must-be-a-plain-column-and-a-direction',
    async check() {
      const store = fakeStore();
      for (const order of ['queued_at', 'queued_at.sideways', 'queued_at.asc,id.desc', 'a b.asc', '.asc', '', 5, null, 'x;y.asc', 'a.b.asc']) {
        const r = await run(store, { table: 'tasks', order });
        if (r.ok) return verdict(false, `accepted ${json(order)}`);
      }
      const ok = await run(store, { table: 'tasks', order: 'queued_at.asc' });
      return verdict(store.calls.length === 1 && ok.ok, `store calls: ${store.calls.length}`);
    },
  },
  {
    id: 'unknown-arguments-and-odd-argument-objects-are-refused',
    async check() {
      const store = fakeStore();
      for (const args of [{ table: 'tasks', columns: '*' }, { table: 'tasks', select: 'id' }, { table: 'tasks', extra: 1 }, {}, null, 'tasks', ['tasks'], undefined]) {
        const r = await run(store, args);
        if (r.ok) return verdict(false, `accepted ${json(args)}`);
      }
      return verdict(store.calls.length === 0, `store calls: ${store.calls.length}`);
    },
  },
  {
    id: 'rows-come-back-as-json-one-per-line-and-an-empty-result-says-so',
    async check() {
      const rows = [{ id: 1, title: 'Draft the note', done: false, meta: { a: [1, 2] } }, { id: 2, title: 'Line\nbreak "quoted" — ₹500', done: true, meta: null }];
      const r = await run(fakeStore(rows), { table: 'tasks' });
      const lines = r.ok ? r.text.split('\n') : [];
      const parsed = lines.map((l) => JSON.parse(l));
      const empty = await run(fakeStore([]), { table: 'tasks' });
      return verdict(r.ok && lines.length === 2 && json(parsed) === json(rows) && empty.ok && /no rows/i.test(empty.text), json({ r, empty }));
    },
  },
  {
    id: 'a-large-result-is-cut-and-says-so',
    async check() {
      const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, notes: 'x'.repeat(2000) }));
      const r = await run(fakeStore(rows), { table: 'tasks', limit: 50 });
      return verdict(r.ok && r.text.length < 20_000 && /cut|shortened|more/i.test(r.text.slice(-200)), `length ${r.text && r.text.length}`);
    },
  },
  {
    id: 'a-result-that-is-not-a-list-of-rows-is-a-failure',
    async check() {
      for (const rows of [null, undefined, 5, 'x', {}, { rows: [] }]) {
        const r = await run(fakeStore(() => rows), { table: 'tasks' });
        if (r.ok) return verdict(false, `accepted ${json(rows)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-database-error-never-reaches-the-caller-and-insert-and-update-are-never-touched',
    async check() {
      const store = fakeStore([], { fails: true });
      const r = await run(store, { table: 'tasks' });
      const direct = await (async () => {
        try {
          await loadSubject(SUBJECT).createSupabaseTools({ store })[0].run({ args: { table: 'tasks' }, key: 'k' });
          return null;
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return err;
        }
      })();
      const shown = `${json(r)}${direct && direct.message}${direct && direct.stack}`;
      return verdict(r.ok === false && direct && !shown.includes(SECRET) && !/postgres|database said|INSERT REACHED|UPDATE REACHED/.test(shown), shown.slice(0, 200));
    },
  },
];

module.exports = {
  name: 'supabase-tool',
  description: 'Read-only Supabase tool: an allow-list of non-sensitive tables, select only, plain filters, capped limit, plain order, JSON rows cut to a limit, no database error text',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
