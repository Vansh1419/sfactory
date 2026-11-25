'use strict';

// Grades the runtime core and the IPC guard (PLAN.md step 1.2). The modules do not
// exist yet, so every case reports "pending" until they are written.
//
// Contracts the implementation must satisfy (nothing here touches Electron or a network):
//
//   src/runtime/config.js    loadConfig(env) -> { ok: true, config } | { ok: false, problems: string[] }
//                            config.supabase = { url, serviceKey }; problems name variables, never values
//                            describeConfig(config) -> a printable summary with secrets masked
//   src/runtime/audit.js     createAudit(store).append({ actorType, actorId?, podId?, action, targetType?, targetId?, detail? })
//                            writes one audit_log row (snake_case columns), redacts secrets in `detail`,
//                            rejects invalid entries (throws, writes nothing). redactDetail(detail) is exported.
//   src/runtime/runtime.js   createRuntime({ audit }) -> { register, invoke, commands, on, emit, stop, block }
//                            register(name, { handler, validate?, audit?: 'always'|'never', allowWhenBlocked?, auditArgs? })
//                            auditArgs(args) -> the object recorded as the entry's `args` instead of all of them (for free text
//                            that should not sit in the log); the handler still receives every argument; if it throws,
//                            an empty object is recorded
//                            invoke(name, args, { actor? }) never throws and returns
//                              { ok: true, data } | { ok: false, error: { code, message } }
//                            CommandError(code, message) is exported; its code and message reach the caller as-is,
//                            any other thrown error becomes { code: 'internal_error', message: <generic> }
//                            error codes: unknown_command, invalid_args, audit_unavailable, internal_error,
//                              runtime_stopped, runtime_not_configured
//   src/runtime/commands.js  registerCommands(runtime, { store, decisions?, orchestrator? }) registers exactly:
//                            runtime.status, decisions.list, decisions.resolve, agents.pause, goals.list
//                            goals.list({ limit? }) returns { goals } from orchestrator.listGoals({ limit });
//                            with no orchestrator it answers "not_available"
//                            decisions.resolve calls decisions.resolve({ id, decision, via: 'dashboard', note? })
//                            on the decisions service (src/runtime/decisions.js, step 1.6); a DecisionError
//                            keeps its code and message, anything else is generic; with no service the
//                            command answers "not_available". The caller cannot choose `via`.
//   src/ipc-guard.js         isTrustedSender(url, { rendererFileUrl, rendererDevUrl? }) -> boolean
//                            parseInvoke(payload) -> { command, args } | null
//
//   The store is { insert(table, row), select(table, { where, order, limit }), update(table, where, patch) }.

const { loadSubject } = require('../lib');

const CONFIG = 'src/runtime/config.js';
const AUDIT = 'src/runtime/audit.js';
const RUNTIME = 'src/runtime/runtime.js';
const COMMANDS = 'src/runtime/commands.js';
const GUARD = 'src/ipc-guard.js';

const UUID = '00000000-0000-4000-8000-000000000001';
const NOT_FOUND = '00000000-0000-4000-8000-000000000002';
const BROKEN = '00000000-0000-4000-8000-000000000003';
const KEY = 'sb_secret_' + 'k'.repeat(30);

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (x) => JSON.stringify(x);

/** A store that records every call, and can fail inserts or throw on select. */
function fakeStore({ failInserts = false, rows = {}, selectError } = {}) {
  const log = [];
  return {
    log,
    async insert(table, row) {
      log.push(['insert', table, row]);
      if (failInserts) throw new Error('database is down');
      return { ...row };
    },
    async select(table, query) {
      log.push(['select', table, query]);
      if (selectError) throw selectError;
      return rows[table] ?? [];
    },
    async update(table, where, patch) {
      log.push(['update', table, where, patch]);
      return [];
    },
  };
}

function setup(storeOptions) {
  const store = fakeStore(storeOptions);
  const { createAudit } = loadSubject(AUDIT);
  const { createRuntime, CommandError } = loadSubject(RUNTIME);
  const runtime = createRuntime({ audit: createAudit(store) });
  return { store, runtime, CommandError };
}

function setupWithCommands(storeOptions, extra = {}) {
  const s = setup(storeOptions);
  loadSubject(COMMANDS).registerCommands(s.runtime, { store: s.store, ...extra });
  return s;
}

const inserts = (store) => store.log.filter((e) => e[0] === 'insert');

const cases = [
  // ---- config -----------------------------------------------------------
  {
    id: 'config-requires-the-supabase-settings',
    async check() {
      const r = loadSubject(CONFIG).loadConfig({});
      const ok = r.ok === false && r.problems.some((p) => p.includes('SUPABASE_URL')) && r.problems.some((p) => p.includes('SUPABASE_SERVICE_ROLE_KEY'));
      return verdict(ok, `got ${json(r)}`);
    },
  },
  {
    id: 'config-rejects-a-url-that-is-not-supabase-or-local',
    async check() {
      const r = loadSubject(CONFIG).loadConfig({ SUPABASE_URL: 'https://evil.example.com', SUPABASE_SERVICE_ROLE_KEY: KEY });
      return verdict(r.ok === false && !json(r).includes(KEY), `got ${json(r)}`);
    },
  },
  {
    id: 'config-accepts-supabase-and-local-urls',
    async check() {
      const { loadConfig } = loadSubject(CONFIG);
      const a = loadConfig({ SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY });
      const b = loadConfig({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: KEY });
      const ok = a.ok && b.ok && a.config.supabase.url.startsWith('https://abcd.supabase.co') && a.config.supabase.serviceKey === KEY;
      return verdict(ok, `got ${json([a.ok, b.ok])}`);
    },
  },
  {
    id: 'a-config-description-never-contains-the-key',
    async check() {
      const { loadConfig, describeConfig } = loadSubject(CONFIG);
      const { config } = loadConfig({ SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY });
      const text = typeof describeConfig(config) === 'string' ? describeConfig(config) : json(describeConfig(config));
      return verdict(!text.includes(KEY) && !text.includes('k'.repeat(20)), `description was ${text}`);
    },
  },

  // ---- audit ------------------------------------------------------------
  {
    id: 'audit-redacts-secrets-before-writing',
    async check() {
      const { store } = setup();
      const { createAudit } = loadSubject(AUDIT);
      await createAudit(store).append({
        actorType: 'agent',
        action: 'tool.call',
        detail: {
          api_key: 'SECRETVALUE1',
          nested: { Authorization: 'Bearer BEARERSECRET' },
          note: `used gsk_${'a'.repeat(30)} to call`,
          jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJl',
          safe: 'hello',
        },
      });
      const written = json(inserts(store)[0]?.[2]);
      const leaked = ['SECRETVALUE1', 'BEARERSECRET', 'gsk_aaaa', 'eyJhbGci'].filter((s) => written.includes(s));
      return verdict(leaked.length === 0 && written.includes('hello'), `leaked: ${leaked.join(', ') || 'none'}; kept safe value: ${written.includes('hello')}`);
    },
  },
  {
    id: 'audit-rejects-an-invalid-entry-and-writes-nothing',
    async check() {
      const { store } = setup();
      const { createAudit } = loadSubject(AUDIT);
      let threw = 0;
      for (const bad of [{ actorType: 'robot', action: 'x' }, { actorType: 'agent', action: '' }, { actorType: 'agent' }, null]) {
        try {
          await createAudit(store).append(bad);
        } catch {
          threw += 1;
        }
      }
      return verdict(threw === 4 && inserts(store).length === 0, `rejected ${threw} of 4, rows written: ${inserts(store).length}`);
    },
  },
  {
    id: 'audit-writes-one-row-with-snake-case-columns',
    async check() {
      const { store } = setup();
      const { createAudit } = loadSubject(AUDIT);
      await createAudit(store).append({ actorType: 'founder', actorId: UUID, podId: UUID, action: 'a.b', targetType: 'decision', targetId: UUID, detail: { x: 1 } });
      const [call] = inserts(store);
      const row = call?.[2] ?? {};
      const ok = call?.[1] === 'audit_log' && row.actor_type === 'founder' && row.pod_id === UUID && row.target_type === 'decision' && row.target_id === UUID && row.actor_id === UUID && row.action === 'a.b' && row.detail?.x === 1;
      return verdict(ok, `wrote ${json(call)}`);
    },
  },

  // ---- runtime core -----------------------------------------------------
  {
    id: 'an-unknown-command-is-refused-and-not-audited',
    async check() {
      const { store, runtime } = setup();
      const r = await runtime.invoke('does.not.exist', {});
      return verdict(r.ok === false && r.error.code === 'unknown_command' && store.log.length === 0, `got ${json(r)}, store calls: ${store.log.length}`);
    },
  },
  {
    id: 'invalid-arguments-are-refused-before-anything-runs',
    async check() {
      const { store, runtime } = setup();
      let ran = 0;
      runtime.register('echo', { handler: async (a) => { ran += 1; return a; } });
      const bad = ['a string', [1, 2], null, { big: 'x'.repeat(30000) }];
      const codes = [];
      for (const args of bad) codes.push((await runtime.invoke('echo', args)).error?.code);
      return verdict(codes.every((c) => c === 'invalid_args') && ran === 0 && store.log.length === 0, `codes ${json(codes)}, handler ran ${ran} times, store calls ${store.log.length}`);
    },
  },
  {
    id: 'the-audit-entry-is-written-before-the-handler-runs',
    async check() {
      const { store, runtime } = setup();
      runtime.register('act', { handler: async () => { store.log.push(['handler']); return { done: true }; } });
      const r = await runtime.invoke('act', { n: 1 });
      const order = store.log.map((e) => e[0]);
      const entry = inserts(store)[0]?.[2];
      return verdict(r.ok && order[0] === 'insert' && order[1] === 'handler' && entry?.action === 'command.act', `order ${json(order)}, first row ${json(entry)}`);
    },
  },
  {
    id: 'if-the-audit-write-fails-the-command-does-not-run',
    async check() {
      const { runtime } = setup({ failInserts: true });
      let ran = 0;
      runtime.register('act', { handler: async () => { ran += 1; } });
      const r = await runtime.invoke('act', {});
      return verdict(r.ok === false && r.error.code === 'audit_unavailable' && ran === 0, `got ${json(r)}, handler ran ${ran} times`);
    },
  },
  {
    id: 'a-crashing-handler-returns-a-generic-error-and-is-audited',
    async check() {
      const { store, runtime } = setup();
      runtime.register('crash', { handler: async () => { throw new Error('boom SECRETVALUE9 at /home/user/file.js:12'); } });
      const r = await runtime.invoke('crash', {});
      const shown = json(r);
      const leaked = ['boom', 'SECRETVALUE9', '/home/user', 'file.js'].filter((s) => shown.includes(s));
      const failureAudited = inserts(store).some((e) => e[2].action === 'command.crash.failed');
      return verdict(r.ok === false && r.error.code === 'internal_error' && leaked.length === 0 && failureAudited, `got ${shown}; leaked ${leaked.join(', ') || 'none'}; failure audited ${failureAudited}`);
    },
  },
  {
    id: 'a-command-error-passes-its-code-and-message-through',
    async check() {
      const { runtime, CommandError } = setup();
      runtime.register('later', { handler: async () => { throw new CommandError('not_implemented', 'Built in a later step.'); } });
      const r = await runtime.invoke('later', {});
      return verdict(r.ok === false && r.error.code === 'not_implemented' && r.error.message === 'Built in a later step.', `got ${json(r)}`);
    },
  },
  {
    id: 'a-never-audited-command-skips-the-log-and-works-without-a-database',
    async check() {
      const { store, runtime } = setup({ failInserts: true });
      runtime.register('ping', { audit: 'never', handler: async () => ({ pong: true }) });
      const r = await runtime.invoke('ping', {});
      return verdict(r.ok && r.data.pong === true && inserts(store).length === 0, `got ${json(r)}, inserts ${inserts(store).length}`);
    },
  },
  {
    id: 'events-reach-subscribers-and-a-bad-listener-breaks-nothing',
    async check() {
      const { runtime } = setup();
      const seen = [];
      const off = runtime.on('x', (d) => seen.push(['x', d.n]));
      runtime.on('*', (e) => seen.push(['*', e.type, e.data?.n]));
      runtime.on('x', () => { throw new Error('bad listener'); });
      try {
        runtime.emit('x', { n: 1 });
        off();
        runtime.emit('x', { n: 2 });
      } catch (err) {
        return verdict(false, `emit threw: ${err.message}`);
      }
      return verdict(json(seen) === json([['x', 1], ['*', 'x', 1], ['*', 'x', 2]]), `seen ${json(seen)}`);
    },
  },
  {
    id: 'a-stopped-runtime-refuses-every-command',
    async check() {
      const { runtime } = setup();
      let ran = 0;
      runtime.register('act', { handler: async () => { ran += 1; } });
      await runtime.stop();
      const r = await runtime.invoke('act', {});
      return verdict(r.ok === false && r.error.code === 'runtime_stopped' && ran === 0, `got ${json(r)}, ran ${ran}`);
    },
  },
  {
    id: 'a-blocked-runtime-refuses-actions-but-still-answers-status',
    async check() {
      const { runtime } = setup();
      let ran = 0;
      runtime.register('act', { handler: async () => { ran += 1; } });
      runtime.register('status', { audit: 'never', allowWhenBlocked: true, handler: async () => ({ ready: false }) });
      runtime.block('Missing settings: SUPABASE_URL');
      const act = await runtime.invoke('act', {});
      const status = await runtime.invoke('status', {});
      const ok = act.error?.code === 'runtime_not_configured' && act.error.message.includes('SUPABASE_URL') && ran === 0 && status.ok === true;
      return verdict(ok, `act ${json(act)}, status ${json(status)}`);
    },
  },

  // ---- commands ---------------------------------------------------------
  {
    // A deliberate guard: a new window command is a new capability, so adding one means updating this list.
    // goals.list (step 1.9 follow-up, Nov 24, 2026) is how the window shows the founder's goals.
    id: 'the-runtime-registers-exactly-the-planned-commands',
    async check() {
      const { runtime } = setupWithCommands();
      return verdict(json(runtime.commands().sort()) === json(['agents.pause', 'brief.get', 'decisions.list', 'decisions.resolve', 'files.beginEdit', 'files.endEdit', 'files.history', 'files.pods', 'files.read', 'files.save', 'files.tree', 'files.upload', 'goals.list', 'runtime.status', 'teams.list', 'teams.startLead', 'teams.startTicket']), `got ${json(runtime.commands())}`);
    },
  },
  {
    id: 'goals-list-returns-the-orchestrators-goals-and-limits-the-size',
    async check() {
      const calls = [];
      const goals = [{ threadId: 'a', status: 'waiting', goal: 'Buy a domain' }];
      const orchestrator = { async listGoals(args) { calls.push(args); return goals; } };
      const { runtime } = setupWithCommands({}, { orchestrator });
      const plain = await runtime.invoke('goals.list', {});
      const limited = await runtime.invoke('goals.list', { limit: 5 });
      const bad = [await runtime.invoke('goals.list', { limit: 51 }), await runtime.invoke('goals.list', { limit: 0 }), await runtime.invoke('goals.list', { limit: 'x' }), await runtime.invoke('goals.list', { status: 'done' })];
      const ok = plain.ok && json(plain.data.goals) === json(goals) && limited.ok && calls.length === 2 && calls[0].limit <= 50 && calls[1].limit === 5 && bad.every((r) => r.error?.code === 'invalid_args');
      return verdict(ok, `plain ${json(plain)}, calls ${json(calls)}, bad ${json(bad.map((r) => r.error?.code))}`);
    },
  },
  {
    // teams.list (step 2.5, Nov 25, 2026) is how the window's Teams page shows each team's agents, open tasks and blocked tasks.
    id: 'teams-list-returns-the-overview-and-takes-no-options',
    async check() {
      let calls = 0;
      const overview = { at: '2026-11-25T10:00:00.000Z', teams: [{ team: 'support', label: 'Customer Support', agents: [], counts: {}, open: [], blocked: [] }] };
      const { runtime } = setupWithCommands({}, { teams: { async list() { calls += 1; return overview; } } });
      const plain = await runtime.invoke('teams.list', {});
      const bad = [await runtime.invoke('teams.list', { limit: 5 }), await runtime.invoke('teams.list', { team: 'support' })];
      return verdict(plain.ok && json(plain.data) === json(overview) && calls === 1 && bad.every((r) => r.error?.code === 'invalid_args'), `plain ${json(plain)}, calls ${calls}, bad ${json(bad.map((r) => r.error?.code))}`);
    },
  },
  {
    id: 'teams-list-without-an-overview-says-not-available-and-a-failure-is-generic',
    async check() {
      const none = await setupWithCommands().runtime.invoke('teams.list', {});
      const failing = await setupWithCommands({}, { teams: { async list() { throw new Error('connection to db.internal failed SECRETVALUE5'); } } }).runtime.invoke('teams.list', {});
      return verdict(none.error?.code === 'not_available' && failing.error?.code === 'internal_error' && !json(failing).includes('SECRETVALUE5') && !json(failing).includes('db.internal'), json({ none, failing }));
    },
  },
  {
    id: 'teams-list-is-audited-like-any-other-command',
    async check() {
      const { store, runtime } = setupWithCommands({}, { teams: { async list() { return { at: 'x', teams: [] }; } } });
      await runtime.invoke('teams.list', {});
      return verdict(inserts(store).some((e) => e[1] === 'audit_log' && e[2].action === 'command.teams.list'), json(inserts(store).map((e) => e[2].action)));
    },
  },
  {
    // brief.get (step 2.6, Nov 25, 2026) is how the window shows today's brief: the same lines Telegram's /brief and the morning digest send.
    id: 'brief-get-returns-the-brief-takes-no-options-and-is-audited-like-any-other-command',
    async check() {
      let calls = 0;
      const brief = { at: '2026-11-25T03:30:00.000Z', dateLabel: 'Wednesday, 25 November 2026', headline: 'Brief', sections: [{ key: 'leads', title: 'Leads', available: true, lines: ['0 leads are in the list.'] }] };
      const { store, runtime } = setupWithCommands({}, { brief: { async get() { calls += 1; return brief; } } });
      const plain = await runtime.invoke('brief.get', {});
      const bad = [await runtime.invoke('brief.get', { date: 'today' }), await runtime.invoke('brief.get', { limit: 5 })];
      return verdict(plain.ok && json(plain.data) === json(brief) && calls === 1 && bad.every((r) => r.error?.code === 'invalid_args') && inserts(store).some((e) => e[1] === 'audit_log' && e[2].action === 'command.brief.get'), `plain ${json(plain)}, calls ${calls}, bad ${json(bad.map((r) => r.error?.code))}`);
    },
  },
  {
    // teams.startLead and teams.startTicket (Nov 26, 2026) start a team from the Teams page. They only START the job and answer at once.
    id: 'teams-start-lead-and-ticket-start-the-job-at-once-check-their-arguments-and-record-only-the-domain-of-an-email',
    async check() {
      const lead = [];
      const ticket = [];
      const jobs = {
        startLead(input) { lead.push(input); return { ok: true, message: 'Started.' }; },
        startTicket(input) { ticket.push(input); return { ok: true, message: 'Started.' }; },
      };
      const { store, runtime } = setupWithCommands({}, { jobs });
      const a = await runtime.invoke('teams.startLead', { company: 'Acme Online Shoes', website: 'https://acme-shoes.example/', email: 'hello@acme-shoes.example' });
      const b = await runtime.invoke('teams.startTicket', {});
      const c = await runtime.invoke('teams.startTicket', { ticketId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      const bad = [
        await runtime.invoke('teams.startLead', {}), await runtime.invoke('teams.startLead', { company: 5 }), await runtime.invoke('teams.startLead', { company: 'x'.repeat(201) }), await runtime.invoke('teams.startLead', { company: 'A', email: 5 }),
        await runtime.invoke('teams.startLead', { company: 'A', status: 'active' }), await runtime.invoke('teams.startTicket', { ticketId: 'nope' }), await runtime.invoke('teams.startTicket', { ticketId: 5 }), await runtime.invoke('teams.startTicket', { limit: 5 }),
      ];
      const audited = inserts(store).filter((e) => e[1] === 'audit_log' && /^command\.teams\.start/.test(e[2].action)).map((e) => JSON.stringify(e[2].detail));
      return verdict(a.ok && a.data.started === true && b.ok && c.ok && lead.length === 1 && lead[0].company === 'Acme Online Shoes' && ticket.length === 2 && ticket[1].ticketId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        && bad.every((r) => r.error?.code === 'invalid_args') && lead.length === 1 && audited.length === 3 /* only the three valid calls: a request that fails its checks is refused before anything is recorded or run */ && audited.some((d) => d.includes('acme-shoes.example')) && !audited.join(' ').includes('hello@acme-shoes.example'), `a ${json(a)}; bad ${json(bad.map((r) => r.error?.code))}; audited ${json(audited.slice(0, 2))}`);
    },
  },
  {
    id: 'teams-start-without-a-jobs-service-says-not-available-and-a-refusal-keeps-its-code-and-a-failure-is-generic',
    async check() {
      const none = [await setupWithCommands().runtime.invoke('teams.startLead', { company: 'Acme' }), await setupWithCommands().runtime.invoke('teams.startTicket', {})];
      const refusing = setupWithCommands({}, { jobs: { startLead: () => ({ ok: false, code: 'busy', message: '2 team jobs are already running. Please wait for one to finish.' }), startTicket: () => ({ ok: false, code: 'invalid_lead', message: 'x' }) } });
      const busy = await refusing.runtime.invoke('teams.startLead', { company: 'Acme' });
      const failing = await setupWithCommands({}, { jobs: { startLead() { throw new Error('connection to db.internal failed SECRETVALUE7'); } } }).runtime.invoke('teams.startLead', { company: 'Acme' });
      return verdict(none.every((r) => r.error?.code === 'not_available') && busy.error?.code === 'busy' && /2 team jobs are already running/.test(busy.error.message) && failing.error?.code === 'internal_error' && !json(failing).includes('SECRETVALUE7') && !json(failing).includes('db.internal'), json({ none, busy, failing }));
    },
  },
  {
    id: 'brief-get-without-a-brief-says-not-available-and-a-failure-is-generic',
    async check() {
      const none = await setupWithCommands().runtime.invoke('brief.get', {});
      const failing = await setupWithCommands({}, { brief: { async get() { throw new Error('connection to db.internal failed SECRETVALUE6'); } } }).runtime.invoke('brief.get', {});
      return verdict(none.error?.code === 'not_available' && failing.error?.code === 'internal_error' && !json(failing).includes('SECRETVALUE6') && !json(failing).includes('db.internal'), json({ none, failing }));
    },
  },
  {
    id: 'goals-list-without-an-orchestrator-says-not-available',
    async check() {
      const { runtime } = setupWithCommands();
      const r = await runtime.invoke('goals.list', {});
      return verdict(r.ok === false && r.error?.code === 'not_available', json(r));
    },
  },
  {
    id: 'a-failing-orchestrator-gives-a-generic-error-for-goals-list',
    async check() {
      const orchestrator = { async listGoals() { throw new Error('connection to db.internal failed SECRETVALUE4'); } };
      const { runtime } = setupWithCommands({}, { orchestrator });
      const r = await runtime.invoke('goals.list', {});
      return verdict(r.error?.code === 'internal_error' && !json(r).includes('SECRETVALUE4') && !json(r).includes('db.internal'), json(r));
    },
  },
  {
    id: 'goals-list-is-audited-like-any-other-command',
    async check() {
      const { store, runtime } = setupWithCommands({}, { orchestrator: { async listGoals() { return []; } } });
      await runtime.invoke('goals.list', {});
      return verdict(inserts(store).some((e) => e[1] === 'audit_log' && e[2].action === 'command.goals.list'), json(inserts(store).map((e) => e[2].action)));
    },
  },
  {
    id: 'decisions-list-reads-pending-by-default-and-limits-the-size',
    async check() {
      const rows = [{ id: UUID, status: 'pending' }];
      const { store, runtime } = setupWithCommands({ rows: { decisions: rows } });
      const r = await runtime.invoke('decisions.list', {});
      const select = store.log.find((e) => e[0] === 'select' && e[1] === 'decisions');
      const tooBig = await runtime.invoke('decisions.list', { limit: 1000 });
      const bogus = await runtime.invoke('decisions.list', { status: 'bogus' });
      const ok = r.ok && json(r.data.decisions) === json(rows) && select?.[2]?.where?.status === 'pending' && select[2].limit <= 100 && tooBig.error?.code === 'invalid_args' && bogus.error?.code === 'invalid_args';
      return verdict(ok, `list ${json(r)}, query ${json(select?.[2])}, tooBig ${tooBig.error?.code}, bogus ${bogus.error?.code}`);
    },
  },
  {
    id: 'resolve-goes-to-the-decisions-service-as-the-dashboard',
    // PLAN.md step 1.6: the dashboard's answer is the service's job. The command only
    // validates, fixes the channel to "dashboard" (the caller cannot pick one), passes the
    // service's answer through, and lets the service's plain errors reach the window.
    async check() {
      const { DecisionError } = loadSubject('src/runtime/decisions.js');
      const calls = [];
      const decisions = {
        async resolve(args) {
          calls.push(args);
          if (args.id === NOT_FOUND) throw new DecisionError('not_found', 'That decision was not found.');
          if (args.id === BROKEN) throw new Error('connect failed for SECRETVALUE3');
          return { id: args.id, status: args.decision, changed: true, conflict: false, resolvedVia: args.via };
        },
      };
      const { runtime, store } = setupWithCommands({}, { decisions });
      const ok = await runtime.invoke('decisions.resolve', { id: UUID, decision: 'approved', note: 'go' });
      const sneaky = await runtime.invoke('decisions.resolve', { id: UUID, decision: 'approved', via: 'telegram' });
      const missing = await runtime.invoke('decisions.resolve', { id: NOT_FOUND, decision: 'approved' });
      const broken = await runtime.invoke('decisions.resolve', { id: BROKEN, decision: 'approved' });
      const bad = await runtime.invoke('decisions.resolve', { id: 'not-a-uuid', decision: 'approved' });
      const none = setupWithCommands();
      const noService = await none.runtime.invoke('decisions.resolve', { id: UUID, decision: 'approved' });
      const writes = store.log.filter((e) => e[0] === 'update' || (e[0] === 'insert' && e[1] !== 'audit_log'));
      const good = ok.ok && ok.data.status === 'approved' && json(calls[0]) === json({ id: UUID, decision: 'approved', via: 'dashboard', note: 'go' });
      const refused = sneaky.error?.code === 'invalid_args' && bad.error?.code === 'invalid_args' && calls.length === 3;
      const errors = missing.error?.code === 'not_found' && missing.error.message === 'That decision was not found.'
        && broken.error?.code === 'internal_error' && !json(broken).includes('SECRETVALUE3') && noService.error?.code === 'not_available';
      return verdict(good && refused && errors && writes.length === 0, `ok ${json(ok)}, calls ${json(calls)}, sneaky ${sneaky.error?.code}, missing ${json(missing)}, broken ${json(broken)}, bad ${bad.error?.code}, noService ${noService.error?.code}, command wrote ${json(writes)}`);
    },
  },
  {
    id: 'a-command-can-choose-which-arguments-the-audit-log-keeps',
    // Free text a founder types (a note) does not belong in the audit log. A command can say which of its
    // arguments are recorded; the handler still gets all of them. A broken chooser records nothing rather
    // than everything.
    async check() {
      const { store, runtime } = setup();
      const seen = [];
      runtime.register('keep.some', { auditArgs: (a) => ({ id: a.id, hasNote: a.note !== undefined }), handler: async (a) => { seen.push(a); return {}; } });
      runtime.register('keep.broken', { auditArgs: () => { throw new Error('boom'); }, handler: async (a) => { seen.push(a); return {}; } });
      runtime.register('keep.all', { handler: async () => ({}) });
      const a = await runtime.invoke('keep.some', { id: 'x', note: 'private text' });
      const b = await runtime.invoke('keep.broken', { id: 'y', note: 'private text two' });
      const c = await runtime.invoke('keep.all', { id: 'z' });
      const rows = inserts(store).map((e) => e[2]);
      const some = rows.find((r) => r.action === 'command.keep.some');
      const broken = rows.find((r) => r.action === 'command.keep.broken');
      const all = rows.find((r) => r.action === 'command.keep.all');
      // A chooser that is not a function is a programming mistake: refuse it when the command is registered.
      let refused = false;
      try {
        runtime.register('keep.typo', { auditArgs: 'id', handler: async () => ({}) });
      } catch {
        refused = true;
      }
      const ok = refused && a.ok && b.ok && c.ok && json(some?.detail) === json({ args: { id: 'x', hasNote: true } })
        && json(broken?.detail) === json({ args: {} }) && json(all?.detail) === json({ args: { id: 'z' } })
        && json(seen) === json([{ id: 'x', note: 'private text' }, { id: 'y', note: 'private text two' }])
        && !json(rows).includes('private text');
      return verdict(ok, `some ${json(some?.detail)}, broken ${json(broken?.detail)}, all ${json(all?.detail)}, handlers saw ${json(seen)}`);
    },
  },
  {
    id: 'the-dashboard-answer-keeps-the-note-out-of-the-command-audit-entry',
    async check() {
      const seen = [];
      const decisions = { async resolve(args) { seen.push(args); return { id: args.id, status: 'approved', changed: true, conflict: false }; } };
      const { store, runtime } = setupWithCommands({}, { decisions });
      const r = await runtime.invoke('decisions.resolve', { id: UUID, decision: 'approved', note: 'private reason' });
      const withoutNote = await runtime.invoke('decisions.resolve', { id: UUID, decision: 'rejected' });
      const rows = inserts(store).map((e) => e[2]).filter((e) => e.action === 'command.decisions.resolve');
      const ok = r.ok && withoutNote.ok && seen[0]?.note === 'private reason' && rows.length === 2
        && json(rows[0].detail) === json({ args: { id: UUID, decision: 'approved', hasNote: true } })
        && json(rows[1].detail) === json({ args: { id: UUID, decision: 'rejected', hasNote: false } })
        && !json(rows).includes('private reason');
      return verdict(ok, `entries ${json(rows)}, service saw ${json(seen)}`);
    },
  },
  {
    id: 'pause-refuses-until-it-is-built-and-changes-nothing',
    async check() {
      const { store, runtime } = setupWithCommands();
      const pause = await runtime.invoke('agents.pause', { agentId: UUID, paused: true });
      const bad = await runtime.invoke('agents.pause', { agentId: 'nope', paused: true });
      const writes = store.log.filter((e) => e[0] === 'update' || (e[0] === 'insert' && e[1] !== 'audit_log'));
      return verdict(pause.error?.code === 'not_implemented' && bad.error?.code === 'invalid_args' && writes.length === 0, `pause ${pause.error?.code}, bad ${bad.error?.code}, writes ${json(writes)}`);
    },
  },
  {
    id: 'status-reports-the-database-without-leaking-the-error',
    async check() {
      const up = setupWithCommands();
      const down = setupWithCommands({ selectError: new Error('connect failed for SECRETVALUE2') });
      const a = await up.runtime.invoke('runtime.status', {});
      const b = await down.runtime.invoke('runtime.status', {});
      const ok = a.ok && a.data.database === 'ok' && b.ok && b.data.database !== 'ok' && !json(b).includes('SECRETVALUE2') && inserts(up.store).length === 0;
      return verdict(ok, `up ${json(a)}, down ${json(b)}, audited ${inserts(up.store).length}`);
    },
  },

  // ---- IPC guard --------------------------------------------------------
  {
    id: 'ipc-trusts-only-the-apps-own-renderer',
    async check() {
      const { isTrustedSender } = loadSubject(GUARD);
      const dev = { rendererFileUrl: 'file:///app/out/renderer/index.html', rendererDevUrl: 'http://localhost:5173' };
      const prod = { rendererFileUrl: dev.rendererFileUrl };
      const yes = ['file:///app/out/renderer/index.html', 'http://localhost:5173/', 'http://localhost:5173/index.html'];
      const no = ['file:///app/out/renderer/other.html', 'file:///etc/passwd', 'https://evil.example.com/', 'http://localhost:5174/', 'http://localhost:5173.evil.com/', undefined, '', 'data:text/html,x'];
      const wrongYes = yes.filter((u) => !isTrustedSender(u, dev));
      const wrongNo = no.filter((u) => isTrustedSender(u, dev));
      const devUrlInProd = isTrustedSender('http://localhost:5173/', prod);
      const fileInProd = isTrustedSender('file:///app/out/renderer/index.html', prod);
      return verdict(wrongYes.length === 0 && wrongNo.length === 0 && !devUrlInProd && fileInProd, `wrongly refused ${json(wrongYes)}, wrongly trusted ${json(wrongNo)}, dev url trusted in production: ${devUrlInProd}`);
    },
  },
  {
    id: 'ipc-payloads-must-be-a-command-name-and-plain-arguments',
    async check() {
      const { parseInvoke } = loadSubject(GUARD);
      const good = parseInvoke({ command: 'decisions.list', args: { limit: 5 } });
      const noArgs = parseInvoke({ command: 'runtime.status' });
      const bad = [null, 'text', 5, { command: 5 }, { command: '' }, { command: 'a;b' }, { command: 'x'.repeat(100) }, { command: 'a', args: [] }, { command: 'a', args: 'x' }];
      const accepted = bad.filter((p) => parseInvoke(p) !== null);
      const ok = good?.command === 'decisions.list' && good.args.limit === 5 && noArgs?.command === 'runtime.status' && json(noArgs.args) === '{}' && accepted.length === 0;
      return verdict(ok, `good ${json(good)}, noArgs ${json(noArgs)}, wrongly accepted ${json(accepted)}`);
    },
  },
];

module.exports = {
  name: 'runtime-core',
  description: 'Runtime command bus: audit-before-action, fail-closed, generic errors, events, config, IPC guard',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
