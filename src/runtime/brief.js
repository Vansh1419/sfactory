'use strict';

// The daily brief (PLAN.md step 2.6): what the founder should know this morning, in plain words. Read only. Graded by the `daily-brief` eval.
//
//   createBrief({ store, decisions, specialists?, now? }).get() -> { at, dateLabel, headline, sections: [{ key, title, available, lines: [string] }] }
//   renderBriefText(brief)             -> the same brief as one plain message (for Telegram)
//
// ONE source for both screens: the window shows `sections[].lines` and Telegram sends `renderBriefText(brief)`, which is built from those very
// lines. So the digest on the phone and the brief in the window cannot say different things: there is no second place where a sentence is written.
//
// Sections, in this order: Waiting for you, Revenue, Leads, Tickets, Deployments, Spend requests, Shared specialists (step 3.5: every shared specialist that
// more than one project is waiting for, who goes first and who waits; read through the specialists service, never from the tasks table here). Revenue and deployments have no data source yet
// (no payments and no deployment tool are connected), so they say so plainly instead of showing a number that is not real.
// Decisions are read only through the decisions service (`decisions.summary`), never from their table here. "Recent" always means the last 24 hours, counted back from now. Times are written in IST. Text that comes from the database (a lead's name)
// is cut and stripped of control characters; Telegram sends the brief as plain text, never as markup. A failing store throws.

const IST = 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;
const READ_LIMIT = 200;
const MAX_NAMES = 3;
const MAX_NAME_CHARS = 60;
const MAX_WAITING_LISTED = 5;
const MAX_MESSAGE_CHARS = 3_500; // Telegram allows 4,096; this leaves room

const SPEND = 'spend';
const CATEGORY_WORDS = Object.freeze({
  spend: 'spending money',
  people_or_contracts: 'people or contracts',
  launch_or_pricing: 'a launch or a price',
  legal_or_public: 'a legal or public matter',
  unknown: 'something new',
});
const CATEGORY_ORDER = Object.freeze(['spend', 'people_or_contracts', 'launch_or_pricing', 'legal_or_public', 'unknown']);

// eslint-disable-next-line no-control-regex
const plain = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const asList = (rows) => (Array.isArray(rows) ? rows : []);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const capped = (n) => (n >= READ_LIMIT ? `${READ_LIMIT}+` : String(n));
const isAfter = (iso, since) => typeof iso === 'string' && Date.parse(iso) >= since;
/** "5 minutes", "3 hours", "2 days": how long ago something was filed. Empty when the time is not a time. */
function waited(iso, nowMs) {
  const then = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.floor((nowMs - then) / 60_000));
  if (minutes < 1) return 'just filed';
  if (minutes < 60) return plural(minutes, 'minute', 'minutes');
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? plural(hours, 'hour', 'hours') : plural(Math.floor(hours / 24), 'day', 'days');
}
const amount = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** "Wednesday, 26 November 2026" and "9:00 AM IST" for a moment, in Indian time. */
function istLabels(date) {
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true }).format(date).toUpperCase();
  return { day, time: `${time} IST` };
}

const money = (inr, usd) => {
  const rupees = inr === null ? null : `₹${Math.round(inr).toLocaleString('en-IN')}`;
  const dollars = usd === null ? null : `$${Math.round(usd).toLocaleString('en-US')}`;
  if (rupees && dollars) return `${rupees} (${dollars})`;
  return rupees ?? dollars;
};

const MAX_CONFLICTS_LISTED = 3;

/** One plain line for a specialist that several projects are waiting for: who goes first and who waits. */
function conflictLine(conflict) {
  const projects = [];
  for (const e of conflict.entries) if (!projects.some((p) => p.podId === e.podId)) projects.push(e); // one per project, in serving order
  const label = (p) => `${plain(p.project, MAX_NAME_CHARS) || 'A project'} (${plain(p.priority, 2)})`;
  const [first, ...rest] = projects;
  const same = rest.length > 0 && rest[0].priority === first.priority ? ' They have the same priority, so the earlier request goes first.' : '';
  return `${plain(conflict.specialist, MAX_NAME_CHARS) || 'A shared specialist'} is wanted by ${projects.length} projects: ${label(first)} goes first; ${rest.map((p) => `${label(p)} waits`).join('; ')}.${same}`;
}

function specialistLines(conflicts) {
  if (conflicts.length === 0) return ['No conflicts: no shared specialist has work waiting from more than one project.'];
  const lines = conflicts.slice(0, MAX_CONFLICTS_LISTED).map(conflictLine);
  if (conflicts.length > MAX_CONFLICTS_LISTED) lines.push(`...and ${conflicts.length - MAX_CONFLICTS_LISTED} more shared specialists with competing projects.`);
  return lines;
}

function createBrief({ store, decisions, specialists, now = () => new Date() } = {}) {
  async function get() {
    const moment = now();
    const since = moment.getTime() - DAY_MS;

    const leads = asList(await store.select('clients', { where: { status: 'lead' }, order: 'created_at.desc', limit: READ_LIMIT }));
    const ticketsOpen = asList(await store.select('tickets', { where: { status: 'open' }, limit: READ_LIMIT }));
    const ticketsWorking = asList(await store.select('tickets', { where: { status: 'in_progress' }, limit: READ_LIMIT }));
    const ticketsAnswered = asList(await store.select('tickets', { where: { status: 'answered' }, order: 'updated_at.desc', limit: READ_LIMIT }));
    const ticketsEscalated = asList(await store.select('tickets', { where: { status: 'escalated' }, order: 'updated_at.desc', limit: READ_LIMIT }));
    const decided = await decisions.summary({ since: new Date(since).toISOString() });
    const pending = asList(decided?.waiting);
    const answered = asList(decided?.decided);
    const blocked = asList(await store.select('tasks', { where: { status: 'blocked' }, limit: READ_LIMIT }));
    const specialistConflicts = specialists ? asList(await specialists.conflicts()) : null;

    // ---- Waiting for you ----
    const waiting = [];
    if (pending.length === 0) waiting.push('Nothing is waiting for your answer.');
    else {
      const byCategory = CATEGORY_ORDER.map((c) => [c, pending.filter((d) => (CATEGORY_WORDS[d.category] ? d.category : 'unknown') === c).length]).filter(([, n]) => n > 0);
      waiting.push(`${plural(pending.length, 'decision is', 'decisions are')} waiting for your answer: ${byCategory.map(([c, n]) => `${n} about ${CATEGORY_WORDS[c]}`).join(', ')}.`);
      // The cards one by one, oldest first, so nothing waiting is hidden behind a number.
      const listed = pending.filter((d) => typeof d.question === 'string' && d.question !== '').slice(0, MAX_WAITING_LISTED);
      for (const d of listed) {
        const kind = CATEGORY_WORDS[d.category] ?? CATEGORY_WORDS.unknown;
        const age = waited(d.createdAt, moment.getTime());
        waiting.push(`${plain(d.question, 160)} (${kind}${age ? `, waiting ${age}` : ''})`);
      }
      if (listed.length > 0 && pending.length > listed.length) waiting.push(`...and ${pending.length - listed.length} more in the approval queue.`);
    }
    waiting.push(blocked.length === 0 ? 'No tasks are blocked.' : `${plural(blocked.length, 'task is', 'tasks are')} blocked and need someone to step in (see the Teams page).`);

    // ---- Revenue and deployments: no data source yet ----
    const revenue = ['Not tracked yet. No payments are connected, so there are no revenue figures to show.'];
    const deployments = ['Not tracked yet. No deployment tool is connected, so there is nothing to report.'];

    // ---- Leads ----
    const newLeads = leads.filter((l) => isAfter(l.created_at, since));
    const leadLines = [`${plural(leads.length, 'lead is', 'leads are')} in the list${leads.length >= READ_LIMIT ? ' (counted up to 200)' : ''}; ${newLeads.length} new in the last 24 hours.`];
    if (leads.length > 0) leadLines.push(`Latest: ${leads.slice(0, MAX_NAMES).map((l) => plain(l.name, MAX_NAME_CHARS) || 'a lead').join(', ')}.`);

    // ---- Tickets ----
    const answeredRecently = ticketsAnswered.filter((t) => isAfter(t.updated_at, since)).length;
    const escalatedRecently = ticketsEscalated.filter((t) => isAfter(t.updated_at, since)).length;
    const ticketLines = [`${capped(ticketsOpen.length)} open and ${capped(ticketsWorking.length)} being worked on.`, `In the last 24 hours: ${answeredRecently} answered and ${escalatedRecently} sent to you to decide.`];

    // ---- Spend requests ----
    const spendPending = pending.filter((d) => d.category === SPEND);
    const inr = spendPending.map((d) => amount(d.amountInr)).filter((n) => n !== null);
    const usd = spendPending.map((d) => amount(d.amountUsd)).filter((n) => n !== null);
    const total = money(inr.length > 0 ? inr.reduce((a, b) => a + b, 0) : null, usd.length > 0 ? usd.reduce((a, b) => a + b, 0) : null);
    const spendApproved = answered.filter((d) => d.category === SPEND && d.status === 'approved').length;
    const spendRejected = answered.filter((d) => d.category === SPEND && d.status === 'rejected').length;
    const spendLines = [
      spendPending.length === 0 ? 'No spend requests are waiting for your answer.' : `${plural(spendPending.length, 'spend request is', 'spend requests are')} waiting for your answer${total ? `, about ${total} in all` : ''}.`,
      `In the last 24 hours: ${spendApproved} approved and ${spendRejected} rejected.`,
    ];

    const { day, time } = istLabels(moment);
    const attention = pending.length + blocked.length;
    return {
      at: moment.toISOString(),
      dateLabel: day,
      headline: `Brief for ${day}, made at ${time}. ${attention === 0 ? 'Nothing needs you right now.' : `${plural(attention, 'thing needs', 'things need')} you.`}`,
      sections: [
        { key: 'waiting', title: 'Waiting for you', available: true, lines: waiting },
        { key: 'revenue', title: 'Revenue', available: false, lines: revenue },
        { key: 'leads', title: 'Leads', available: true, lines: leadLines },
        { key: 'tickets', title: 'Tickets', available: true, lines: ticketLines },
        { key: 'deployments', title: 'Deployments', available: false, lines: deployments },
        { key: 'spend', title: 'Spend requests', available: true, lines: spendLines },
        specialists
          ? { key: 'specialists', title: 'Shared specialists', available: true, lines: specialistLines(specialistConflicts) }
          : { key: 'specialists', title: 'Shared specialists', available: false, lines: ['Not tracked yet. The shared specialist queue is not connected here, so there is nothing to report.'] },
      ],
    };
  }

  return { get };
}

/** The brief as one plain message. Built only from the lines the window shows, so the two always agree. */
function renderBriefText(brief) {
  if (brief === null || typeof brief !== 'object' || !Array.isArray(brief.sections)) return 'The brief is not available right now.';
  const parts = [String(brief.headline ?? '')];
  for (const section of brief.sections) {
    parts.push('', String(section.title ?? ''), ...(Array.isArray(section.lines) ? section.lines : []).map((l) => `- ${l}`));
  }
  const text = parts.join('\n').trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

module.exports = { createBrief, renderBriefText, istLabels };
