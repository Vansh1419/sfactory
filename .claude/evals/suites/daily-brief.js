'use strict';

// Grades the daily brief (PLAN.md step 2.6: "Brief covers revenue, leads, tickets, deployments and spend requests."):
//   src/runtime/brief.js
//     createBrief({ store, decisions, now? }).get() -> { at, dateLabel, headline, sections: [{ key, title, available, lines: [string] }] }
//     renderBriefText(brief)             -> the same brief as one plain message (what Telegram sends)
//
// ONE source for both screens: the window shows the sections' lines and Telegram sends the text built from those very lines.
// What the cases pin down:
//   - the sections and their order: Waiting for you, Revenue, Leads, Tickets, Deployments, Spend requests; revenue and deployments have no data
//     source yet and say so plainly (never an invented number)
//   - the figures match the data, "recent" means the last 24 hours exactly, money is shown in rupees and dollars, and the date and time are IST
//   - text from the database is shown as text, cut and stripped of control characters, and the Telegram text has no markup and stays short
//   - it runs on the real tables (one case on a real Postgres) and a failing store throws
//   - the window's BriefPanel draws only those lines, builds no markup from text, and does not poll

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/brief.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const lib = () => loadSubject(SUBJECT);
const NOW = new Date('2026-11-25T03:30:00Z'); // Wednesday, 9:00 AM IST
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** An in-memory store that understands what the brief asks: equality filters, "column.asc|desc" and a limit. */
function memoryStore(rows = {}) {
  return {
    async select(table, { where = {}, order, limit } = {}) {
      let out = (rows[table] ?? []).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      if (order) {
        const [col, dir] = order.split('.');
        out = [...out].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (dir === 'desc' ? -1 : 1));
      }
      return limit ? out.slice(0, limit) : out;
    },
  };
}
/** The REAL decisions service over a store: the brief reads decisions only through it, so the cases use it and not a copy of its rules. */
const decisionsOver = (store) => loadSubject('src/runtime/decisions.js').createDecisionService({ store, audit: { async append() {} }, emit() {}, isBlocked: () => null, policy: require(path.join(ROOT, 'src/runtime/policy')) });
const briefWith = (store, now = NOW) => lib().createBrief({ store, decisions: decisionsOver(store), now: () => now });
const briefOf = async (rows, now = NOW) => briefWith(memoryStore(rows), now).get();
const section = (brief, key) => brief.sections.find((s) => s.key === key);
const text = (s) => s.lines.join(' ');

let environment = null;
async function database() {
  if (!environment) {
    const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
    const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
    const fake = await startFakeSupabase();
    environment = { fake, store: createRestStore({ url: fake.url, serviceKey: fake.serviceKey }) };
  }
  return environment;
}

const cases = [
  {
    id: 'the-brief-has-the-six-sections-in-order-and-revenue-and-deployments-say-plainly-that-they-are-not-tracked-yet',
    async check() {
      const b = await briefOf({});
      const rev = section(b, 'revenue');
      const dep = section(b, 'deployments');
      return verdict(b.sections.map((s) => s.key).join() === 'waiting,revenue,leads,tickets,deployments,spend' && b.sections.map((s) => s.title).join('|') === 'Waiting for you|Revenue|Leads|Tickets|Deployments|Spend requests'
        && rev.available === false && /^Not tracked yet/.test(rev.lines[0]) && !/[₹$\d]/.test(rev.lines[0]) && dep.available === false && /^Not tracked yet/.test(dep.lines[0]) && !/\d/.test(dep.lines[0])
        && ['waiting', 'leads', 'tickets', 'spend'].every((k) => section(b, k).available === true) && b.sections.every((s) => s.lines.length >= 1 && s.lines.every((l) => typeof l === 'string' && l.length > 0)), json(b.sections.map((s) => [s.key, s.available])));
    },
  },
  {
    id: 'the-date-and-the-time-in-the-headline-are-in-indian-time',
    async check() {
      const morning = await briefOf({}, new Date('2026-11-25T03:30:00Z'));
      const pastMidnight = await briefOf({}, new Date('2026-11-25T18:30:00Z'));
      const afternoon = await briefOf({}, new Date('2026-11-25T10:15:00Z'));
      return verdict(morning.dateLabel === 'Wednesday, 25 November 2026' && /9:00 AM IST/.test(morning.headline) && pastMidnight.dateLabel === 'Thursday, 26 November 2026' && /12:00 AM IST/.test(pastMidnight.headline)
        && /3:45 PM IST/.test(afternoon.headline) && [morning, pastMidnight, afternoon].every((b) => !/\b(UTC|GMT)\b/.test(b.headline)) && morning.at === NOW.toISOString(), json({ a: morning.headline, b: pastMidnight.headline, c: afternoon.headline }));
    },
  },
  {
    id: 'waiting-for-you-counts-decisions-by-kind-and-blocked-tasks-and-the-headline-adds-them-up',
    async check() {
      const none = await briefOf({});
      const some = await briefOf({
        decisions: [{ status: 'pending', category: 'spend' }, { status: 'pending', category: 'spend' }, { status: 'pending', category: 'legal_or_public' }, { status: 'pending', category: 'mystery' }, { status: 'approved', category: 'spend', resolved_at: hoursAgo(1) }],
        tasks: [{ status: 'blocked' }, { status: 'blocked' }, { status: 'done' }],
      });
      const one = await briefOf({ decisions: [{ status: 'pending', category: 'launch_or_pricing' }] });
      return verdict(text(section(none, 'waiting')) === 'Nothing is waiting for your answer. No tasks are blocked.' && /Nothing needs you right now\.$/.test(none.headline)
        && text(section(some, 'waiting')) === '4 decisions are waiting for your answer: 2 about spending money, 1 about a legal or public matter, 1 about something new. 2 tasks are blocked and need someone to step in (see the Teams page).' && /6 things need you\.$/.test(some.headline)
        && text(section(one, 'waiting')).startsWith('1 decision is waiting for your answer: 1 about a launch or a price.') && /1 thing needs you\.$/.test(one.headline), json({ none: text(section(none, 'waiting')), some: text(section(some, 'waiting')), one: one.headline }));
    },
  },
  {
    id: 'leads-are-counted-with-the-new-ones-of-the-last-24-hours-and-the-latest-names-as-text',
    async check() {
      const nasty = `<b>Acme</b>\u0007 & "Co" ${'x'.repeat(100)}`;
      const b = await briefOf({ clients: [
        { name: 'Newest Ltd', status: 'lead', created_at: hoursAgo(1) }, { name: nasty, status: 'lead', created_at: hoursAgo(23.9) }, { name: 'Old One', status: 'lead', created_at: hoursAgo(24.1) },
        { name: 'Older Two', status: 'lead', created_at: hoursAgo(72) }, { name: 'A Client', status: 'active', created_at: hoursAgo(1) },
      ] });
      const lines = section(b, 'leads').lines;
      const empty = await briefOf({});
      return verdict(lines[0] === '4 leads are in the list; 2 new in the last 24 hours.' && lines[1].startsWith('Latest: Newest Ltd, <b>Acme</b>') && !/[\u0000-\u001f]/.test(lines[1]) && lines[1].split(', ')[1].length <= 62 && lines[1].endsWith(', Old One.') && !lines[1].includes('Older Two') && !text(section(b, 'leads')).includes('A Client')
        && text(section(empty, 'leads')) === '0 leads are in the list; 0 new in the last 24 hours.', json(lines));
    },
  },
  {
    id: 'tickets-show-open-and-in-progress-and-what-was-answered-or-sent-to-you-in-the-last-24-hours',
    async check() {
      const b = await briefOf({ tickets: [
        { status: 'open' }, { status: 'open' }, { status: 'open' }, { status: 'in_progress' },
        { status: 'answered', updated_at: hoursAgo(2) }, { status: 'answered', updated_at: hoursAgo(5) }, { status: 'answered', updated_at: hoursAgo(30) },
        { status: 'escalated', updated_at: hoursAgo(1) }, { status: 'escalated', updated_at: hoursAgo(48) }, { status: 'closed', updated_at: hoursAgo(1) },
      ] });
      const empty = await briefOf({});
      return verdict(json(section(b, 'tickets').lines) === json(['3 open and 1 being worked on.', 'In the last 24 hours: 2 answered and 1 sent to you to decide.']) && text(section(empty, 'tickets')) === '0 open and 0 being worked on. In the last 24 hours: 0 answered and 0 sent to you to decide.', json(section(b, 'tickets').lines));
    },
  },
  {
    id: 'spend-requests-show-what-waits-with-the-amount-in-rupees-and-dollars-and-what-was-decided-in-the-last-24-hours',
    async check() {
      const both = await briefOf({ decisions: [
        { status: 'pending', category: 'spend', amount_inr: 5000, amount_usd: 60 }, { status: 'pending', category: 'spend', amount_inr: '2500.50', amount_usd: '30' }, { status: 'pending', category: 'legal_or_public' },
        { status: 'approved', category: 'spend', resolved_at: hoursAgo(3) }, { status: 'approved', category: 'spend', resolved_at: hoursAgo(30) }, { status: 'rejected', category: 'spend', resolved_at: hoursAgo(10) }, { status: 'rejected', category: 'launch_or_pricing', resolved_at: hoursAgo(1) },
      ] });
      const noAmount = await briefOf({ decisions: [{ status: 'pending', category: 'spend', amount_inr: null, amount_usd: null }] });
      const rupeesOnly = await briefOf({ decisions: [{ status: 'pending', category: 'spend', amount_inr: 123456 }] });
      const none = await briefOf({});
      return verdict(json(section(both, 'spend').lines) === json(['2 spend requests are waiting for your answer, about ₹7,501 ($90) in all.', 'In the last 24 hours: 1 approved and 1 rejected.'])
        && text(section(noAmount, 'spend')).startsWith('1 spend request is waiting for your answer. In the last') && !/[₹$]/.test(section(noAmount, 'spend').lines[0]) && section(rupeesOnly, 'spend').lines[0] === '1 spend request is waiting for your answer, about ₹1,23,456 in all.'
        && text(section(none, 'spend')) === 'No spend requests are waiting for your answer. In the last 24 hours: 0 approved and 0 rejected.', json({ both: section(both, 'spend').lines, rupeesOnly: section(rupeesOnly, 'spend').lines }));
    },
  },
  {
    id: 'the-telegram-text-is-built-only-from-the-same-lines-has-no-markup-and-stays-short',
    async check() {
      const { renderBriefText } = lib();
      const b = await briefOf({ decisions: [{ status: 'pending', category: 'spend', amount_inr: 100 }], clients: [{ name: '<script>alert(1)</script>', status: 'lead', created_at: hoursAgo(1) }] });
      const t = renderBriefText(b);
      const lines = b.sections.flatMap((s) => [s.title, ...s.lines]);
      const huge = renderBriefText({ headline: 'H', sections: [{ title: 'T', lines: Array.from({ length: 500 }, (_, i) => `Line number ${i} ${'x'.repeat(50)}`) }] });
      const odd = [undefined, null, 5, 'x', [], {}, { sections: 'x' }].map((v) => renderBriefText(v));
      const mixed = renderBriefText({ headline: 'H', sections: [{ title: 'T', lines: 'not a list' }, { lines: ['only a line'] }] });
      return verdict(t.startsWith(b.headline) && lines.every((l) => t.includes(l)) && t.includes('- ') && t.includes('<script>alert(1)</script>') && !/\*\*|__|<b>|<a /.test(t.replace('<script>alert(1)</script>', '')) && t.length < 3500
        && huge.length <= 3500 && huge.endsWith('…') && odd.every((x) => x === 'The brief is not available right now.') && typeof mixed === 'string' && mixed.includes('only a line'), json({ len: t.length, huge: huge.length, odd }));
    },
  },
  {
    id: 'it-runs-on-the-real-tables-and-a-failing-store-throws',
    async check() {
      const env = await database();
      const real = await briefWith(env.store, new Date()).get();
      const fails = (table) => ({ select: async (t) => { if (t === table) throw new Error('database said sb_secret_ABCDEFGHIJKLMNOP'); return []; } });
      const results = [];
      for (const table of ['clients', 'tickets', 'decisions', 'tasks']) results.push(await briefWith(fails(table)).get().then(() => 'returned', (err) => /database said/.test(err.message)));
      return verdict(real.sections.length === 6 && real.sections.every((s) => s.lines.length > 0) && /^Brief for /.test(real.headline) && results.every((r) => r === true), json({ sections: real.sections.length, results }));
    },
  },
  {
    id: 'the-window-panel-draws-only-the-briefs-lines-as-text-and-never-polls',
    check() {
      const file = path.join(ROOT, 'src', 'renderer', 'BriefPanel.jsx');
      if (!fs.existsSync(file)) return verdict(false, 'src/renderer/BriefPanel.jsx does not exist yet');
      const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const problems = [];
      if (/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code)) problems.push('builds markup from text');
      if (/setInterval/.test(code)) problems.push('polls with a timer');
      if (!/window\.api\.brief\.get/.test(code)) problems.push('does not call window.api.brief.get');
      if (!/\.sections/.test(code) || !/\.lines/.test(code) || !/\.headline/.test(code)) problems.push('does not draw the headline, the sections and their lines');
      if (!/addEventListener\(\s*['"]focus['"]/.test(code)) problems.push('does not refresh when the window gets focus');
      if (!/<button/.test(code)) problems.push('has no refresh button');
      if (/require\(|ipcRenderer|window\.versions/.test(code)) problems.push('reaches past window.api');
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
];

module.exports = {
  name: 'daily-brief',
  description: 'Daily brief (step 2.6): six sections with figures that match the data, last 24 hours, IST, money in rupees and dollars, not-tracked sections say so, one source for the window and the Telegram text',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
