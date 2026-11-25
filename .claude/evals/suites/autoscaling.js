'use strict';

// Grades autoscaling (PLAN.md step 4.1). "Done when: a load test adds agents up to the cap, then produces a card, then scales back down."
//   src/runtime/autoscaler.js   createAutoscaler({ store, audit, decisions, emit?, isBlocked?, now?, rules?, onError? })
//     .tick()    -> { added: [{ team, role, agentId, name }], removed: [{ team, role, agentId, name }], carded: [{ team, role, decisionId }], closed: [podId], moved: number }
//                   or { skipped: true } when another tick is still running or the runtime is blocked
//     .status()  -> [{ team, role, agents, base, max, queued, perAgent, waitMinutes, state }]
//     .start({ everySeconds }) / .stop()     runs a tick on a timer, one at a time; also adds the agent the founder approves beyond the cap
//   A rule is { team, role, max_agents, scale_up_queue_threshold, scale_up_wait_minutes, idle_minutes_before_removal, enabled? }, read from the
//   `scaling_rules` table (`rules` overrides it in tests), with built-in defaults when the table has nothing for a team and role.
//
// Real Postgres with the migrations (a fresh one per case), the real decisions service, policy and card checker; the clock is a fake that the test moves.
//
//   - the done-when: with 12 tasks waiting for one agent, each tick adds one agent (and shares the waiting work out) until the cap, then ONE card asks
//     the founder, and once the work is done and the agents have been idle long enough they are removed again, one per tick, never below the originals
//   - "queue" is waiting tasks PER AGENT, so sharing the work out stops the adding; "wait" is how long the oldest task has waited since the newest agent
//     arrived, so a new agent gets time to work before another is added
//   - an agent beyond the cap needs the founder's yes (`agent.add`, an always-ask rule): one card at a time, not again for a day after a no, and an
//     approval adds exactly one agent, once
//   - only agents the autoscaler made (named "<original> 2", "<original> 3", ...) are ever removed, and only an idle one with no open work
//   - an open project space is closed when its project is completed or cancelled
//   - everything is audited first; when it cannot be, or the runtime is blocked, nothing changes; a tick never throws and two never overlap

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MIN = 60_000;
const RULE = { team: 'support', role: 'worker', max_agents: 3, scale_up_queue_threshold: 4, scale_up_wait_minutes: 30, idle_minutes_before_removal: 10, enabled: true };
let counter = 0;
const unique = (label) => `${label}${Date.now().toString(36)}${counter++}`;

/** A fresh database, the real decisions service and an autoscaler on a clock the test moves. */
async function rig(over = {}) {
  const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
  const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
  const { createAudit } = require(path.join(ROOT, 'src/runtime/audit'));
  const { createDecisionService } = loadSubject('src/runtime/decisions.js');
  const { createAutoscaler } = loadSubject('src/runtime/autoscaler.js');
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const fake = await startFakeSupabase();
  const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
  const audit = over.audit ?? createAudit(store);
  const events = [];
  const listeners = [];
  const runtime = { on: (type, fn) => { listeners.push([type, fn]); return () => listeners.splice(0, listeners.length, ...listeners.filter(([, f]) => f !== fn)); } };
  const emit = (type, data) => { events.push({ type, data }); for (const [t, fn] of listeners) if (t === type) fn(data); };
  const decisions = createDecisionService({ store, audit: createAudit(store), emit, isBlocked: () => null, policy });
  const clock = { t: Date.now() };
  const errors = [];
  const scaler = createAutoscaler({ store, audit, decisions, runtime, emit, isBlocked: over.isBlocked, now: () => new Date(clock.t), ...('rules' in over ? (over.rules === undefined ? {} : { rules: over.rules }) : { rules: [RULE] }), onError: (e) => errors.push(e) });
  const agent = (name, extra = {}) => store.insert('agents', { name, team: 'support', role: 'worker', ...extra });
  const task = (agentRow, extra = {}) => store.insert('tasks', { team: 'support', title: unique('Task'), status: 'queued', ...(agentRow ? { assigned_agent_id: agentRow.id } : {}), ...extra });
  const tasks = async (n, agentRow, extra) => { for (let i = 0; i < n; i += 1) await task(agentRow, extra); };
  const live = async (team = 'support') => (await store.select('agents', { where: { team }, limit: 500 })).filter((a) => a.status !== 'removed');
  const audits = async (action) => (await store.select('audit_log', { where: { action }, limit: 2000 })).length;
  const pending = async () => (await store.select('decisions', { where: { status: 'pending' }, limit: 100 }));
  const advance = (minutes) => { clock.t += minutes * MIN; };
  return { fake, store, audit, decisions, scaler, events, emit, errors, clock, agent, task, tasks, live, audits, pending, advance, listeners, done: () => fake.close() };
}

const cases = [
  {
    id: 'a-done-when-a-load-test-adds-agents-up-to-the-cap-then-produces-a-card-then-scales-back-down',
    async run() {
      const x = await rig();
      try {
        const aria = await x.agent('Aria');
        await x.tasks(12, aria);
        const t1 = await x.scaler.tick(); // 12 waiting for 1 agent: 12 per agent
        const n1 = (await x.live()).length;
        const t2 = await x.scaler.tick(); // 6 per agent
        const n2 = (await x.live()).length;
        const t3 = await x.scaler.tick(); // 3 agents (the cap), 4 per agent: still at the threshold
        const n3 = (await x.live()).length;
        const t4 = await x.scaler.tick(); // the card is already waiting: no second one
        const cards = await x.pending();
        const perAgent = {};
        for (const t of await x.store.select('tasks', { where: { status: 'queued' }, limit: 100 })) perAgent[t.assigned_agent_id] = (perAgent[t.assigned_agent_id] ?? 0) + 1;
        const spread = Object.values(perAgent).sort().join();

        // The work gets done, the agents sit idle, and they are removed one tick at a time, the clones only.
        await x.store.update('tasks', { status: 'queued' }, { status: 'done', completed_at: new Date(x.clock.t).toISOString() });
        x.advance(11);
        const d1 = await x.scaler.tick();
        const d2 = await x.scaler.tick();
        const d3 = await x.scaler.tick();
        const left = (await x.live()).map((a) => a.name);
        return verdict(t1.added.length === 1 && n1 === 2 && t2.added.length === 1 && n2 === 3 && t3.added.length === 0 && n3 === 3 && t3.carded.length === 1 && t4.carded.length === 0 && cards.length === 1 && cards[0].action.tool === 'agent.add'
          && spread === '4,4,4' && d1.removed.length === 1 && d2.removed.length === 1 && d3.removed.length === 0 && json(left) === json(['Aria']) && (await x.audits('agent.scaled_up')) === 2 && (await x.audits('agent.scaled_down')) === 2,
          `adds ${json([t1.added.length, t2.added.length, t3.added.length])} agents ${json([n1, n2, n3])}; cards ${json([t3.carded.length, t4.carded.length, cards.length])}; spread ${spread}; removed ${json([d1.removed.length, d2.removed.length, d3.removed.length])}; left ${json(left)}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'b-the-queue-is-waiting-tasks-per-agent-so-a-short-queue-adds-nobody-and-work-is-shared-out-evenly-without-touching-running-work',
    async run() {
      const x = await rig();
      try {
        const aria = await x.agent('Aria');
        await x.tasks(3, aria); // 3 per agent: under the threshold of 4
        const quiet = await x.scaler.tick();
        const running = await x.task(aria, { status: 'in_progress' });
        const blocked = await x.task(aria, { status: 'blocked', blocked_reason: 'Waiting for the founder' });
        await x.tasks(9, aria); // 12 waiting now
        const busy = await x.scaler.tick();
        const rows = await x.store.select('tasks', { where: {}, limit: 100 });
        const stillMine = (id) => rows.find((r) => r.id === id).assigned_agent_id === aria.id;
        const counts = {};
        for (const r of rows.filter((t) => t.status === 'queued')) counts[r.assigned_agent_id] = (counts[r.assigned_agent_id] ?? 0) + 1;
        const split = Object.values(counts).sort((a, b) => a - b);
        return verdict(quiet.added.length === 0 && busy.added.length === 1 && stillMine(running.id) && stillMine(blocked.id) && split.length === 2 && split[1] - split[0] <= 1 && split[0] + split[1] === 12 && busy.moved > 0 && (await x.audits('tasks.rebalanced')) === 1,
          `quiet ${quiet.added.length}; busy ${busy.added.length}; split ${json(split)}; running kept ${stillMine(running.id)}; blocked kept ${stillMine(blocked.id)}; moved ${busy.moved}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'c-a-task-that-has-waited-too-long-adds-an-agent-but-a-new-agent-gets-time-before-another-is-added',
    async run() {
      const x = await rig();
      try {
        const aria = await x.agent('Aria');
        await x.tasks(2, aria); // a short queue: only the wait can trigger
        const early = await x.scaler.tick();
        x.advance(31);
        const late = await x.scaler.tick(); // waited 31 minutes
        const grace = await x.scaler.tick(); // the new agent has had no time yet
        x.advance(31);
        const after = await x.scaler.tick(); // still waiting long after the new agent arrived
        return verdict(early.added.length === 0 && late.added.length === 1 && grace.added.length === 0 && after.added.length === 1 && (await x.live()).length === 3,
          `early ${early.added.length}; late ${late.added.length}; grace ${grace.added.length}; after ${after.added.length}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'd-past-the-cap-a-plain-card-asks-the-founder-once-and-an-approval-adds-exactly-one-agent-a-no-adds-none-and-is-not-asked-again-for-a-day',
    async run() {
      const x = await rig({ rules: [{ ...RULE, max_agents: 1 }] });
      try {
        const { checkCard } = loadSubject('src/runtime/cards.js');
        const policy = require(path.join(ROOT, 'src/runtime/policy'));
        const aria = await x.agent('Aria');
        await x.tasks(8, aria);
        x.scaler.start({ everySeconds: 3600 }); // listens for the answer; the first timed tick is an hour away
        const first = await x.scaler.tick();
        const card = (await x.pending())[0];
        const verdictOf = policy.checkAction(card.action);
        const checked = checkCard({ ...card.card, details: undefined });
        const second = await x.scaler.tick();
        await x.decisions.resolve({ id: card.id, decision: 'approved', via: 'dashboard' });
        await new Promise((r) => setTimeout(r, 400));
        const afterYes = await x.live();
        await x.decisions.resolve({ id: card.id, decision: 'approved', via: 'dashboard' }).catch(() => {}); // the same answer again
        x.emit('decision.resolved', { id: card.id, status: 'approved', via: 'dashboard' }); // and the announcement of it, twice more (a restart, a second listener)
        x.emit('decision.resolved', { id: card.id, status: 'approved', via: 'dashboard' });
        await new Promise((r) => setTimeout(r, 400));
        const again = (await x.live()).length;
        // A no: a new card for another group is not filed for a day.
        const bob = await x.agent('Bea', { team: 'support' });
        await x.tasks(9, bob);
        x.advance(1);
        const third = await x.scaler.tick();
        const card2 = (await x.pending())[0];
        if (card2) await x.decisions.resolve({ id: card2.id, decision: 'rejected', via: 'dashboard' });
        x.advance(60);
        const afterNo = await x.scaler.tick();
        x.advance(24 * 60);
        const nextDay = await x.scaler.tick();
        x.scaler.stop();
        return verdict(first.carded.length === 1 && verdictOf.allowed === false && verdictOf.category === 'people_or_contracts' && checked.pass && card.action.args.team === 'support' && card.action.args.role === 'worker' && /₹/.test(card.card.cost) && /\$/.test(card.card.cost)
          && second.carded.length === 0 && afterYes.length === 2 && afterYes.some((a) => a.name === 'Aria 2') && again === 2
          && third.carded.length === 1 && card2 && afterNo.carded.length === 0 && nextDay.carded.length === 1,
          `first ${first.carded.length}; policy ${json(verdictOf)}; card ok ${checked.pass} ${json(checked.problems)}; second ${second.carded.length}; agents after yes ${afterYes.map((a) => a.name)}; after the same answer ${again}; third ${third.carded.length}; after no ${afterNo.carded.length}; next day ${nextDay.carded.length}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'e-only-a-clone-that-is-idle-with-no-open-work-for-long-enough-is-removed-and-never-the-originals-a-lead-or-a-paused-agent',
    async run() {
      const x = await rig();
      try {
        const aria = await x.agent('Aria');
        const lead = await x.agent('Sana', { role: 'team_lead' });
        const busy = await x.agent('Aria 2', { status: 'working' });
        const holding = await x.agent('Aria 3');
        const paused = await x.agent('Aria 4', { status: 'paused' });
        const idle = await x.agent('Aria 5');
        const stranger = await x.agent('Mel 2', { team: 'marketing_sales' });
        await x.task(holding, { status: 'blocked', blocked_reason: 'Waiting for the founder' });
        x.advance(5);
        const tooSoon = await x.scaler.tick();
        x.advance(10);
        const first = await x.scaler.tick();
        const second = await x.scaler.tick();
        const names = (await x.live()).map((a) => a.name).sort();
        const removedRow = (await x.store.select('agents', { where: { id: idle.id }, limit: 1 }))[0];
        return verdict(tooSoon.removed.length === 0 && first.removed.length === 1 && first.removed[0].agentId === idle.id && second.removed.length === 0 && removedRow.status === 'removed' && removedRow.removed_at
          && json(names) === json(['Aria', 'Aria 2', 'Aria 3', 'Aria 4', 'Sana']) && (await x.live('marketing_sales')).length === 1 && aria && lead && busy && holding && paused && stranger && (await x.audits('agent.scaled_down')) === 1,
          `too soon ${tooSoon.removed.length}; first ${json(first.removed)}; second ${second.removed.length}; left ${json(names)}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'f-rules-come-from-the-table-with-built-in-defaults-and-a-disabled-or-odd-rule-is-never-used',
    async run() {
      const x = await rig({ rules: undefined });
      try {
        await x.agent('Aria');
        const defaults = x.scaler.status();
        const fromDefaults = await defaults;
        await x.store.insert('scaling_rules', { scope: 'global', team: 'support', role: 'worker', max_agents: 2, scale_up_queue_threshold: 3, scale_up_wait_minutes: 20, idle_minutes_before_removal: 5, enabled: true });
        await x.store.insert('scaling_rules', { scope: 'global', team: 'marketing_sales', role: 'worker', max_agents: 9, scale_up_queue_threshold: 1, scale_up_wait_minutes: 1, idle_minutes_before_removal: 1, enabled: false });
        const fromTable = await x.scaler.status();
        const support = fromTable.find((g) => g.team === 'support' && g.role === 'worker');
        const off = fromTable.find((g) => g.team === 'marketing_sales' && g.role === 'worker');
        const supportDefault = fromDefaults.find((g) => g.team === 'support' && g.role === 'worker');
        return verdict(Array.isArray(fromDefaults) && supportDefault && supportDefault.max >= 2 && support.max === 2 && !off && fromTable.every((g) => Number.isInteger(g.max) && g.max >= 1 && g.team !== 'orchestrator'),
          `defaults ${json(supportDefault)}; table ${json(support)}; disabled shown ${json(off)}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'g-an-open-project-space-is-closed-when-its-project-is-completed-or-cancelled-and-never-otherwise',
    async run() {
      const x = await rig({ rules: [] });
      try {
        const mk = async (status) => {
          const [project] = await x.store.insert('projects', { name: unique('P'), kind: 'saas_product', status }).then((r) => [r]);
          const pod = await x.store.insert('pods', { project_id: project.id, template: 'saas_product' });
          const member = await x.agent(unique('M'));
          await x.store.insert('pod_members', { pod_id: pod.id, agent_id: member.id });
          return { project, pod, member };
        };
        const active = await mk('active');
        const done = await mk('completed');
        const cancelled = await mk('cancelled');
        const t1 = await x.scaler.tick();
        const t2 = await x.scaler.tick();
        const pods = await x.store.select('pods', { where: {}, limit: 50 });
        const byId = (id) => pods.find((p) => p.id === id);
        const members = await x.store.select('pod_members', { where: {}, limit: 50 });
        const memberOf = (podId) => members.find((m) => m.pod_id === podId);
        return verdict(t1.closed.length === 2 && t2.closed.length === 0 && byId(done.pod.id).status === 'closed' && byId(done.pod.id).closed_at && byId(cancelled.pod.id).status === 'closed' && byId(active.pod.id).status === 'open'
          && memberOf(done.pod.id).left_at && memberOf(cancelled.pod.id).left_at && !memberOf(active.pod.id).left_at && (await x.audits('pod.closed')) === 2,
          `closed ${t1.closed.length} then ${t2.closed.length}; statuses ${json(pods.map((p) => p.status))}`);
      } finally { await x.done(); }
    },
  },
  {
    id: 'h-everything-is-audited-first-and-nothing-changes-when-it-cannot-be-or-the-runtime-is-blocked-and-a-tick-never-throws-or-overlaps',
    async run() {
      const down = { append: async () => { throw new Error('database down'); } };
      const a = await rig({ audit: down });
      const b = await rig({ isBlocked: () => 'The runtime is blocked for a test.' });
      const c = await rig();
      try {
        const aria = await a.agent('Aria');
        await a.tasks(12, aria);
        const downTick = await a.scaler.tick();
        const downAgents = (await a.live()).length;
        const ariaB = await b.agent('Aria');
        await b.tasks(12, ariaB);
        const blockedTick = await b.scaler.tick();
        const blockedAgents = (await b.live()).length;
        const ariaC = await c.agent('Aria');
        await c.tasks(12, ariaC);
        const [one, two] = await Promise.all([c.scaler.tick(), c.scaler.tick()]);
        const skipped = [one, two].filter((t) => t.skipped === true).length;
        const cAgents = (await c.live()).length;
        return verdict(downAgents === 1 && downTick.added.length === 0 && blockedAgents === 1 && blockedTick.skipped === true && skipped === 1 && cAgents === 2 && !JSON.stringify([downTick, a.errors.map(String)]).includes('sb_secret'),
          `audit down: ${json(downTick)} agents ${downAgents}; blocked ${json(blockedTick)} agents ${blockedAgents}; overlap skipped ${skipped}, agents ${cAgents}`);
      } finally { await a.done(); await b.done(); await c.done(); }
    },
  },
  {
    id: 'i-the-app-builds-and-starts-the-autoscaler-with-a-setting-to-turn-it-off-and-a-script-shows-and-runs-it',
    check() {
      const app = read('src/runtime/index.js');
      const script = fs.existsSync(path.join(ROOT, 'scripts/scale.js')) ? read('scripts/scale.js') : '';
      const pkg = JSON.parse(read('package.json'));
      const example = read('.env.example');
      const policy = read('src/runtime/policy.js');
      const problems = [
        ...(/createAutoscaler\(/.test(app) ? [] : ['createApp does not build the autoscaler']),
        ...(/autoscaler\.start\(/.test(app) ? [] : ['createApp does not start it']),
        ...(/autoscaler\.stop\(\)/.test(app) ? [] : ['createApp does not stop it']),
        ...(/AUTOSCALE_EVERY_SECONDS/.test(app) && /AUTOSCALE_EVERY_SECONDS/.test(example) ? [] : ['the interval setting is not read and documented']),
        ...(pkg.scripts?.scale === 'node scripts/scale.js' && /status/.test(script) && /tick|run/.test(script) ? [] : ['npm run scale is missing']),
        ...(/'agent\.add'/.test(policy) ? [] : ['agent.add has no rule in policy.js']),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
];

module.exports = {
  name: 'autoscaling',
  description: 'Autoscaling (step 4.1): agents added up to a cap as queues grow, a card past the cap, idle ones removed, ended projects closed',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check ? c.check() : c.run();
  },
};
