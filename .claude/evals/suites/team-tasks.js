'use strict';

// Grades starting the Finance, Legal and Ops team and the Engineering team from the founder's phone and window (the follow-up that steps 3.3 and 3.4
// left open: "no Telegram /finance or /engineer command and no Teams-page button"), the same way /lead and /ticket start the sales and support teams.
//   src/runtime/teams/jobs.js        createTeamJobs({ sales, support, engineering, finance, ... })
//     .startFinance({ title, description?, podId? })   -> { ok: true, message } | { ok: false, code, message }
//     .startEngineer({ podId, title, description? })   -> the same
//   src/runtime/commands.js          teams.startFinance, teams.startEngineer
//   src/runtime/telegram/bot.js      createBot({ ..., engineering, finance, projects })   /finance [project |] <title>   /engineer <project> | <title>
//   src/renderer/teams.mjs           taskFormView(form, { needsProject }), jobNotice (kinds finance and engineering)
//   src/renderer/TeamsPanel.jsx      the two forms; src/preload.js teams.startFinance / teams.startEngineer
//
// What the cases pin down:
//   - a job is STARTED at once with the checked details, and how it ended arrives later as `team.job_finished` in fixed sentences (never an error's text)
//   - a bad title, a project that is not an id, a missing team or two jobs already running never reaches a team
//   - on the phone a project is named in words ("Alpha"), found among the OPEN projects only, and an unknown or ambiguous name is said plainly and starts nothing
//   - the founder's description never goes to the audit log; only the title (cut) is recorded
//   - only the founder can start work from the phone, and no more than two team jobs run at once

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const POD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOUNDER = 4242;
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A team job that finishes only when the test says so. */
const controllable = () => {
  const calls = [];
  const release = [];
  return { calls, release, run: (arg) => { calls.push(arg); return new Promise((resolve) => release.push(resolve)); } };
};

const jobs = (over = {}) => {
  const events = [];
  const errors = [];
  const made = loadSubject('src/runtime/teams/jobs.js').createTeamJobs({ emit: (type, data) => events.push({ type, data }), onError: (e) => errors.push(e), ...over });
  return { made, events, errors };
};

function bot(over = {}) {
  const sent = [];
  const errors = [];
  const api = { sendMessage: async (a) => { sent.push(a); return { messageId: 100 + sent.length }; }, editMessage: async () => {}, answerCallback: async () => {} };
  const decisions = { resolve: async () => ({ changed: true }), get: async () => null };
  const policyTools = { list: async () => [], propose: async () => ({}), confirm: async () => ({}), cancel: async () => ({}), remove: async () => ({}) };
  const made = loadSubject('src/runtime/telegram/bot.js').createBot({ api, founderChatId: FOUNDER, decisions, policyTools, onError: (e) => errors.push(e), ...over });
  const say = (text, from = FOUNDER) => made.handleUpdate({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, chat: { id: from }, from: { id: from }, text } });
  return { bot: made, sent, errors, say };
}

const PROJECTS = async () => [{ id: POD_A, name: 'Alpha Site' }, { id: POD_B, name: 'Beta Shop' }];

const cases = [
  {
    id: 'a-a-finance-job-is-started-at-once-with-the-checked-details-and-how-it-ended-is-announced-later',
    async check() {
      const finance = controllable();
      const { made, events } = jobs({ finance: { workTask: finance.run } });
      const started = made.startFinance({ title: '  Invoice Acme  ', description: 'One item, ₹1,00,000. GST 18%.', podId: POD_A.toUpperCase() });
      const none = made.startFinance({ title: 'Check the contract' });
      const before = events.length;
      finance.release[0]({ status: 'done', taskId: 't', outputs: [] });
      finance.release[1]({ status: 'needs_founder', taskId: 't', decisionId: 'd' });
      await settle();
      const notices = events.filter((e) => e.type === 'team.job_finished').map((e) => e.data);
      return verdict(started.ok === true && none.ok === true && finance.calls.length === 2 && before === 0
        && json(finance.calls[0]) === json({ title: 'Invoice Acme', description: 'One item, ₹1,00,000. GST 18%.', podId: POD_A }) && finance.calls[1].podId === undefined && finance.calls[1].title === 'Check the contract'
        && notices.length === 2 && notices.every((n) => n.kind === 'finance') && /draft|finished/i.test(notices[0].message) && /decision|card/i.test(notices[1].message) && /Nothing was (paid|sent)/i.test(notices[1].message),
        `started ${json([started, none])}; calls ${json(finance.calls)}; notices ${json(notices)}`);
    },
  },
  {
    id: 'b-an-engineering-job-needs-a-project-and-is-started-at-once-with-the-checked-details',
    async check() {
      const engineering = controllable();
      const { made, events } = jobs({ engineering: { workTask: engineering.run } });
      const noProject = made.startEngineer({ title: 'Add a contact page' });
      const started = made.startEngineer({ podId: POD_B, title: 'Add a contact page', description: 'With a short form.' });
      engineering.release[0]({ status: 'needs_founder', taskId: 't', decisionId: 'd' });
      await settle();
      const notice = events.find((e) => e.type === 'team.job_finished')?.data;
      return verdict(noProject.ok === false && noProject.code === 'invalid_task' && started.ok === true && engineering.calls.length === 1 && json(engineering.calls[0]) === json({ podId: POD_B, title: 'Add a contact page', description: 'With a short form.' })
        && notice?.kind === 'engineering' && /Nothing (went live|was merged)/i.test(notice.message),
        `no project ${json(noProject)}; started ${json(started)}; calls ${json(engineering.calls)}; notice ${json(notice)}`);
    },
  },
  {
    id: 'c-a-bad-task-a-missing-team-or-too-many-jobs-never-reach-a-team-and-no-error-text-is-shown',
    async check() {
      const finance = controllable();
      const engineering = controllable();
      const { made, events, errors } = jobs({ finance: { workTask: finance.run }, engineering: { workTask: engineering.run }, maxAtOnce: 2 });
      const bad = [
        made.startFinance(null), made.startFinance({}), made.startFinance({ title: '' }), made.startFinance({ title: 'a\nb' }), made.startFinance({ title: 'x'.repeat(201) }), made.startFinance({ title: 'x', description: 5 }),
        made.startFinance({ title: 'x', podId: 'not-an-id' }), made.startFinance({ title: 'x', extra: 1 }),
        made.startEngineer({ podId: 'nope', title: 'x' }), made.startEngineer({ podId: POD_A }), made.startEngineer({ podId: POD_A, title: 'x', repo: 'acme/other' }),
      ];
      const missing = jobs({}).made;
      const noTeams = [missing.startFinance({ title: 'x' }), missing.startEngineer({ podId: POD_A, title: 'x' })];
      made.startFinance({ title: 'one' });
      made.startEngineer({ podId: POD_A, title: 'two' });
      const busy = made.startFinance({ title: 'three' });
      finance.release[0]({ status: 'done' });
      engineering.release[0]({ status: 'done' });
      await settle();
      const after = made.startFinance({ title: 'four' });
      const thrower = jobs({ finance: { workTask: async () => { throw new Error('PRIVATE-DB-TEXT sb_secret_ABCDEFGH'); } } });
      thrower.made.startFinance({ title: 'x' });
      await settle();
      const said = json(thrower.events);
      return verdict(bad.every((r) => r.ok === false && typeof r.message === 'string') && noTeams.every((r) => r.ok === false && r.code === 'not_available') && busy.ok === false && busy.code === 'busy' && after.ok === true
        && finance.calls.length + engineering.calls.length === 3 && !said.includes('PRIVATE-DB-TEXT') && !said.includes('sb_secret') && thrower.errors.length === 1 && thrower.made.running() === 0 && errors.length === 0 && events.length >= 2,
        `bad ${json(bad.map((r) => r.code))}; no teams ${json(noTeams.map((r) => r.code))}; busy ${json(busy)}; after ${json(after)}; said ${said}`);
    },
  },
  {
    id: 'd-the-windows-commands-check-their-arguments-and-record-only-the-title-never-the-description',
    async check() {
      const { createRuntime } = loadSubject('src/runtime/runtime.js');
      const { registerCommands } = loadSubject('src/runtime/commands.js');
      const entries = [];
      const calls = [];
      const stub = { startFinance: (a) => { calls.push(['finance', a]); return { ok: true, message: 'Started.' }; }, startEngineer: (a) => { calls.push(['engineer', a]); return { ok: true, message: 'Started.' }; } };
      const runtime = createRuntime({ audit: { append: async (e) => { entries.push(e); } } });
      registerCommands(runtime, { store: null, jobs: stub });
      const bare = createRuntime({ audit: { append: async () => {} } });
      registerCommands(bare, { store: null });
      const call = (rt, name, args) => rt.invoke(name, args, { actor: 'founder' });
      const words = `PRIVATE-DESCRIPTION-${Date.now()}`;
      const a = await call(runtime, 'teams.startFinance', { title: 'Invoice Acme', description: words, podId: POD_A });
      const b = await call(runtime, 'teams.startEngineer', { podId: POD_B, title: 'Add a contact page', description: words });
      const bad = [
        await call(runtime, 'teams.startFinance', {}), await call(runtime, 'teams.startFinance', { title: 5 }), await call(runtime, 'teams.startFinance', { title: 'x', podId: 'nope' }), await call(runtime, 'teams.startFinance', { title: 'x', extra: 1 }),
        await call(runtime, 'teams.startEngineer', { title: 'x' }), await call(runtime, 'teams.startEngineer', { podId: 'nope', title: 'x' }), await call(runtime, 'teams.startEngineer', { podId: POD_A, title: 'x', description: 5 }),
      ];
      const offline = [await call(bare, 'teams.startFinance', { title: 'x' }), await call(bare, 'teams.startEngineer', { podId: POD_A, title: 'x' })];
      const logged = json(entries);
      return verdict(a.ok && b.ok && calls.length === 2 && bad.every((r) => r.ok === false) && offline.every((r) => r.ok === false && r.error.code === 'not_available') && !logged.includes(words) && /Invoice Acme/.test(logged) && /hasDescription/.test(logged),
        `a ${json(a)}; b ${json(b)}; bad ${json(bad.map((r) => r.ok))}; offline ${json(offline.map((r) => r.error?.code))}; description in the audit log ${logged.includes(words)}`);
    },
  },
  {
    id: 'e-on-the-phone-finance-starts-the-team-in-the-background-with-or-without-a-project-named-in-words',
    async check() {
      const finance = controllable();
      const h = bot({ finance: { workTask: finance.run }, projects: PROJECTS });
      await h.say('/finance Invoice Acme for the website');
      await h.say('/finance alpha | Invoice the client for the design');
      const first = finance.calls[0];
      const second = finance.calls[1];
      const working = h.sent.filter((m) => /Working on it/.test(m.text)).length;
      finance.release[0]({ status: 'done', taskId: 't', outputs: [] });
      finance.release[1]({ status: 'needs_founder', taskId: 't', decisionId: 'd' });
      await settle();
      const texts = h.sent.map((m) => m.text);
      return verdict(json(first) === json({ title: 'Invoice Acme for the website' }) && json(second) === json({ podId: POD_A, title: 'Invoice the client for the design' }) && working === 2
        && texts.some((t) => /finance|invoice|draft/i.test(t) && /finished|ready/i.test(t)) && texts.some((t) => /decision|card/i.test(t) && /Nothing was (paid|sent)/i.test(t)) && h.errors.length === 0,
        `calls ${json(finance.calls)}; replies ${json(texts)}`);
    },
  },
  {
    id: 'f-on-the-phone-engineer-needs-a-project-named-in-words-and-an-unknown-or-ambiguous-name-starts-nothing',
    async check() {
      const engineering = controllable();
      const h = bot({ engineering: { workTask: engineering.run }, projects: async () => [...(await PROJECTS()), { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Beta Blog' }] });
      await h.say('/engineer Alpha Site | Add a contact page');
      await h.say('/engineer');
      await h.say('/engineer Add a contact page');
      await h.say('/engineer Gamma | Add a contact page');
      await h.say('/engineer beta | Add a contact page');
      await h.say('/engineer Alpha Site |');
      const texts = h.sent.map((m) => m.text);
      engineering.release[0]({ status: 'blocked', taskId: 't', reason: 'The lead did not accept the work.' });
      await settle();
      const after = h.sent.map((m) => m.text);
      return verdict(engineering.calls.length === 1 && json(engineering.calls[0]) === json({ podId: POD_A, title: 'Add a contact page' }) && /Usage: \/engineer/.test(texts[1]) && /Usage: \/engineer/.test(texts[2])
        && /could not find an open project/i.test(texts[3]) && /Gamma/.test(texts[3]) && /more than one/i.test(texts[4]) && /Beta Shop/.test(texts[4]) && /Beta Blog/.test(texts[4]) && /Usage: \/engineer/.test(texts[5]) && /could not finish/i.test(after.at(-1)),
        `calls ${json(engineering.calls)}; replies ${json(after)}`);
    },
  },
  {
    id: 'g-the-phone-commands-are-for-the-founder-only-need-their-team-and-share-the-two-at-a-time-limit',
    async check() {
      const finance = controllable();
      const engineering = controllable();
      const h = bot({ finance: { workTask: finance.run }, engineering: { workTask: engineering.run }, projects: PROJECTS });
      await h.say('/finance Invoice a stranger', 999);
      await h.say('/engineer Alpha | Do something', 999);
      const stranger = finance.calls.length + engineering.calls.length;
      await h.say('/finance one');
      await h.say('/engineer Alpha | two');
      await h.say('/finance three');
      const busy = h.sent.at(-1).text;
      const noTeams = bot({ projects: PROJECTS });
      await noTeams.say('/finance x');
      await noTeams.say('/engineer Alpha | x');
      const noProjects = bot({ engineering: { workTask: engineering.run } });
      await noProjects.say('/engineer Alpha | x');
      const help = bot();
      await help.say('/help');
      return verdict(stranger === 0 && finance.calls.length === 1 && engineering.calls.length === 1 && /already running 2/i.test(busy) && noTeams.sent.every((m) => /not available/i.test(m.text)) && /not available/i.test(noProjects.sent[0].text)
        && /\/finance/.test(help.sent[0].text) && /\/engineer/.test(help.sent[0].text),
        `stranger ${stranger}; busy ${busy}; no teams ${json(noTeams.sent.map((m) => m.text))}; no projects ${json(noProjects.sent.map((m) => m.text))}`);
    },
  },
  {
    id: 'h-the-telegram-service-passes-both-teams-and-the-open-projects-to-the-bot-and-the-app-builds-the-jobs-with-them',
    check() {
      const service = read('src/runtime/telegram/index.js');
      const app = read('src/runtime/index.js');
      const problems = [
        ...(/createBot\(\{[^}]*\bengineering\b[^}]*\bfinance\b/.test(service) || /createBot\(\{[^}]*\bfinance\b[^}]*\bengineering\b/.test(service) ? [] : ['the service does not pass engineering and finance to the bot']),
        ...(/createBot\(\{[^}]*\bprojects\b/.test(service) ? [] : ['the service does not pass the open projects to the bot']),
        ...(/createTeamJobs\(\{[^}]*\bengineering\b[^}]*\bfinance\b|createTeamJobs\(\{[^}]*\bfinance\b[^}]*\bengineering\b/.test(app) ? [] : ['createApp does not give the jobs both teams']),
        ...(/createTelegramService\(\{[\s\S]*?\bengineering\b[\s\S]*?\}\);/.test(app) ? [] : ['createApp does not give the Telegram service the teams']),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'i-the-window-has-two-forms-for-them-with-plain-checks-a-project-list-and-a-notice-for-each-kind',
    async check() {
      const mod = await loadSubject('src/renderer/teams.mjs');
      const finance = mod.taskFormView({ title: '  Invoice Acme ', description: ' One item. ', podId: '' }, { needsProject: false });
      const withPod = mod.taskFormView({ title: 'Invoice Acme', description: '', podId: POD_A }, { needsProject: false });
      const noTitle = mod.taskFormView({ title: '   ' }, { needsProject: false });
      const noProject = mod.taskFormView({ title: 'Add a page', podId: '' }, { needsProject: true });
      const engineer = mod.taskFormView({ title: 'Add a page', description: '', podId: POD_B }, { needsProject: true });
      const odd = [mod.taskFormView(null, { needsProject: true }), mod.taskFormView({ title: 5 }, {})];
      const notices = ['finance', 'engineering', 'lead', 'ticket'].map((kind) => mod.jobNotice({ type: 'team.job_finished', data: { kind, status: 'done', message: 'Done.' } })?.kind);
      const panel = read('src/renderer/TeamsPanel.jsx');
      const preload = read('src/preload.js');
      const problems = [
        ...(/window\.api\.teams\.startFinance/.test(panel) && /window\.api\.teams\.startEngineer/.test(panel) ? [] : ['the panel does not call the two new functions']),
        ...(/teams\.startFinance/.test(preload) && /teams\.startEngineer/.test(preload) ? [] : ['the preload lacks the two new functions']),
        ...(/dangerouslySetInnerHTML|innerHTML/.test(panel) ? ['the panel builds markup'] : []),
        ...(/files\.pods/.test(panel) ? [] : ['the project list does not come from files.pods']),
      ];
      return verdict(finance.ok && json(finance.args) === json({ title: 'Invoice Acme', description: 'One item.' }) && withPod.args.podId === POD_A && !('description' in withPod.args) && noTitle.ok === false && /title|what/i.test(noTitle.problem)
        && noProject.ok === false && /project/i.test(noProject.problem) && engineer.ok && engineer.args.podId === POD_B && odd.every((r) => r.ok === false) && json(notices) === json(['finance', 'engineering', 'lead', 'ticket']) && problems.length === 0,
        `finance ${json(finance)}; no project ${json(noProject)}; notices ${json(notices)}; ${problems.join('; ')}`);
    },
  },
];

module.exports = {
  name: 'team-tasks',
  description: 'Starting the Finance and Engineering teams from the phone (/finance, /engineer) and the Teams page, like /lead and /ticket',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check();
  },
};
