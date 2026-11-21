'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSuite, exitCode, PendingError } = require('./lib');

const suiteOf = (cases, run, extra = {}) => ({ name: 't', cases: () => cases, run, ...extra });

test('all cases passing gives a passing suite', async () => {
  const r = await runSuite(suiteOf([{ id: 'a' }, { id: 'b' }], () => ({ pass: true })));
  assert.equal(r.status, 'pass');
  assert.equal(r.score, 1);
});

test('one failing case fails a suite with the default threshold of 1', async () => {
  const r = await runSuite(suiteOf([{ id: 'a' }, { id: 'b' }], (c) => ({ pass: c.id === 'a' })));
  assert.equal(r.status, 'fail');
  assert.equal(r.score, 0.5);
});

test('a lower threshold allows some failures', async () => {
  const r = await runSuite(
    suiteOf([{ id: 'a' }, { id: 'b' }], (c) => ({ pass: c.id === 'a' }), { threshold: 0.5 }),
  );
  assert.equal(r.status, 'pass');
});

test('PendingError marks cases pending, not failed', async () => {
  const r = await runSuite(
    suiteOf([{ id: 'a' }], () => {
      throw new PendingError('not yet');
    }),
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.counts.fail, 0);
});

test('any other thrown error is a failure', async () => {
  const r = await runSuite(
    suiteOf([{ id: 'a' }], () => {
      throw new Error('boom');
    }),
  );
  assert.equal(r.status, 'fail');
  assert.match(r.results[0].detail, /boom/);
});

test('a suite with no cases fails instead of passing vacuously', async () => {
  const r = await runSuite(suiteOf([], () => ({ pass: true })));
  assert.equal(r.status, 'fail');
});

test('duplicate case ids are rejected', async () => {
  await assert.rejects(runSuite(suiteOf([{ id: 'a' }, { id: 'a' }], () => ({ pass: true }))), /duplicate case id/);
});

test('exit code: pending only fails under --strict', () => {
  const reports = [{ status: 'pass' }, { status: 'pending' }];
  assert.equal(exitCode(reports), 0);
  assert.equal(exitCode(reports, { strict: true }), 1);
  assert.equal(exitCode([{ status: 'fail' }]), 1);
});
