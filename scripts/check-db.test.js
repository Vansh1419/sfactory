'use strict';

// Tests for scripts/check-db.js with a fake fetch: no network, no real key.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./check-db');

const ENV = { SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'SERVICEKEY123' };
const reply = (status) => async () => ({ ok: status >= 200 && status < 300, status });
const neverCalled = async () => {
  throw new Error('fetch must not be called');
};

test('lists the 15 core tables from the plan', () => {
  assert.deepEqual(
    [...db.TABLES].sort(),
    ['agent_events', 'agents', 'audit_log', 'clients', 'decisions', 'graph_checkpoints', 'graph_writes', 'memory', 'outbound_messages', 'pod_members', 'pods', 'policy_tools', 'projects', 'scaling_rules', 'tasks'],
  );
});

test('an existing table is ok, a 404 is missing, a rejected key is a failure', async () => {
  assert.equal((await db.checkTable(ENV, 'pods', reply(200))).status, 'ok');
  assert.equal((await db.checkTable(ENV, 'pods', reply(404))).status, 'missing');
  assert.equal((await db.checkTable(ENV, 'pods', reply(401))).status, 'fail');
  assert.equal((await db.checkTable(ENV, 'pods', reply(500))).status, 'fail');
});

test('the request goes to the right table with the key in headers, never in the URL', async () => {
  let seen;
  await db.checkTable(ENV, 'decisions', async (url, options) => {
    seen = { url, headers: options.headers };
    return { ok: true, status: 200 };
  });
  assert.match(seen.url, /^https:\/\/abcd\.supabase\.co\/rest\/v1\/decisions\?/);
  assert.doesNotMatch(seen.url, /SERVICEKEY123/);
  assert.equal(seen.headers.apikey, 'SERVICEKEY123');
});

test('a network error never leaks the key', async () => {
  const r = await db.checkTable(ENV, 'pods', async () => {
    throw new Error('failed for SERVICEKEY123');
  });
  assert.equal(r.status, 'fail');
  assert.doesNotMatch(r.detail, /SERVICEKEY123/);
});

test('missing settings and non-Supabase URLs are refused without any network call', async () => {
  assert.equal((await db.checkAll({}, neverCalled))[0].status, 'fail');
  const evil = await db.checkAll({ SUPABASE_URL: 'https://evil.example.com', SUPABASE_SERVICE_ROLE_KEY: 'x' }, neverCalled);
  assert.equal(evil.length, 1);
  assert.match(evil[0].detail, /NOT sent/);
});

test('checkAll checks every table', async () => {
  const results = await db.checkAll(ENV, reply(200));
  assert.equal(results.length, 15);
  assert.ok(results.every((r) => r.status === 'ok'));
});
