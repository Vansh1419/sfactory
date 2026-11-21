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
//                            register(name, { handler, validate?, audit?: 'always'|'never', allowWhenBlocked? })
//                            invoke(name, args, { actor? }) never throws and returns
//                              { ok: true, data } | { ok: false, error: { code, message } }
//                            CommandError(code, message) is exported; its code and message reach the caller as-is,
//                            any other thrown error becomes { code: 'internal_error', message: <generic> }
//                            error codes: unknown_command, invalid_args, audit_unavailable, internal_error,
//                              runtime_stopped, runtime_not_configured
//   src/runtime/commands.js  registerCommands(runtime, { store }) registers exactly:
//                            runtime.status, decisions.list, decisions.resolve, agents.pause
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

function setupWithCommands(storeOptions) {
  const s = setup(storeOptions);
  loadSubject(COMMANDS).registerCommands(s.runtime, { store: s.store });
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
    id: 'the-runtime-registers-exactly-the-four-planned-commands',
    async check() {
      const { runtime } = setupWithCommands();
      return verdict(json(runtime.commands().sort()) === json(['agents.pause', 'decisions.list', 'decisions.resolve', 'runtime.status']), `got ${json(runtime.commands())}`);
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
    id: 'resolve-and-pause-refuse-until-they-are-built-and-change-nothing',
    async check() {
      const { store, runtime } = setupWithCommands();
      const resolve = await runtime.invoke('decisions.resolve', { id: UUID, decision: 'approved' });
      const pause = await runtime.invoke('agents.pause', { agentId: UUID, paused: true });
      const badResolve = await runtime.invoke('decisions.resolve', { id: 'not-a-uuid', decision: 'approved' });
      const writes = store.log.filter((e) => e[0] === 'update' || (e[0] === 'insert' && e[1] !== 'audit_log'));
      const ok = resolve.error?.code === 'not_implemented' && pause.error?.code === 'not_implemented' && badResolve.error?.code === 'invalid_args' && writes.length === 0;
      return verdict(ok, `resolve ${resolve.error?.code}, pause ${pause.error?.code}, badResolve ${badResolve.error?.code}, writes ${json(writes)}`);
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
