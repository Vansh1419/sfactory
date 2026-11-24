'use strict';

// Properties of the card checker and the writer-checker loop (PLAN.md step 1.5).
// The golden cases live in .claude/evals/datasets/decision-cards.json; these cover
// what a list of examples cannot: every jargon term, false alarms on ordinary
// writing, hostile input, and what the loop promises about its result.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCard, produceCard, writerInstructions, JARGON_TERMS, RISK_LEVELS, DEFAULT_ATTEMPTS, MAX_ATTEMPTS } = require('./cards');

const GOOD = Object.freeze({
  decide: 'The new login page for Client A is ready. Can we make it live for their customers?',
  why_now: 'Client A asked for it to be ready this week.',
  if_yes: 'It goes live tonight.',
  if_no: 'It waits until you decide.',
  cost: '₹0 ($0)',
  risk: Object.freeze({ level: 'Low', reason: 'We can switch back to the old page if anything goes wrong.' }),
  recommendation: 'Yes.',
});
const card = (changes = {}) => ({ ...structuredClone(GOOD), ...changes });
const withField = (field, text) => card({ [field]: text });
const codes = (c) => checkCard(c).problems;

test('the good card passes and reports nothing', () => {
  const got = checkCard(GOOD);
  assert.equal(got.pass, true);
  assert.deepEqual(got.problems, []);
  assert.deepEqual(got.findings, []);
});

test('pass is true only when there are no problems, and every finding names a field and a plain message', () => {
  const got = checkCard(card({ decide: 'Can we run the DB migration at 21:00?', cost: '₹5' }));
  assert.equal(got.pass, false);
  assert.ok(got.problems.length >= 3);
  for (const f of got.findings) {
    assert.ok(f.code && f.field && f.message, JSON.stringify(f));
    assert.ok(got.problems.includes(f.code));
  }
});

test('every jargon term is flagged when used bare, in any letter case, with endings, in any founder-facing field', () => {
  for (const term of JARGON_TERMS) {
    for (const form of [term, term.toUpperCase(), `${term}s`]) {
      for (const field of ['decide', 'why_now', 'if_yes', 'if_no', 'recommendation']) {
        assert.ok(codes(withField(field, `We will use the ${form} today.`)).includes('jargon'), `${form} in ${field}`);
      }
      assert.ok(codes(card({ risk: { level: 'Low', reason: `The ${form} is safe.` } })).includes('jargon'), `${form} in risk.reason`);
    }
  }
});

test('a term followed by a real explanation in brackets passes, and a thin one does not', () => {
  for (const term of JARGON_TERMS) {
    const explained = withField('decide', `Can we use the ${term} (a way for two apps to talk to each other)?`);
    assert.equal(codes(explained).includes('jargon'), false, `${term} explained`);
    // Each rule is tested alone: a long single word has enough letters but too few words,
    // and three tiny words are enough words but too few letters.
    for (const thin of ['(tbd)', '(a thing)', '(it)', '()', '(a b)', '(infrastructure)', '(a b c)', '(see the docs)']) {
      assert.ok(codes(withField('decide', `Can we use the ${term} ${thin}?`)).includes('jargon'), `${term} ${thin}`);
    }
  }
});

test('the jargon list keeps the words the kickstart itself gives as the "before" example', () => {
  // The sweep above reads JARGON_TERMS, so deleting a term would delete its test too. These stay.
  const core = ['api', 'deploy', 'prod', 'db', 'migration', 'rollback', 'snapshot', 'sprint', 'webhook', 'endpoint', 'schema', 'merge', 'repo', 'server'];
  for (const term of core) assert.ok(JARGON_TERMS.includes(term), `${term} must stay in the jargon list`);
  assert.deepEqual(JARGON_TERMS, [...new Set(JARGON_TERMS)], 'no duplicates');
  for (const term of JARGON_TERMS) assert.equal(term, term.toLowerCase(), `${term} is lower-case`);
});

test('a technical word in the "details" field is allowed, and one in a founder-facing field is not', () => {
  assert.equal(checkCard(card({ details: 'Deploy v1.3 to prod via `npm run build`; DB migration; rollback via snapshot.' })).pass, true);
  assert.equal(checkCard(card({ if_no: 'The deploy waits.' })).pass, false);
});

test('ordinary plain writing is never flagged (no false alarms)', () => {
  const plain = [
    'Can we send the invoice for the new website to Client C?',
    'Ram Sharma asked us to wait until Monday.',
    'The video production for the launch is done and ready to send.',
    'Please select the invoice from the list and send it.',
    'We will email the client(s) and the team.',
    'We can pay in cash and/or by card.',
    'The shop is open 24/7 and the call is 1:1 with the owner.',
    'The report is dated 21.11.2026 and covers phase 2.',
    'Our sales pipeline shows 12 leads and our CRM shows 3 new proposals.',
    'The bug in the sign-up form is fixed and the key person is back.',
    'A 30-minute call with 50% off the first month, about 2.5 lakh in sales.',
    'The service branch office is closed on 1 December.',
    'We publish to the website and release the update to customers.',
    'Can we hire a freelancer for two weeks to finish the content?',
    'The release notes mention the new pricing page and the refund policy.',
  ];
  for (const text of plain) {
    for (const field of ['decide', 'why_now', 'if_yes', 'if_no', 'recommendation']) {
      assert.deepEqual(codes(withField(field, text)), [], `"${text}" in ${field}`);
    }
  }
});

test('code in founder-facing text is caught in every field, but not in details', () => {
  const snippets = [
    'We run `ls`.',
    'We run npm run build today.',
    'We run git push origin main today.',
    '$ npm install',
    'Use --force to continue.',
    'Add <div class="x"> to the page.',
    'It maps a => b.',
    'Call fetchUser(id, "x") first.',
    'The setting is { "mode": "fast" }.',
    'We delete from users where id = 4.',
    'We insert into orders values (1).',
    'We select name from clients to build the list.',
    'We run select * from users first.',
    'Open index.js and change it.',
    'Open /var/www/site/config now.',
    'The change is 4f9c2ab81d.',
  ];
  for (const text of snippets) {
    for (const field of ['decide', 'why_now', 'if_yes', 'if_no', 'recommendation']) {
      assert.ok(codes(withField(field, text)).includes('contains_code'), `"${text}" in ${field}`);
    }
    assert.equal(checkCard(card({ details: text })).pass, true, `"${text}" is fine in details`);
  }
});

test('clock times need IST, whatever the style', () => {
  const bad = ['21:00', '9:00 AM', '9 PM', '9 p.m.', '6:30 PM UTC', '8:15 pm PST'];
  for (const t of bad) assert.ok(codes(withField('if_yes', `The emails go out at ${t} tomorrow.`)).includes('time_format'), t);
  const good = ['9:00 AM IST', '21:00 IST', '9 PM IST', '6:30 pm ist', '9:00 AM (IST)'];
  for (const t of good) assert.equal(codes(withField('if_yes', `The emails go out at ${t} tomorrow.`)).includes('time_format'), false, t);
  for (const field of ['decide', 'why_now', 'if_yes', 'if_no', 'recommendation']) {
    assert.ok(codes(withField(field, 'It happens at 9:00 AM.')).includes('time_format'), field);
  }
});

test('cost needs a rupee amount and a dollar amount', () => {
  for (const cost of ['₹0 ($0)', '₹1,200 ($15)', '₹ 500 ($ 6)', '$15 (₹1,250)']) assert.equal(codes(card({ cost })).includes('cost_format'), false, cost);
  for (const cost of ['₹1,200', '$15', 'Free', '₹ and $', 'INR 1200 (USD 15)', '₹0']) assert.ok(codes(card({ cost })).includes('cost_format'), cost);
});

test('the risk level must be exactly Low, Medium or High', () => {
  for (const level of RISK_LEVELS) assert.equal(checkCard(card({ risk: { level, reason: 'Because.' } })).pass, true, level);
  for (const level of ['low', 'LOW', 'Severe', 'Low ', 'Critical']) {
    const got = codes(card({ risk: { level, reason: 'Because it is.' } }));
    assert.ok(got.includes('bad_risk_level'), `${JSON.stringify(level)} -> ${got}`);
  }
});

test('missing, blank, invisible and non-text fields are all "missing_field"', () => {
  for (const field of ['decide', 'why_now', 'if_yes', 'if_no', 'cost', 'recommendation']) {
    for (const bad of [undefined, null, '', '   ', '​​', ' \n\t', 5, {}, [], true, '...', '—']) {
      assert.ok(codes(withField(field, bad)).includes('missing_field'), `${field}=${JSON.stringify(bad)}`);
    }
  }
  for (const risk of [undefined, null, 'Low', [], 5, {}, { level: 'Low' }, { reason: 'x' }, { level: '', reason: 'x' }, { level: 'Low', reason: ' ' }]) {
    assert.ok(codes(card({ risk })).includes('missing_field'), JSON.stringify(risk));
  }
});

test('text with look-alike or invisible characters is checked as the founder will see it', () => {
  assert.ok(codes(withField('decide', 'Can we rotate the AP​I key?')).includes('jargon'));
  assert.ok(codes(withField('decide', 'Can we rotate the ＡＰＩ key?')).includes('jargon'), 'full-width letters');
  assert.ok(codes(withField('decide', 'Can we deploy­ment it?')).includes('jargon'), 'soft hyphen');
  assert.ok(codes(withField('if_yes', 'We run np​m run build.')).includes('contains_code'));
});

test('checkCard never throws, whatever it is given', () => {
  const hostileField = { ...GOOD, get decide() { throw new Error('boom'); } };
  const circular = { ...GOOD };
  circular.risk = circular;
  const inputs = [
    undefined, null, 0, 'x', true, [], [GOOD], () => {}, Symbol('s'), 10n, {}, hostileField, circular,
    new Proxy({}, { get() { throw new Error('boom'); } }),
    { ...GOOD, risk: { get level() { throw new Error('boom'); }, reason: 'x' } },
  ];
  for (const input of inputs) {
    let got;
    assert.doesNotThrow(() => { got = checkCard(input); });
    assert.equal(got.pass, false);
    assert.ok(got.problems.length >= 1);
  }
});

test('checkCard does not change the card it is given', () => {
  const frozen = JSON.parse(JSON.stringify(GOOD));
  Object.freeze(frozen.risk);
  Object.freeze(frozen);
  assert.doesNotThrow(() => checkCard(frozen));
});

// ---- the loop -----------------------------------------------------------------

const BAD = { ...GOOD, decide: 'Approve deploy of v1.3 to prod.' };
const scripted = (steps) => {
  const calls = [];
  return {
    calls,
    async write(input) {
      calls.push(input);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
  };
};

test('the loop refuses to run without a writer or with a bad limit', async () => {
  await assert.rejects(produceCard({ request: 'x' }), TypeError);
  await assert.rejects(produceCard({ request: 'x', write: 'nope' }), TypeError);
  for (const maxAttempts of [0, -1, 2.5, '3', NaN, Infinity, MAX_ATTEMPTS + 1, null]) {
    await assert.rejects(produceCard({ request: 'x', write: async () => GOOD, maxAttempts }), RangeError, String(maxAttempts));
  }
  assert.equal(DEFAULT_ATTEMPTS, 3);
});

test('the loop calls the writer at most maxAttempts times, for every allowed limit', async () => {
  for (let max = 1; max <= MAX_ATTEMPTS; max += 1) {
    const w = scripted([BAD]);
    const got = await produceCard({ request: 'x', write: w.write, maxAttempts: max });
    assert.equal(w.calls.length, max);
    assert.equal(got.status, 'flagged');
    assert.equal(got.attempts, max);
    assert.equal('card' in got, false);
  }
});

test('a writer that throws never leaks its message into the result', async () => {
  const w = scripted([new Error('secret-token-xyz sk-ant-abcdefghijklmnop')]);
  const got = await produceCard({ request: 'x', write: w.write });
  assert.equal(got.status, 'flagged');
  assert.deepEqual(got.problems, ['writer_error']);
  assert.equal(JSON.stringify(got).includes('secret-token-xyz'), false);
  assert.equal(JSON.stringify(w.calls).includes('secret-token-xyz'), false, 'nor into the feedback the next try receives');
});

test('the writer is told what is wrong, in plain sentences, and gets the failed draft back', async () => {
  const w = scripted([BAD, GOOD]);
  const got = await produceCard({ request: 'Deploy v1.3', write: w.write });
  assert.equal(got.status, 'ready');
  assert.equal(w.calls[0].previous, null);
  const { card: failed, findings } = w.calls[1].previous;
  assert.equal(failed.decide, BAD.decide);
  assert.ok(findings.length >= 1);
  assert.ok(findings.every((f) => typeof f.message === 'string' && f.message.length > 10));
  assert.ok(findings.some((f) => f.field === 'decide' && f.match));
});

test('a ready card is a clean copy: seven fields, cleaned text, nothing shared with the writer', async () => {
  const draft = { ...structuredClone(GOOD), decide: 'Can we make it live?​', approved: true, risk: { level: 'Low', reason: 'We can switch back.', extra: 1 } };
  const got = await produceCard({ request: 'x', write: async () => draft });
  assert.equal(got.status, 'ready');
  assert.deepEqual(Object.keys(got.card).sort(), ['cost', 'decide', 'if_no', 'if_yes', 'recommendation', 'risk', 'why_now']);
  assert.deepEqual(Object.keys(got.card.risk).sort(), ['level', 'reason']);
  assert.equal(got.card.decide, 'Can we make it live?');
  draft.decide = 'changed after the fact';
  assert.equal(got.card.decide, 'Can we make it live?');
  assert.equal(checkCard(got.card).pass, true, 'what is stored passes the checker again');
});

test('a draft that changes between reads is shown exactly as it was checked', async () => {
  let reads = 0;
  const tricky = {
    ...structuredClone(GOOD),
    get decide() {
      reads += 1;
      return reads === 1 ? 'Can we make it live?' : 'Approve deploy of v1.3 to prod.';
    },
  };
  const got = await produceCard({ request: 'x', write: async () => tricky, maxAttempts: 1 });
  assert.equal(got.status, 'ready');
  assert.equal(got.card.decide, 'Can we make it live?');
  assert.equal(checkCard(got.card).pass, true);
});

test('a writer that returns nothing usable is a failed try, not a crash', async () => {
  for (const bad of [undefined, null, 'a card', 5, [], () => {}]) {
    const got = await produceCard({ request: 'x', write: async () => bad, maxAttempts: 2 });
    assert.equal(got.status, 'flagged');
    assert.ok(got.problems.includes('missing_field'));
  }
  // An object that throws when read: awaiting it already fails, so it counts as a writer error.
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  const got = await produceCard({ request: 'x', write: async () => hostile, maxAttempts: 2 });
  assert.equal(got.status, 'flagged');
  assert.deepEqual(got.problems, ['writer_error']);
  // The same object returned synchronously is read by the snapshot and refused as an empty card.
  const sync = await produceCard({ request: 'x', write: () => hostile, maxAttempts: 2 });
  assert.equal(sync.status, 'flagged');
  assert.ok(sync.problems.length >= 1);
});

test('a synchronous writer works too', async () => {
  const got = await produceCard({ request: 'x', write: () => GOOD });
  assert.equal(got.status, 'ready');
  assert.equal(got.attempts, 1);
});

test('the rejected draft in a flagged result is a snapshot, not a live object', async () => {
  const draft = structuredClone(BAD);
  const got = await produceCard({ request: 'x', write: async () => draft, maxAttempts: 1 });
  draft.decide = 'changed';
  assert.equal(got.rejectedDraft.decide, BAD.decide);
});

// ---- the writer's rules ---------------------------------------------------------

test('the writer instructions name every field, every risk level and every jargon term', () => {
  const text = writerInstructions();
  for (const f of ['decide', 'why_now', 'if_yes', 'if_no', 'cost', 'risk', 'recommendation', 'details']) assert.ok(text.includes(f), f);
  for (const level of RISK_LEVELS) assert.ok(text.includes(level), level);
  for (const term of JARGON_TERMS) assert.ok(text.includes(term), term);
  assert.ok(text.includes('IST') && text.includes('₹') && text.includes('$'));
});

test('the writer instructions teach the exact wording for an unknown price, and that wording passes', () => {
  const text = writerInstructions();
  assert.ok(text.includes('Price not known yet'), 'the wording is not taught');
  assert.match(text, /never guess/i);
  assert.match(text, /Medium or High/);
  // The very words the instructions teach must be accepted, and with a Medium risk.
  const taught = card({ cost: 'Price not known yet', risk: { level: 'Medium', reason: 'Money is spent and the price is not known.' } });
  assert.equal(checkCard(taught).pass, true);
});

test('an unknown price with Low risk is told to use Medium or High', () => {
  const result = checkCard(card({ cost: 'Price not known yet', risk: { level: 'Low', reason: 'It is small.' } }));
  assert.equal(result.pass, false);
  assert.deepEqual(result.problems, ['unknown_cost_low_risk']);
  assert.match(result.findings[0].message, /Medium or High/);
});

test('the example card in the writer instructions passes the checker', () => {
  assert.equal(checkCard(card()).pass, true);
  assert.ok(writerInstructions().includes('The new login page for Client A is ready.'));
});
