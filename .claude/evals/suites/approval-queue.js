'use strict';

// Grades the logic behind the approval queue screen (PLAN.md step 1.9):
//   src/renderer/queue.mjs   (plain functions: no React, no window, nothing to mock)
//
//   mergeLists(...lists)                -> rows, oldest first, one per id (a later list wins)
//   applyEvent(rows, event)             -> { rows, refetch }   how a live runtime event changes the queue
//   cardView(row)                       -> what one card shows, every field as plain text
//   ageLabel(createdAt, now)            -> "just now", "5 minutes ago", ...
//   describeAnswer(result)              -> { tone, text, remove }  what to tell the founder after a click
//   answerArgs({ id, decision, note })  -> { ok, args } | { ok: false, problem }  the one thing sent to window.api
//
// The screen is thin on purpose: these functions decide what it shows, so they are what is graded.
// "A card approved on the phone disappears without a refresh" is the first group of cases here: the
// runtime announces `decision.resolved` for an answer from ANY channel, and applyEvent removes the card.

const { loadSubject } = require('../lib');

const SUBJECT = 'src/renderer/queue.mjs';
const queue = () => loadSubject(SUBJECT);
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

const row = (over = {}) => ({
  id: ID1,
  status: 'pending',
  category: 'spend',
  action: { tool: 'namecheap.purchase_domain', access: 'write', args: {} },
  card: {
    decide: 'Buy the domain launch.example?',
    why_now: 'The page needs an address before it can go live.',
    if_yes: 'We buy it.',
    if_no: 'The launch waits.',
    cost: '₹1,200 ($15)',
    risk: { level: 'Medium', reason: 'Money is spent.' },
    recommendation: 'Yes, it is needed.',
    details: 'Technical: registrar call with the domain name.',
  },
  created_at: '2026-11-24T10:00:00.000Z',
  ...over,
});

/** Freeze a value all the way down, so a function that changes its input throws. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const ids = (rows) => rows.map((r) => r.id).join();
const resolved = (id, status, via = 'telegram') => ({ type: 'decision.resolved', data: { id, status, via } });

const cases = [
  // ---- A card answered somewhere else disappears without a refresh ---------------------------------
  {
    id: 'a-card-approved-on-the-phone-leaves-the-queue-without-a-refetch',
    check() {
      const { applyEvent } = queue();
      const out = applyEvent([row({ id: ID1 }), row({ id: ID2 })], resolved(ID1, 'approved', 'telegram'));
      return verdict(ids(out.rows) === ID2 && out.refetch === false, json({ ids: ids(out.rows), refetch: out.refetch }));
    },
  },
  {
    id: 'a-rejected-or-cancelled-answer-and-a-cancelled-card-leave-the-queue-too',
    check() {
      const { applyEvent } = queue();
      const start = [row({ id: ID1 }), row({ id: ID2 }), row({ id: ID3 })];
      const a = applyEvent(start, resolved(ID1, 'rejected'));
      const b = applyEvent(start, resolved(ID2, 'cancelled'));
      const c = applyEvent(start, { type: 'decision.cancelled', data: { id: ID3 } });
      return verdict(ids(a.rows) === `${ID2},${ID3}` && ids(b.rows) === `${ID1},${ID3}` && ids(c.rows) === `${ID1},${ID2}` && [a, b, c].every((x) => x.refetch === false), json([ids(a.rows), ids(b.rows), ids(c.rows)]));
    },
  },
  {
    id: 'asking-for-more-information-keeps-the-card-and-marks-it',
    check() {
      const { applyEvent } = queue();
      const start = [row({ id: ID1 }), row({ id: ID2 })];
      const out = applyEvent(start, resolved(ID1, 'info_requested'));
      return verdict(out.rows.length === 2 && out.rows[0].status === 'info_requested' && out.rows[1].status === 'pending' && out.refetch === false && start[0].status === 'pending', json(out.rows.map((r) => r.status)));
    },
  },
  {
    id: 'a-new-decision-asks-for-one-fetch-and-changes-nothing-itself',
    check() {
      const { applyEvent } = queue();
      const start = [row({ id: ID1 })];
      const out = applyEvent(start, { type: 'decision.created', data: { id: ID2, category: 'spend' } });
      return verdict(ids(out.rows) === ID1 && out.refetch === true, json(out));
    },
  },
  {
    id: 'the-runtime-becoming-ready-asks-for-a-fetch-and-other-events-do-nothing',
    check() {
      const { applyEvent } = queue();
      const start = [row({ id: ID1 })];
      const ready = applyEvent(start, { type: 'runtime.ready', data: {} });
      const others = ['decision.reminded', 'policy.tool_changed', 'orchestrator.waiting', 'telegram.error', 'runtime.degraded', 'something.new'].map((type) => applyEvent(start, { type, data: { id: ID1, count: 1 } }));
      return verdict(ready.refetch === true && others.every((o) => o.refetch === false && ids(o.rows) === ID1), json({ ready: ready.refetch, others: others.map((o) => o.refetch) }));
    },
  },
  {
    id: 'an-event-for-a-card-that-is-not-in-the-queue-changes-nothing',
    check() {
      const { applyEvent } = queue();
      const start = [row({ id: ID1 })];
      const out = applyEvent(start, resolved(ID3, 'approved'));
      return verdict(ids(out.rows) === ID1 && out.refetch === false, json(out));
    },
  },
  {
    id: 'malformed-events-change-nothing-and-never-throw',
    check() {
      const { applyEvent } = queue();
      const start = [row({ id: ID1 })];
      const bad = [null, undefined, 5, 'x', {}, { type: 'decision.resolved' }, { type: 'decision.resolved', data: null }, { type: 'decision.resolved', data: { id: 5, status: 'approved' } }, { type: 'decision.resolved', data: { id: ID1 } }, { type: 'decision.resolved', data: { id: ID1, status: 'pending' } }, { type: 'decision.resolved', data: { id: ID1, status: 'banana' } }, { type: 5, data: {} }];
      for (const event of bad) {
        let out;
        try {
          out = applyEvent(start, event);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(event)}: ${err.message}`);
        }
        if (ids(out.rows) !== ID1 || out.refetch !== false) return verdict(false, `changed on ${json(event)}: ${json(out)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'applying-an-event-never-changes-the-list-it-was-given',
    check() {
      const { applyEvent } = queue();
      const start = deepFreeze([row({ id: ID1 }), row({ id: ID2 })]);
      try {
        applyEvent(start, resolved(ID1, 'approved'));
        applyEvent(start, resolved(ID2, 'info_requested'));
        applyEvent(start, { type: 'decision.created', data: { id: ID3 } });
      } catch (err) {
        if (err.constructor.name === 'PendingError') throw err;
        return verdict(false, `mutated its input: ${err.message}`);
      }
      return verdict(true);
    },
  },

  // ---- Merging the lists the screen loads ----------------------------------------------------------
  {
    id: 'two-lists-merge-oldest-first-with-one-card-per-id',
    check() {
      const { mergeLists } = queue();
      const pending = [row({ id: ID2, created_at: '2026-11-24T11:00:00.000Z' }), row({ id: ID3, created_at: '2026-11-24T12:00:00.000Z' })];
      const asked = [row({ id: ID1, status: 'info_requested', created_at: '2026-11-24T09:00:00.000Z' }), row({ id: ID2, status: 'info_requested', created_at: '2026-11-24T11:00:00.000Z' })];
      const merged = mergeLists(pending, asked);
      return verdict(ids(merged) === `${ID1},${ID2},${ID3}` && merged[1].status === 'info_requested', json(merged.map((r) => [r.id.slice(0, 2), r.status])));
    },
  },
  {
    id: 'merging-skips-rows-without-an-id-and-tolerates-missing-lists',
    check() {
      const { mergeLists } = queue();
      const merged = mergeLists([row({ id: ID1 }), null, 5, {}, { id: 7 }], undefined, null, 'x');
      return verdict(ids(merged) === ID1, json(merged));
    },
  },
  {
    id: 'cards-with-the-same-time-keep-a-stable-order',
    check() {
      const { mergeLists } = queue();
      const same = '2026-11-24T10:00:00.000Z';
      const a = mergeLists([row({ id: ID3, created_at: same }), row({ id: ID1, created_at: same }), row({ id: ID2, created_at: same })]);
      const b = mergeLists([row({ id: ID2, created_at: same }), row({ id: ID3, created_at: same }), row({ id: ID1, created_at: same })]);
      return verdict(ids(a) === ids(b) && ids(a) === `${ID1},${ID2},${ID3}`, `${ids(a)} | ${ids(b)}`);
    },
  },
  {
    id: 'merging-never-changes-its-inputs',
    check() {
      const { mergeLists } = queue();
      const a = deepFreeze([row({ id: ID2 })]);
      const b = deepFreeze([row({ id: ID1 })]);
      try {
        mergeLists(a, b);
      } catch (err) {
        if (err.constructor.name === 'PendingError') throw err;
        return verdict(false, `mutated its input: ${err.message}`);
      }
      return verdict(true);
    },
  },

  // ---- What one card shows ---------------------------------------------------------------------------------
  {
    id: 'a-card-view-has-all-seven-fields-the-details-and-the-tool',
    check() {
      const { cardView } = queue();
      const v = cardView(row());
      const ok = v.id === ID1 && v.title === 'Buy the domain launch.example?' && v.whyNow === 'The page needs an address before it can go live.' && v.ifYes === 'We buy it.' && v.ifNo === 'The launch waits.' && v.cost === '₹1,200 ($15)' && v.risk.level === 'Medium' && v.risk.reason === 'Money is spent.' && v.recommendation === 'Yes, it is needed.' && v.details === 'Technical: registrar call with the domain name.' && v.tool === 'namecheap.purchase_domain';
      return verdict(ok, json(v));
    },
  },
  {
    id: 'the-category-gets-a-plain-label',
    check() {
      const { cardView } = queue();
      const labels = ['spend', 'people_or_contracts', 'launch_or_pricing', 'legal_or_public', 'unknown'].map((category) => cardView(row({ category })).categoryLabel);
      const ok = labels.every((l) => typeof l === 'string' && l.length > 0 && !l.includes('_')) && new Set(labels).size === 5;
      return verdict(ok, json(labels));
    },
  },
  {
    id: 'missing-or-odd-fields-become-empty-text-and-never-throw',
    check() {
      const { cardView } = queue();
      const odd = [null, undefined, 5, 'x', [], {}, { id: ID1 }, { id: ID1, card: null }, { id: ID1, card: 'text' }, { id: ID1, card: { decide: 5, risk: 'High', details: ['a'] } }, { id: ID1, card: { risk: { level: 7, reason: {} } }, action: 'tool' }];
      for (const r of odd) {
        let v;
        try {
          v = cardView(r);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(r)}: ${err.message}`);
        }
        const texts = [v.title, v.whyNow, v.ifYes, v.ifNo, v.cost, v.recommendation, v.risk.level, v.risk.reason];
        if (!texts.every((t) => typeof t === 'string')) return verdict(false, `non-text field for ${json(r)}: ${json(v)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'risk-gets-a-tone-and-the-level-is-always-kept-as-words',
    check() {
      const { cardView } = queue();
      const tones = Object.fromEntries(['Low', 'Medium', 'High', 'Extreme', ''].map((level) => [level, cardView(row({ card: { ...row().card, risk: { level, reason: 'r' } } })).risk]));
      const ok = tones.Low.tone === 'low' && tones.Medium.tone === 'medium' && tones.High.tone === 'high' && tones.Extreme.tone === 'unknown' && tones[''].tone === 'unknown' && tones.High.level === 'High' && tones.Extreme.level === 'Extreme';
      return verdict(ok, json(tones));
    },
  },
  {
    id: 'details-are-only-there-when-there-is-text',
    check() {
      const { cardView } = queue();
      const none = [undefined, null, '', '   ', 5, ['x']].map((details) => cardView(row({ card: { ...row().card, details } })).details);
      const trimmed = cardView(row({ card: { ...row().card, details: '  spaced  ' } })).details;
      return verdict(none.every((d) => d === null) && trimmed === 'spaced', json({ none, trimmed }));
    },
  },
  {
    id: 'only-a-waiting-card-can-be-asked-about-and-each-state-has-a-label',
    check() {
      const { cardView } = queue();
      const pending = cardView(row({ status: 'pending' }));
      const asked = cardView(row({ status: 'info_requested' }));
      const ok = pending.canAskMore === true && asked.canAskMore === false && /waiting for you/i.test(pending.statusLabel) && /asked for more/i.test(asked.statusLabel);
      return verdict(ok, json([pending.statusLabel, asked.statusLabel]));
    },
  },
  {
    id: 'a-card-for-an-unknown-tool-says-approving-it-does-not-run-it',
    check() {
      const { cardView } = queue();
      const unknown = cardView(row({ category: 'unknown', action: { tool: 'newtool.run', access: 'write', args: {} } }));
      const normal = cardView(row());
      return verdict(/policy table/i.test(unknown.note) && /not run|does not run|will not run/i.test(unknown.note) && normal.note === null, json({ unknown: unknown.note, normal: normal.note }));
    },
  },
  {
    id: 'text-is-passed-through-as-it-is-never-turned-into-markup',
    check() {
      const { cardView } = queue();
      const nasty = '<img src=x onerror=alert(1)> & "quotes" <script>x</script>';
      const v = cardView(row({ card: { ...row().card, decide: nasty, recommendation: nasty } }));
      return verdict(v.title === nasty && v.recommendation === nasty, json(v.title));
    },
  },

  // ---- How old a card is -------------------------------------------------------------------------------------
  {
    id: 'age-is-said-in-plain-words',
    check() {
      const { ageLabel } = queue();
      const now = new Date('2026-11-24T12:00:00.000Z');
      const at = (ms) => ageLabel(new Date(now.getTime() - ms).toISOString(), now);
      const out = [at(5_000), at(60_000), at(5 * 60_000), at(60 * 60_000), at(3 * 3_600_000), at(24 * 3_600_000), at(3 * 24 * 3_600_000)];
      const ok = out[0] === 'just now' && out[1] === '1 minute ago' && out[2] === '5 minutes ago' && out[3] === '1 hour ago' && out[4] === '3 hours ago' && out[5] === '1 day ago' && out[6] === '3 days ago';
      return verdict(ok, json(out));
    },
  },
  {
    id: 'a-time-in-the-future-or-a-bad-time-gives-just-now-or-nothing',
    check() {
      const { ageLabel } = queue();
      const now = new Date('2026-11-24T12:00:00.000Z');
      const future = ageLabel('2026-11-25T12:00:00.000Z', now);
      const bad = [undefined, null, '', 'not a date', 5, {}].map((v) => ageLabel(v, now));
      return verdict(future === 'just now' && bad.every((b) => b === ''), json({ future, bad }));
    },
  },

  // ---- Telling the founder what happened -------------------------------------------------------------------------
  {
    id: 'an-answer-that-took-effect-is-confirmed-and-a-final-one-removes-the-card',
    check() {
      const { describeAnswer } = queue();
      const approved = describeAnswer({ ok: true, data: { id: ID1, status: 'approved', changed: true, conflict: false } });
      const rejected = describeAnswer({ ok: true, data: { id: ID1, status: 'rejected', changed: true, conflict: false } });
      const asked = describeAnswer({ ok: true, data: { id: ID1, status: 'info_requested', changed: true, conflict: false } });
      const ok = approved.tone === 'ok' && /approved/i.test(approved.text) && approved.remove === true && rejected.remove === true && /rejected/i.test(rejected.text) && asked.remove === false && /more information/i.test(asked.text);
      return verdict(ok, json({ approved, rejected, asked }));
    },
  },
  {
    id: 'an-answer-that-lost-the-race-says-so-and-the-card-goes',
    check() {
      const { describeAnswer } = queue();
      const same = describeAnswer({ ok: true, data: { id: ID1, status: 'approved', changed: false, conflict: false } });
      const differs = describeAnswer({ ok: true, data: { id: ID1, status: 'approved', changed: false, conflict: true } });
      const ok = same.tone === 'info' && /already approved/i.test(same.text) && same.remove === true && /already approved/i.test(differs.text) && differs.remove === true;
      return verdict(ok, json({ same, differs }));
    },
  },
  {
    id: 'a-refused-or-garbled-answer-is-an-error-that-keeps-the-card',
    check() {
      const { describeAnswer } = queue();
      const refused = describeAnswer({ ok: false, error: { code: 'blocked', message: 'The system is paused, so nothing was changed.' } });
      const garbage = [null, undefined, 5, 'x', {}, { ok: true }, { ok: true, data: null }, { ok: false }].map((r) => describeAnswer(r));
      const ok = refused.tone === 'error' && refused.text === 'The system is paused, so nothing was changed.' && refused.remove === false && garbage.every((g) => g.tone === 'error' && g.remove === false && typeof g.text === 'string' && g.text.length > 0);
      return verdict(ok, json({ refused, garbage }));
    },
  },

  // ---- What is sent to the runtime -----------------------------------------------------------------------------
  {
    id: 'the-arguments-hold-only-the-id-the-decision-and-a-trimmed-note',
    check() {
      const { answerArgs } = queue();
      const plain = answerArgs({ id: ID1, decision: 'approved' });
      const noted = answerArgs({ id: ID1, decision: 'info_requested', note: '  What is the total cost?  ' });
      const blank = answerArgs({ id: ID1, decision: 'info_requested', note: '   ' });
      const ok = plain.ok && json(plain.args) === json({ id: ID1, decision: 'approved' }) && noted.ok && json(noted.args) === json({ id: ID1, decision: 'info_requested', note: 'What is the total cost?' }) && blank.ok && json(blank.args) === json({ id: ID1, decision: 'info_requested' });
      return verdict(ok, json({ plain, noted, blank }));
    },
  },
  {
    id: 'a-bad-decision-id-or-too-long-a-note-is-refused-before-anything-is-sent',
    check() {
      const { answerArgs } = queue();
      const bad = [
        answerArgs({ id: 'nope', decision: 'approved' }),
        answerArgs({ id: ID1, decision: 'banana' }),
        answerArgs({ id: ID1, decision: 'cancelled' }),
        answerArgs({ id: ID1, decision: 'approved', note: 'x'.repeat(2001) }),
        answerArgs(null),
        answerArgs({}),
      ];
      return verdict(bad.every((b) => b.ok === false && typeof b.problem === 'string' && b.problem.length > 0), json(bad));
    },
  },
  {
    id: 'nothing-else-can-ride-along-in-the-arguments',
    check() {
      const { answerArgs } = queue();
      const out = answerArgs({ id: ID1, decision: 'approved', via: 'telegram', status: 'approved', channel: 'telegram', note: undefined, extra: 1 });
      return verdict(out.ok && Object.keys(out.args).sort().join() === 'decision,id', json(out));
    },
  },
];

module.exports = {
  name: 'approval-queue',
  description: 'Approval queue logic: live events change the list without a refresh, a card is read as plain text, an answer is reported honestly and sent as only the id, the decision and a note',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
