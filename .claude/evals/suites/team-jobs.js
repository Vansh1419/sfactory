'use strict';

// Grades starting a team from the window (Phase 2 follow-up, Nov 26, 2026):
//   src/runtime/teams/jobs.js   createTeamJobs({ sales, support, emit?, onError?, maxAtOnce? })
//     .startLead({ company, website?, email?, price? }) -> { ok: true, message } | { ok: false, code, message }
//     .startTicket({ ticketId? })                       -> the same (the oldest open ticket, or the one named)
//     .running()                                        -> how many jobs are running
//   A job is STARTED at once; how it ended is announced later as the event `team.job_finished` { kind, status, message }.
//
// What the cases pin down:
//   - the answer comes back before the team has finished, and the team is called with the checked lead
//   - a lead with a bad detail, a ticket id that is not an id, a missing team, or two jobs already running never reaches a team
//   - what the window is told is made of fixed sentences and the team's own plain reasons: never an error's text
//   - a team that throws, or a listener that throws, never leaves a job counted as running

const { loadSubject } = require('../lib');

const SUBJECT = 'src/runtime/teams/jobs.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const jobs = (over = {}) => {
  const events = [];
  const errors = [];
  const made = loadSubject(SUBJECT).createTeamJobs({ emit: (type, data) => events.push({ type, data }), onError: (e) => errors.push(e), ...over });
  return { made, events, errors };
};
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
/** A team job that finishes only when the test says so. */
const controllable = () => {
  const calls = [];
  const release = [];
  return { calls, release, run: (arg) => { calls.push(arg); return new Promise((resolve) => release.push(resolve)); } };
};
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const cases = [
  {
    id: 'a-lead-is-started-at-once-with-the-checked-details-and-how-it-ended-is-announced-later',
    async check() {
      const lead = controllable();
      const { made, events } = jobs({ sales: { workLead: lead.run } });
      const r = made.startLead({ company: '  Acme Online Shoes ', website: 'https://acme-shoes.example/', email: 'hello@acme-shoes.example' });
      const before = { running: made.running(), events: events.length, calls: lead.calls.length };
      lead.release[0]({ status: 'done', taskId: 't', outputs: [] });
      await settle();
      return verdict(r.ok === true && /Started/.test(r.message) && before.running === 1 && before.events === 0 && before.calls === 1
        && lead.calls[0].company === 'Acme Online Shoes' && lead.calls[0].website === 'https://acme-shoes.example/' && lead.calls[0].email === 'hello@acme-shoes.example'
        && events.length === 1 && events[0].type === 'team.job_finished' && events[0].data.kind === 'lead' && events[0].data.status === 'done' && /sales team finished/.test(events[0].data.message) && made.running() === 0, json({ r, before, events }));
    },
  },
  {
    id: 'a-lead-with-a-bad-detail-is-refused-with-the-reason-and-no-team-is-called',
    async check() {
      const calls = [];
      const { made, events } = jobs({ sales: { workLead: async (l) => { calls.push(l); return { status: 'done' }; } } });
      const bad = [undefined, null, 'Acme', [], {}, { company: '' }, { company: 5 }, { company: 'A\nB' }, { company: 'Acme', website: 'http://insecure.example/' }, { company: 'Acme', email: 'a@x.co, b@x.co' }, { company: 'Acme', email: 'nope' }, { company: 'Acme', price: 'p'.repeat(101) }, { company: 'Acme', status: 'active' }];
      const results = bad.map((input) => made.startLead(input));
      await settle();
      return verdict(results.every((r) => r.ok === false && r.code === 'invalid_lead' && /^The lead could not be used\./.test(r.message)) && calls.length === 0 && events.length === 0 && made.running() === 0
        && /email address is not valid/i.test(results[10].message), json({ results: results.map((r) => [r.ok, r.code]), calls: calls.length }));
    },
  },
  {
    id: 'at-most-two-jobs-run-at-once-and-a-slot-is-free-again-when-one-ends',
    async check() {
      const lead = controllable();
      const ticket = controllable();
      const { made } = jobs({ sales: { workLead: lead.run }, support: { workNext: ticket.run, workTicket: ticket.run } });
      const a = made.startLead({ company: 'One' });
      const b = made.startTicket({});
      const c = made.startLead({ company: 'Three' });
      const d = made.startTicket({});
      const during = made.running();
      lead.release[0]({ status: 'done' });
      await settle();
      const e = made.startLead({ company: 'Four' });
      return verdict(a.ok && b.ok && c.ok === false && c.code === 'busy' && /2 team jobs are already running/.test(c.message) && d.code === 'busy' && during === 2 && e.ok === true && made.running() === 2 && lead.calls.length === 2 && ticket.calls.length === 1, json({ a, b, c, d, e, during }));
    },
  },
  {
    id: 'a-ticket-job-takes-the-oldest-open-ticket-or-the-one-named-and-a-bad-id-never-reaches-the-team',
    async check() {
      const calls = [];
      const support = { workNext: async () => { calls.push(['next']); return { status: 'none' }; }, workTicket: async (a) => { calls.push(['ticket', a]); return { status: 'needs_founder', taskId: 't', decisionId: 'd' }; } };
      const { made, events } = jobs({ support });
      const next = made.startTicket();
      await settle();
      const next2 = made.startTicket({});
      await settle();
      const named = made.startTicket({ ticketId: ID });
      await settle();
      const bad = [{ ticketId: 'nope' }, { ticketId: 5 }, { ticketId: `${ID}'; drop table tickets` }, { ticketId: null }, 'x'].map((i) => made.startTicket(i));
      await settle();
      const messages = events.map((e) => e.data.message);
      return verdict(next.ok && next2.ok && named.ok && json(calls.map((c) => c[0])) === json(['next', 'next', 'ticket', 'next']) /* the last is the input "x": no ticket id means the oldest open ticket */ && calls[2][1].ticketId === ID && bad.slice(0, 4).every((r) => r.ok === false && r.code === 'invalid_ticket') && bad[4].ok === true
        && messages.filter((m) => m === 'There are no open tickets.').length >= 2 && messages.some((m) => /needs your decision.*Nothing was sent to anyone/.test(m)), json({ calls, messages }));
    },
  },
  {
    id: 'a-missing-team-is-not-available-and-nothing-is-counted',
    async check() {
      const { made } = jobs({});
      const lead = made.startLead({ company: 'Acme' });
      const ticket = made.startTicket({});
      const half = jobs({ support: {} }).made.startTicket({});
      return verdict(lead.ok === false && lead.code === 'not_available' && ticket.ok === false && ticket.code === 'not_available' && half.code === 'not_available' && made.running() === 0, json({ lead, ticket, half }));
    },
  },
  {
    id: 'what-the-window-is-told-is-fixed-sentences-and-the-teams-own-reasons-and-never-an-errors-text',
    async check() {
      const SECRET = 'connection to db.internal failed sb_secret_ABCDEFGHIJKLMNOP';
      const outcomes = [
        { status: 'blocked', taskId: 't', reason: 'The lead did not accept the work after 2 tries.' },
        { status: 'failed', reason: 'team_unavailable' },
        { status: 'failed', reason: 'not_available' },
        { status: 'failed', reason: 'not_answered' },
        { status: 'failed', reason: 'card_failed' },
        { status: 'failed', reason: 'some_new_reason' },
        { status: 'failed', reason: 'bad_lead', problems: ['The email address is not valid.'] },
        { status: 'weird' },
        { status: 'blocked', reason: 'x'.repeat(1000) },
      ];
      const messages = [];
      for (const outcome of outcomes) {
        const { made, events } = jobs({ sales: { workLead: async () => outcome } });
        made.startLead({ company: 'Acme' });
        await settle();
        messages.push(events[0].data.message);
      }
      const throwing = jobs({ sales: { workLead: async () => { throw new Error(SECRET); } } });
      throwing.made.startLead({ company: 'Acme' });
      await settle();
      return verdict(messages[0] === 'The team could not finish. The lead did not accept the work after 2 tries.' && /not available right now/.test(messages[1]) && /not open any more/.test(messages[2]) && /finished without answering/.test(messages[3]) && /card for you could not be written/.test(messages[4])
        && messages[5] === 'The team could not do that.' && messages[6] === 'The lead could not be used. The email address is not valid.' && messages[7] === 'The team stopped.' && messages[8].length <= 400 && messages[8].endsWith('…')
        && throwing.events[0].data.message === 'The team could not do that.' && throwing.events[0].data.status === 'failed' && !JSON.stringify(throwing.events).includes('db.internal') && throwing.errors.length === 1, json({ messages, throwing: throwing.events }));
    },
  },
  {
    id: 'a-team-or-a-listener-that-throws-never-leaves-a-job-counted-as-running',
    async check() {
      const a = jobs({ sales: { workLead: async () => { throw new Error('boom'); } } });
      a.made.startLead({ company: 'One' });
      a.made.startLead({ company: 'Two' });
      await settle();
      const b = jobs({ sales: { workLead: async () => ({ status: 'done' }) }, emit: () => { throw new Error('the window is gone'); } });
      b.made.startLead({ company: 'One' });
      await settle();
      const c = jobs({ sales: { workLead: () => { throw new Error('thrown at once'); } } });
      c.made.startLead({ company: 'One' });
      await settle();
      return verdict(a.made.running() === 0 && a.errors.length === 2 && b.made.running() === 0 && b.errors.length === 1 && c.made.running() === 0 && c.errors.length === 1 && a.made.startLead({ company: 'Three' }).ok === true, json({ a: a.made.running(), b: b.made.running(), c: c.made.running() }));
    },
  },
];

module.exports = {
  name: 'team-jobs',
  description: 'Starting a team from the window: started at once with checked details, announced when it ends, two at a time, bad leads and ids refused before any team runs, plain sentences only',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
