'use strict';

// Grades priority and shared specialists (PLAN.md step 3.5). "Done when: a test with two pods needing the same specialist serves P1 first."
//   src/runtime/specialists.js        createSpecialists({ store, audit, isBlocked?, now?, onError? })
//     .request({ podId, specialistId, title, description? }) -> { taskId, priority }      a pod asks a shared specialist for work; throws SpecialistError
//     .serveNext({ specialistId })  -> { status: 'serving', task } | { status: 'none' }  hands out the highest-priority waiting task, once
//     .queue({ specialistId? })     -> the waiting work in the order it will be served
//     .conflicts()                  -> shared specialists that more than one project is waiting for, in serving order
//   src/runtime/pods/service.js       pods.setPriority({ podId, priority })               a project's priority is P1, P2 or P3 and can be changed
//   src/runtime/brief.js              createBrief({ store, decisions, specialists }): a "Shared specialists" section that notes every conflict
//
// Runs against a REAL Postgres with the real migrations, three real pods (shared with `engineering-tools`) and the real pods service.
//
//   - the done-when: pod A (P3) asks first, pod B (P1) asks second, and the specialist serves B first
//   - the order follows the project's CURRENT priority (changing it re-orders what is waiting), then the oldest request; a task is handed out once,
//     even when two callers ask at the same moment
//   - only a shared, working specialist can be asked, only for a pod that is open, and the work stays that pod's (the served task names its pod)
//   - everything is audited before it is done; if it cannot be audited, or the runtime is blocked, nothing changes
//   - the daily brief says which projects are competing for a specialist, who goes first and who waits, in the same lines for the window and Telegram

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');
const { buildWorld } = require('../engineering-world');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const RANDOM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
let counter = 0;
const unique = (label) => `${label} ${Date.now().toString(36)}${counter++}`;

async function world(key = 'specialists') {
  const w = await buildWorld(key);
  const { createSpecialists } = loadSubject('src/runtime/specialists.js');
  const make = (over = {}) => createSpecialists({ store: w.store, audit: w.audit, ...over });
  const specialist = (over = {}) => w.store.insert('agents', { name: unique('Specialist'), team: 'product_engineering', role: 'specialist', is_shared: true, ...over });
  const setPriorities = async (map) => { for (const [pod, priority] of Object.entries(map)) await w.pods.setPriority({ podId: w[pod].podId, priority }); };
  const row = async (table, id) => (await w.store.select(table, { where: { id }, limit: 1 }))[0];
  const auditCount = async (action) => (await w.store.select('audit_log', { where: { action }, limit: 1000 })).length;
  return { w, make, specialist, setPriorities, row, auditCount, specialists: make() };
}

const failing = { append: async () => { throw new Error('the audit log is down sb_secret_ABCDEFGHIJKLMNOP'); } };
const refusal = async (promise) => promise.then(() => null, (err) => ({ name: err?.name, code: err?.code, message: err?.message }));

const cases = [
  {
    id: 'done-when-two-pods-need-the-same-specialist-and-the-p1-one-is-served-first',
    async check() {
      const { w, specialist, setPriorities, specialists, row } = await world();
      await setPriorities({ A: 'P3', B: 'P1' });
      const s = await specialist();
      const first = await specialists.request({ podId: w.A.podId, specialistId: s.id, title: 'Design the Alpha logo' }); // asks FIRST, but it is P3
      const second = await specialists.request({ podId: w.B.podId, specialistId: s.id, title: 'Design the Beta logo' }); // asks second, and it is P1
      const one = await specialists.serveNext({ specialistId: s.id });
      const two = await specialists.serveNext({ specialistId: s.id });
      const none = await specialists.serveNext({ specialistId: s.id });
      const [a, b] = [await row('tasks', first.taskId), await row('tasks', second.taskId)];
      const ok = one.status === 'serving' && one.task.id === second.taskId && one.task.podId === w.B.podId && one.task.priority === 'P1'
        && two.status === 'serving' && two.task.id === first.taskId && two.task.podId === w.A.podId && two.task.priority === 'P3' && none.status === 'none'
        && a.status === 'in_progress' && b.status === 'in_progress' && a.assigned_agent_id === s.id && b.assigned_agent_id === s.id && a.pod_id === w.A.podId && b.pod_id === w.B.podId;
      return verdict(ok, json({ one: one.task?.priority, two: two.task?.priority, none, a: [a.status, a.pod_id === w.A.podId], b: [b.status, b.pod_id === w.B.podId] }));
    },
  },
  {
    id: 'p1-then-p2-then-p3-and-among-equals-the-oldest-request-first',
    async check() {
      const { w, specialist, setPriorities, specialists } = await world();
      await setPriorities({ A: 'P2', B: 'P2', C: 'P3' });
      const s = await specialist();
      for (const [pod, title] of [['C', 'third-c'], ['A', 'second-a'], ['B', 'third-b']]) await specialists.request({ podId: w[pod].podId, specialistId: s.id, title });
      await setPriorities({ C: 'P1' }); // C asked first and is now P1
      const served = [];
      for (let i = 0; i < 4; i += 1) served.push((await specialists.serveNext({ specialistId: s.id })).task?.title ?? null);
      return verdict(json(served) === json(['third-c', 'second-a', 'third-b', null]), json(served));
    },
  },
  {
    id: 'changing-a-projects-priority-re-orders-the-work-already-waiting',
    async check() {
      const { w, specialist, setPriorities, specialists } = await world();
      await setPriorities({ A: 'P1', B: 'P3' });
      const s = await specialist();
      await specialists.request({ podId: w.A.podId, specialistId: s.id, title: 'a-work' });
      await specialists.request({ podId: w.B.podId, specialistId: s.id, title: 'b-work' });
      const before = (await specialists.queue({ specialistId: s.id })).map((e) => `${e.title}:${e.priority}`);
      await setPriorities({ A: 'P3', B: 'P1' }); // the order of asking has not changed, the priorities have
      const after = (await specialists.queue({ specialistId: s.id })).map((e) => `${e.title}:${e.priority}`);
      const served = (await specialists.serveNext({ specialistId: s.id })).task?.title;
      return verdict(json(before) === json(['a-work:P1', 'b-work:P3']) && json(after) === json(['b-work:P1', 'a-work:P3']) && served === 'b-work', json({ before, after, served }));
    },
  },
  {
    id: 'a-task-is-handed-out-once-even-when-two-callers-ask-at-the-same-moment',
    async check() {
      const { w, specialist, setPriorities, specialists, make, row } = await world();
      await setPriorities({ A: 'P1', B: 'P2' });
      const s = await specialist();
      const only = await specialists.request({ podId: w.A.podId, specialistId: s.id, title: 'the-only-one' });
      const racing = await Promise.all([make().serveNext({ specialistId: s.id }), make().serveNext({ specialistId: s.id })]);
      const wins = racing.filter((r) => r.status === 'serving');
      const s2 = await specialist();
      await specialists.request({ podId: w.A.podId, specialistId: s2.id, title: 'p1-work' });
      await specialists.request({ podId: w.B.podId, specialistId: s2.id, title: 'p2-work' });
      const pair = await Promise.all([make().serveNext({ specialistId: s2.id }), make().serveNext({ specialistId: s2.id })]);
      const titles = pair.map((r) => r.task?.title).sort();
      const ok = wins.length === 1 && wins[0].task.id === only.taskId && racing.filter((r) => r.status === 'none').length === 1 && json(titles) === json(['p1-work', 'p2-work']) && (await row('tasks', only.taskId)).status === 'in_progress';
      return verdict(ok, json({ racing: racing.map((r) => r.status), titles }));
    },
  },
  {
    id: 'only-a-shared-working-specialist-can-be-asked-and-only-for-a-pod-that-is-open',
    async check() {
      const { w, specialist, specialists } = await world();
      const worker = await w.store.insert('agents', { name: unique('Worker'), team: 'product_engineering', role: 'worker', is_shared: false });
      const notShared = await w.store.insert('agents', { name: unique('Private'), team: 'product_engineering', role: 'specialist', is_shared: false });
      const gone = await specialist({ status: 'removed', removed_at: new Date().toISOString() });
      const good = await specialist();
      const tasksBefore = (await w.store.select('tasks', { where: {}, limit: 5000 })).length;
      const attempts = {
        'a worker': { podId: w.A.podId, specialistId: worker.id, title: 'x' },
        'a specialist that is not shared': { podId: w.A.podId, specialistId: notShared.id, title: 'x' },
        'a removed specialist': { podId: w.A.podId, specialistId: gone.id, title: 'x' },
        'an unknown specialist': { podId: w.A.podId, specialistId: RANDOM_ID, title: 'x' },
        'a specialist id that is not an id': { podId: w.A.podId, specialistId: 'nope', title: 'x' },
        'an unknown pod': { podId: RANDOM_ID, specialistId: good.id, title: 'x' },
        'a pod id that is not an id': { podId: "x' or '1'='1", specialistId: good.id, title: 'x' },
        'no title': { podId: w.A.podId, specialistId: good.id },
        'a title with a line break': { podId: w.A.podId, specialistId: good.id, title: 'a\nb' },
        'a long title': { podId: w.A.podId, specialistId: good.id, title: 'x'.repeat(201) },
        'a long description': { podId: w.A.podId, specialistId: good.id, title: 'x', description: 'y'.repeat(4001) },
        'an extra argument': { podId: w.A.podId, specialistId: good.id, title: 'x', priority: 'P1' },
      };
      const results = {};
      for (const [label, input] of Object.entries(attempts)) results[label] = await refusal(specialists.request(input));
      // A closed pod is refused too.
      const closed = await w.store.insert('projects', { name: unique('Closed'), kind: 'saas_product', status: 'completed' });
      const closedPod = await w.store.insert('pods', { project_id: closed.id, template: 'saas_product', status: 'closed', closed_at: new Date().toISOString() });
      results['a closed pod'] = await refusal(specialists.request({ podId: closedPod.id, specialistId: good.id, title: 'x' }));
      const accepted = Object.entries(results).filter(([, r]) => r === null).map(([label]) => label);
      const tasksAfter = (await w.store.select('tasks', { where: {}, limit: 5000 })).length;
      const plain = Object.values(results).every((r) => r?.name === 'SpecialistError' && typeof r.message === 'string' && r.message.length > 0 && !/sb_secret|select|insert|violates/i.test(r.message));
      return verdict(accepted.length === 0 && plain && tasksAfter === tasksBefore, json({ accepted, tasksBefore, tasksAfter, messages: Object.values(results).map((r) => r?.message) }));
    },
  },
  {
    id: 'a-request-is-saved-as-a-queued-task-of-that-pod-for-that-specialist-with-the-projects-priority',
    async check() {
      const { w, specialist, setPriorities, specialists, row } = await world();
      await setPriorities({ C: 'P1' });
      const s = await specialist({ team: 'marketing_sales' });
      const r = await specialists.request({ podId: w.C.podId, specialistId: s.id, title: '  Write the launch copy ', description: 'Two lines\nof detail.' });
      const t = await row('tasks', r.taskId);
      const ok = r.priority === 'P1' && t.pod_id === w.C.podId && t.assigned_agent_id === s.id && t.status === 'queued' && t.team === 'marketing_sales' && t.title === 'Write the launch copy' && t.priority === 'P1' && t.description === 'Two lines\nof detail.';
      return verdict(ok, json(t));
    },
  },
  {
    id: 'only-the-named-specialists-work-is-served-and-a-paused-or-removed-specialist-serves-nothing',
    async check() {
      const { w, specialist, setPriorities, specialists, row } = await world();
      await setPriorities({ A: 'P2', B: 'P2' });
      const [one, two] = [await specialist(), await specialist()];
      const mine = await specialists.request({ podId: w.A.podId, specialistId: one.id, title: 'for-one' });
      await specialists.request({ podId: w.B.podId, specialistId: two.id, title: 'for-two' });
      const served = await specialists.serveNext({ specialistId: one.id });
      const again = await specialists.serveNext({ specialistId: one.id });
      await w.store.update('agents', { id: two.id }, { status: 'paused' });
      const paused = await specialists.serveNext({ specialistId: two.id });
      const stillWaiting = (await specialists.queue({ specialistId: two.id })).length; // paused: the work is kept, not served
      await w.store.update('agents', { id: two.id }, { status: 'removed', removed_at: new Date().toISOString() });
      const removed = await specialists.serveNext({ specialistId: two.id });
      const unknown = [await specialists.serveNext({ specialistId: RANDOM_ID }), await refusal(specialists.serveNext({ specialistId: 'nope' })), await refusal(specialists.serveNext({}))];
      const ok = served.task?.id === mine.taskId && again.status === 'none' && paused.status === 'none' && removed.status === 'none' && unknown[0].status === 'none' && unknown[1]?.name === 'SpecialistError' && unknown[2]?.name === 'SpecialistError'
        && stillWaiting === 1 && (await specialists.queue({ specialistId: two.id })).length === 0 && (await row('tasks', mine.taskId)).status === 'in_progress';
      return verdict(ok, json({ served: served.status, again, paused, removed, unknown }));
    },
  },
  {
    id: 'the-served-task-carries-its-pod-and-only-its-own-words',
    async check() {
      const { w, specialist, setPriorities, specialists } = await world();
      await setPriorities({ A: 'P1', B: 'P3' });
      const s = await specialist();
      await specialists.request({ podId: w.A.podId, specialistId: s.id, title: 'ALPHA-ASK', description: 'alpha detail' });
      await specialists.request({ podId: w.B.podId, specialistId: s.id, title: 'BETA-ASK', description: 'beta detail' });
      const served = await specialists.serveNext({ specialistId: s.id });
      const text = json(served);
      const ok = served.task.podId === w.A.podId && served.task.title === 'ALPHA-ASK' && served.task.description === 'alpha detail' && served.task.project === w.A.name && !/BETA|beta detail|acme\/site-b/.test(text)
        && Object.keys(served.task).sort().join() === 'description,id,podId,priority,project,title';
      return verdict(ok, text);
    },
  },
  {
    id: 'conflicts-are-the-specialists-more-than-one-project-is-waiting-for-in-serving-order',
    async check() {
      const { w, specialist, setPriorities, specialists } = await world();
      await setPriorities({ A: 'P3', B: 'P1', C: 'P2' });
      const contested = await specialist();
      const quiet = await specialist();
      const alone = await specialist();
      await specialists.request({ podId: w.A.podId, specialistId: contested.id, title: 'a' });
      await specialists.request({ podId: w.B.podId, specialistId: contested.id, title: 'b' });
      await specialists.request({ podId: w.C.podId, specialistId: contested.id, title: 'c' });
      await specialists.request({ podId: w.A.podId, specialistId: quiet.id, title: 'one-project-asks-twice-1' }); // one project is not a conflict, however much it asks
      await specialists.request({ podId: w.A.podId, specialistId: quiet.id, title: 'one-project-asks-twice-2' });
      await specialists.request({ podId: w.C.podId, specialistId: alone.id, title: 'c-alone' });
      const mine = (await specialists.conflicts()).filter((c) => [contested.id, quiet.id, alone.id].includes(c.specialistId));
      const [c] = mine;
      const order = c?.entries.map((e) => `${e.project}:${e.priority}`);
      await specialists.serveNext({ specialistId: contested.id }); // B (P1) is served: C (P2) and A (P3) still compete
      const afterOne = (await specialists.conflicts()).find((x) => x.specialistId === contested.id)?.entries.length;
      await specialists.serveNext({ specialistId: contested.id });
      const afterTwo = (await specialists.conflicts()).find((x) => x.specialistId === contested.id);
      const ok = mine.length === 1 && c.specialistId === contested.id && c.specialist === (await w.store.select('agents', { where: { id: contested.id } }))[0].name
        && json(order) === json([`${w.B.name}:P1`, `${w.C.name}:P2`, `${w.A.name}:P3`]) && afterOne === 2 && afterTwo === undefined;
      return verdict(ok, json({ mine: mine.length, order, afterOne, afterTwo }));
    },
  },
  {
    id: 'a-project-priority-is-p1-p2-or-p3-and-can-be-changed-for-an-open-pod-only',
    async check() {
      const { w, auditCount, row } = await world();
      const project = async (pod) => (await row('projects', (await row('pods', w[pod].podId)).project_id));
      const before = await auditCount('pod.priority_changed');
      const changed = await w.pods.setPriority({ podId: w.A.podId, priority: 'P1' });
      const back = await w.pods.setPriority({ podId: w.A.podId, priority: 'P2' });
      const bBefore = (await project('B')).priority;
      const bad = {};
      for (const [label, input] of Object.entries({
        'a priority that does not exist': { podId: w.A.podId, priority: 'P4' },
        'lower case': { podId: w.A.podId, priority: 'p1' },
        'a number': { podId: w.A.podId, priority: 1 },
        'no priority': { podId: w.A.podId },
        'an unknown pod': { podId: RANDOM_ID, priority: 'P1' },
        'a pod id that is not an id': { podId: 'nope', priority: 'P1' },
        'an extra argument': { podId: w.A.podId, priority: 'P1', deadline: '2026-12-31' },
      })) bad[label] = await refusal(w.pods.setPriority(input));
      const accepted = Object.entries(bad).filter(([, r]) => r === null).map(([l]) => l);
      const ok = changed.priority === 'P1' && changed.previous !== undefined && back.previous === 'P1' && (await project('A')).priority === 'P2' && accepted.length === 0
        && Object.values(bad).every((r) => r?.name === 'PodError' && r.message.length > 0) && bBefore === (await project('B')).priority && (await auditCount('pod.priority_changed')) === before + 2;
      return verdict(ok, json({ changed, back, accepted, audit: (await auditCount('pod.priority_changed')) - before }));
    },
  },
  {
    id: 'everything-is-audited-first-and-nothing-changes-when-the-audit-log-is-down-or-the-runtime-is-blocked',
    async check() {
      const { w, specialist, setPriorities, specialists, make, row, auditCount } = await world();
      await setPriorities({ A: 'P2', B: 'P2' });
      const s = await specialist();
      const queued = await specialists.request({ podId: w.A.podId, specialistId: s.id, title: 'waiting' });
      const tasksBefore = (await w.store.select('tasks', { where: {}, limit: 5000 })).length;
      const auditedRequest = await auditCount('specialist.requested');
      const auditedServe = await auditCount('specialist.served');
      const down = make({ audit: failing });
      const blocked = make({ isBlocked: () => 'The runtime is blocked: the audit log cannot be written.' });
      const results = [
        await refusal(down.request({ podId: w.B.podId, specialistId: s.id, title: 'never saved' })),
        await refusal(blocked.request({ podId: w.B.podId, specialistId: s.id, title: 'never saved either' })),
        await refusal(down.serveNext({ specialistId: s.id })),
        await refusal(blocked.serveNext({ specialistId: s.id })),
      ];
      const { createPods } = loadSubject('src/runtime/pods/service.js');
      const common = { store: w.store, decisions: w.decisions, runtime: w.runtime, templatesDir: path.join(ROOT, 'config', 'pods'), root: w.podsRoot };
      const poddown = createPods({ ...common, audit: failing });
      const podblocked = createPods({ ...common, audit: w.audit, isBlocked: () => 'The runtime is blocked.' });
      const priorityOf = async () => (await row('projects', (await row('pods', w.A.podId)).project_id)).priority;
      const priorityBefore = await priorityOf();
      results.push(await refusal(poddown.setPriority({ podId: w.A.podId, priority: 'P1' })), await refusal(podblocked.setPriority({ podId: w.A.podId, priority: 'P1' })));
      const priorityAfter = await priorityOf();
      const stillQueued = (await row('tasks', queued.taskId)).status === 'queued';
      const served = await specialists.serveNext({ specialistId: s.id });
      const ok = results.every((r) => r && typeof r.message === 'string' && !/sb_secret/.test(r.message)) && (await w.store.select('tasks', { where: {}, limit: 5000 })).length === tasksBefore
        && (await auditCount('specialist.requested')) === auditedRequest && priorityBefore === priorityAfter && stillQueued
        && served.task?.id === queued.taskId && (await auditCount('specialist.served')) === auditedServe + 1;
      return verdict(ok, json({ results: results.map((r) => r?.message), priorityBefore, priorityAfter, stillQueued }));
    },
  },
  {
    id: 'the-brief-says-which-projects-are-competing-for-a-specialist-who-goes-first-and-who-waits-and-the-phone-gets-the-same-lines',
    async check() {
      const { w, specialist, setPriorities, make } = await world('specialists-brief');
      const { createBrief, renderBriefText } = loadSubject('src/runtime/brief.js');
      const specialists = make();
      const brief = () => createBrief({ store: w.store, decisions: w.decisions, specialists }).get();
      const quiet = await brief();
      const section = (b) => b.sections.find((s) => s.key === 'specialists');
      await setPriorities({ A: 'P3', B: 'P1' });
      const s = await specialist({ name: 'Priya (design)' });
      await specialists.request({ podId: w.A.podId, specialistId: s.id, title: 'a' });
      await specialists.request({ podId: w.B.podId, specialistId: s.id, title: 'b' });
      const busy = await brief();
      const lines = section(busy).lines;
      const text = renderBriefText(busy);
      await specialists.serveNext({ specialistId: s.id });
      const settled = await brief();
      const untracked = await createBrief({ store: w.store, decisions: w.decisions }).get();
      const ok = section(quiet).title === 'Shared specialists' && section(quiet).available === true && section(quiet).lines.length === 1 && /No conflicts/i.test(section(quiet).lines[0])
        && lines.some((l) => l.includes('Priya (design)') && l.includes(`${w.B.name} (P1)`) && l.includes(`${w.A.name} (P3)`) && l.indexOf(w.B.name) < l.indexOf(w.A.name) && /first/i.test(l) && /wait/i.test(l))
        && lines.every((l) => text.includes(`- ${l}`)) && text.includes('Shared specialists') && /No conflicts/i.test(section(settled).lines[0]) && section(untracked).available === false && /^Not tracked yet/.test(section(untracked).lines[0])
        && busy.sections.map((x) => x.key).join() === 'waiting,revenue,leads,tickets,deployments,spend,specialists';
      return verdict(ok, json({ quiet: section(quiet).lines, lines, settled: section(settled).lines, untracked: section(untracked).lines }));
    },
  },
  {
    id: 'text-from-the-database-in-the-brief-is-cut-and-stripped-and-the-list-is-short',
    async check() {
      const { w, specialist, setPriorities, make } = await world('specialists-text');
      const { createBrief } = loadSubject('src/runtime/brief.js');
      const specialists = make();
      await setPriorities({ A: 'P1', B: 'P2' });
      const names = ['Ann\u0007ie\nSpecial' + 'x'.repeat(200), 'Two', 'Three', 'Four', 'Five'];
      for (const name of names) {
        const s = await specialist({ name });
        await specialists.request({ podId: w.A.podId, specialistId: s.id, title: 'a' });
        await specialists.request({ podId: w.B.podId, specialistId: s.id, title: 'b' });
      }
      const b = await createBrief({ store: w.store, decisions: w.decisions, specialists }).get();
      const lines = b.sections.find((s) => s.key === 'specialists').lines;
      const ok = lines.length <= 5 && lines.every((l) => !/[\u0000-\u001f\u007f]/.test(l) && l.length < 400) && lines.some((l) => /and \d+ more/.test(l));
      return verdict(ok, json(lines));
    },
  },
];

module.exports = {
  name: 'specialist-queue',
  description: 'Priority and shared specialists (step 3.5): a project is P1, P2 or P3, a shared specialist serves the highest-priority waiting project first (then the oldest request), a task is handed out once, everything is audited first, and the daily brief names every conflict',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
