'use strict';

// Grades the morning digest (PLAN.md step 2.6: "The bot sends a digest at a fixed IST time and answers /brief. Done when: the digest arrives on
// schedule and matches the dashboard brief."):
//   src/runtime/telegram/digest.js
//     parseDigestTime(value)  -> { ok, off, time, problem? }       DIGEST_TIME_IST: unset = 09:00, "off" = no digest, otherwise HH:MM (24 hours)
//     startDigestJob({ time, getText, send, ledger, now?, timers?, onError? }) -> { stop, tick }
//       ledger: { lastSentDate() -> 'YYYY-MM-DD' | null, record(action, detail) }   (the audit log, in the app)
//
// A fake clock and fake timers make every case exact. What the cases pin down:
//   - the time is IST whatever the computer's time zone is, and the digest goes out once a day: at the set time or, if the app was not running
//     then, as soon as it starts, but only within six hours after it; a restart the same day does not send it again
//   - "no audit, no action": the attempt is recorded BEFORE anything is sent, and if that cannot be recorded nothing is sent
//   - a failure is tried again after five minutes, at most six times a day, and is reported to onError only
//   - the text sent is the brief's own text, built from the very lines the window shows, so the digest matches the dashboard brief

const { loadSubject } = require('../lib');

const SUBJECT = 'src/runtime/telegram/digest.js';
const BRIEF = 'src/runtime/brief.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const digest = () => loadSubject(SUBJECT);
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const MIN = 60_000;

// 2026-11-25 is a Wednesday. 03:30 UTC is 09:00 IST.
const IST_0859 = '2026-11-25T03:29:00Z';
const IST_0900 = '2026-11-25T03:30:00Z';

/** A job on a fake clock and fake timers, with an in-memory ledger. */
function harness(over = {}) {
  const clock = { t: Date.parse(over.start ?? IST_0900) };
  const intervals = [];
  const timers = { setInterval: (fn, ms) => { const h = { fn, ms, cleared: false, unref() {} }; intervals.push(h); return h; }, clearInterval: (h) => { h.cleared = true; } };
  const sent = [];
  const records = [];
  const errors = [];
  let lastSent = over.lastSent ?? null;
  const ledger = {
    async lastSentDate() { if (over.ledgerFails) throw new Error('database said sb_secret_ABCDEFGHIJKLMNOP'); return lastSent; },
    async record(action, detail) {
      if (over.recordFails === true || over.recordFails === action) throw new Error('audit is down');
      records.push({ action, detail });
      if (action === 'digest.sent') lastSent = detail.date;
    },
  };
  const job = digest().startDigestJob({
    time: over.time ?? '09:00',
    getText: over.getText ?? (async () => 'THE BRIEF'),
    send: over.send ?? (async (text) => { sent.push(text); }),
    ledger,
    now: () => new Date(clock.t),
    timers,
    onError: (err) => errors.push(err),
  });
  return { job, clock, intervals, sent, records, errors, at: (iso) => { clock.t = Date.parse(iso); }, advance: (ms) => { clock.t += ms; } };
}

const cases = [
  {
    id: 'the-setting-defaults-to-nine-in-the-morning-can-be-turned-off-and-a-bad-value-says-so-without-repeating-it',
    check() {
      const { parseDigestTime } = digest();
      const unset = [undefined, null, '', '   '].map((v) => parseDigestTime(v));
      const good = ['07:30', '09:00', '00:00', '23:59', ' 18:05 '].map((v) => parseDigestTime(v));
      const off = ['off', 'OFF', ' Off '].map((v) => parseDigestTime(v));
      const badInputs = ['9:00', '24:00', '12:60', 'noon', '09:00 IST', '0900', '09.00', 'on', 'never', 5, true, {}, ['09:00']];
      const bad = badInputs.map((v) => parseDigestTime(v));
      return verdict(unset.every((r) => r.ok && !r.off && r.time === '09:00') && good.map((r) => r.time).join() === '07:30,09:00,00:00,23:59,18:05' && good.every((r) => r.ok && !r.off)
        && off.every((r) => r.ok && r.off && r.time === null) && bad.every((r) => r.ok === false && r.off === true && /DIGEST_TIME_IST/.test(r.problem) && /off/.test(r.problem) && !/noon|never/.test(r.problem)), json({ unset, off, bad: bad.map((r) => r.ok) }));
    },
  },
  {
    id: 'the-date-and-the-time-are-worked-out-in-indian-time-whatever-the-computers-zone-is',
    check() {
      const { istDateKey, istMinutes } = digest();
      const at = (iso) => [istDateKey(new Date(iso)), istMinutes(new Date(iso))];
      return verdict(json(at('2026-11-25T03:30:00Z')) === json(['2026-11-25', 540]) && json(at('2026-11-25T18:29:59Z')) === json(['2026-11-25', 1439]) && json(at('2026-11-25T18:30:00Z')) === json(['2026-11-26', 0])
        && json(at('2026-12-31T18:30:00Z')) === json(['2027-01-01', 0]) && json(at('2026-11-25T00:00:00Z')) === json(['2026-11-25', 330]), json({ a: at('2026-11-25T03:30:00Z'), b: at('2026-11-25T18:30:00Z') }));
    },
  },
  {
    id: 'the-digest-goes-out-once-a-day-at-the-set-time-and-not-before',
    async check() {
      const h = harness({ start: IST_0859 });
      await settle();
      const before = h.sent.length;
      h.advance(MIN); // 09:00 IST
      await h.job.tick();
      const at = h.sent.length;
      for (let i = 0; i < 5; i += 1) { h.advance(30 * MIN); await h.job.tick(); } // through to 11:30 IST
      const same = h.sent.length;
      h.at('2026-11-26T03:30:00Z'); // the next day, 09:00 IST
      await h.job.tick();
      h.advance(MIN);
      await h.job.tick();
      const next = h.sent.length;
      return verdict(before === 0 && at === 1 && same === 1 && next === 2 && h.sent.every((t) => t === 'THE BRIEF') && h.intervals.length === 1 && h.intervals[0].ms === 60_000
        && h.records.map((r) => `${r.action}:${r.detail.date}`).join() === 'digest.sending:2026-11-25,digest.sent:2026-11-25,digest.sending:2026-11-26,digest.sent:2026-11-26', json({ before, at, same, next, records: h.records }));
    },
  },
  {
    id: 'the-digest-text-is-the-briefs-own-text-built-from-the-lines-the-window-shows',
    async check() {
      const { createBrief, renderBriefText } = loadSubject(BRIEF);
      const rows = {
        clients: [{ name: 'Acme Ltd', status: 'lead', created_at: '2026-11-25T01:00:00Z' }], tickets: [{ status: 'open' }, { status: 'in_progress' }],
        decisions: [{ status: 'pending', category: 'spend', amount_inr: 5000, amount_usd: 60, created_at: '2026-11-24T10:00:00Z' }], tasks: [{ status: 'blocked' }],
      };
      const store = { async select(table, { where = {} } = {}) { return (rows[table] ?? []).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)); } };
      const decisions = loadSubject('src/runtime/decisions.js').createDecisionService({ store, audit: { async append() {} }, emit() {}, isBlocked: () => null, policy: require(require('node:path').join(require('../lib').ROOT, 'src/runtime/policy')) });
      const brief = createBrief({ store, decisions, now: () => new Date(IST_0900) });
      const h = harness({ getText: async () => renderBriefText(await brief.get()) });
      await settle();
      const dashboard = await brief.get(); // what the window shows
      const lines = dashboard.sections.flatMap((s) => [s.title, ...s.lines]);
      const text = h.sent[0] ?? '';
      return verdict(h.sent.length === 1 && text === renderBriefText(dashboard) && text.startsWith(dashboard.headline) && lines.every((l) => text.includes(l)) && /IST/.test(text) && text.length < 4000, json({ sent: h.sent.length, text: text.slice(0, 200) }));
    },
  },
  {
    id: 'an-app-started-after-the-set-time-sends-at-once-but-only-within-six-hours-of-it',
    async check() {
      const late = harness({ start: '2026-11-25T03:50:00Z' }); // 09:20 IST
      await settle();
      const justInside = harness({ start: '2026-11-25T09:29:00Z' }); // 14:59 IST
      await settle();
      const outside = harness({ start: '2026-11-25T09:30:00Z' }); // 15:00 IST, six hours after
      await settle();
      const night = harness({ start: '2026-11-25T14:30:00Z' }); // 20:00 IST
      await settle();
      const early = harness({ start: '2026-11-25T02:00:00Z' }); // 07:30 IST
      await settle();
      return verdict(late.sent.length === 1 && justInside.sent.length === 1 && outside.sent.length === 0 && night.sent.length === 0 && early.sent.length === 0, json({ late: late.sent.length, justInside: justInside.sent.length, outside: outside.sent.length, night: night.sent.length, early: early.sent.length }));
    },
  },
  {
    id: 'a-restart-the-same-day-does-not-send-it-again-and-a-custom-time-is-respected',
    async check() {
      const already = harness({ lastSent: '2026-11-25' });
      await settle();
      const yesterday = harness({ lastSent: '2026-11-24' });
      await settle();
      const evening = harness({ time: '18:30', start: '2026-11-25T12:59:00Z' }); // 18:29 IST
      await settle();
      const before = evening.sent.length;
      evening.advance(MIN);
      await evening.job.tick();
      return verdict(already.sent.length === 0 && already.records.length === 0 && yesterday.sent.length === 1 && before === 0 && evening.sent.length === 1, json({ already: already.sent.length, yesterday: yesterday.sent.length, before, evening: evening.sent.length }));
    },
  },
  {
    id: 'the-attempt-is-recorded-before-anything-is-sent-and-if-it-cannot-be-recorded-nothing-is-sent',
    async check() {
      const logged = [];
      const ledger = { async lastSentDate() { return null; }, async record(action) { logged.push(`record:${action}`); } };
      const job = digest().startDigestJob({ time: '09:00', getText: async () => 'x', send: async () => { logged.push('send'); }, ledger, now: () => new Date(IST_0900), timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
      await settle();
      job.stop();
      const noAudit = harness({ recordFails: 'digest.sending' });
      await settle();
      noAudit.advance(5 * MIN);
      await noAudit.job.tick();
      return verdict(logged.join() === 'record:digest.sending,send,record:digest.sent' && noAudit.sent.length === 0 && noAudit.errors.length >= 1, json({ logged, sent: noAudit.sent.length, errors: noAudit.errors.length }));
    },
  },
  {
    id: 'a-failed-send-is-tried-again-after-five-minutes-at-most-six-times-a-day-and-then-succeeds-or-gives-up',
    async check() {
      let fails = 100;
      const attempts = [];
      const h = harness({ send: async (text) => { attempts.push(h.clock.t); if (fails > 0) { fails -= 1; throw new Error('Telegram said ETIMEDOUT'); } h.sent.push(text); } });
      await settle();
      const first = attempts.length;
      h.advance(4 * MIN); await h.job.tick();
      const tooSoon = attempts.length;
      h.advance(MIN); await h.job.tick();
      const second = attempts.length;
      for (let i = 0; i < 20; i += 1) { h.advance(5 * MIN); await h.job.tick(); }
      const capped = attempts.length;
      const gaveUp = h.sent.length === 0;
      // The next day succeeds on the third try.
      fails = 2;
      h.at('2026-11-26T03:30:00Z'); await h.job.tick();
      for (let i = 0; i < 6; i += 1) { h.advance(5 * MIN); await h.job.tick(); }
      return verdict(first === 1 && tooSoon === 1 && second === 2 && capped === 6 && gaveUp && h.errors.length >= 6 && h.sent.length === 1 && h.records.filter((r) => r.action === 'digest.sent').length === 1 && !JSON.stringify(h.records).includes('ETIMEDOUT'), json({ first, tooSoon, second, capped, sent: h.sent.length, errors: h.errors.length }));
    },
  },
  {
    id: 'a-brief-that-cannot-be-made-or-a-ledger-that-cannot-be-read-sends-nothing-and-is-tried-again',
    async check() {
      let ok = false;
      const noBrief = harness({ getText: async () => { if (!ok) throw new Error('database down'); return 'LATER'; } });
      await settle();
      const first = noBrief.sent.length;
      ok = true;
      noBrief.advance(5 * MIN); await noBrief.job.tick();
      const noLedger = harness({ ledgerFails: true });
      await settle();
      return verdict(first === 0 && noBrief.sent.length === 1 && noBrief.sent[0] === 'LATER' && noLedger.sent.length === 0 && noLedger.errors.length >= 1, json({ first, later: noBrief.sent.length, noLedger: noLedger.sent.length }));
    },
  },
  {
    id: 'overlapping-checks-send-once-and-stop-ends-the-job',
    async check() {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const h = harness({ start: IST_0859, send: async (t) => { await gate; h.sent.push(t); } });
      await settle();
      h.advance(MIN);
      const a = h.job.tick();
      const b = h.job.tick();
      await settle();
      release();
      await Promise.all([a, b]);
      await settle();
      const once = h.sent.length;
      const stopped = harness({ start: IST_0859 });
      await settle();
      stopped.job.stop();
      stopped.advance(MIN);
      await stopped.job.tick();
      return verdict(once === 1 && stopped.sent.length === 0 && stopped.intervals[0].cleared === true, json({ once, stopped: stopped.sent.length, cleared: stopped.intervals[0].cleared }));
    },
  },
  {
    id: 'a-job-without-what-it-needs-does-nothing-and-never-throws',
    async check() {
      const { startDigestJob } = digest();
      const timers = { setInterval() { throw new Error('should not start a timer'); }, clearInterval() {} };
      const ledger = { async lastSentDate() { return null; }, async record() {} };
      const jobs = [startDigestJob(), startDigestJob({}), startDigestJob({ time: 'noon', getText: async () => 'x', send: async () => {}, ledger, timers }), startDigestJob({ time: '09:00', send: async () => {}, ledger, timers }), startDigestJob({ time: '09:00', getText: async () => 'x', send: async () => {}, ledger: {}, timers })];
      for (const job of jobs) { await job.tick(); job.stop(); }
      return verdict(jobs.length === 5, 'ok');
    },
  },
];

module.exports = {
  name: 'morning-digest',
  description: 'Morning digest (step 2.6): sent once a day at the set IST time (or on start, within six hours after it), never twice, audited first, retried a few times, and the text is the brief the window shows',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
