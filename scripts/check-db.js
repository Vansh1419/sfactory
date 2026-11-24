#!/usr/bin/env node
'use strict';

// PLAN.md step 1.1: after you apply supabase/migrations to your real Supabase project,
// this checks that all 14 core tables exist and answer to the service key.
// Read-only: one GET per table, no writes. Never prints a secret.
//
//   npm run check:db
//
// Right after applying, the API can take a few seconds to notice new tables.
// If tables show as missing, wait a moment and run it again.

const fs = require('node:fs');
const path = require('node:path');
const { redact, supabaseUrlAllowed } = require('./check-keys');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = 8000;
const TABLES = [
  'clients', 'projects', 'pods', 'agents', 'pod_members', 'tasks',
  'decisions', 'audit_log', 'memory', 'agent_events', 'scaling_rules', 'policy_tools',
  'graph_checkpoints', 'graph_writes',
];

async function checkTable(env, table, fetchImpl = fetch) {
  const url = env.SUPABASE_URL.replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  let res;
  try {
    res = await fetchImpl(`${url}/rest/v1/${table}?select=*&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { table, status: 'fail', detail: `could not reach Supabase (${redact(err.cause?.code || err.message, [key])})` };
  }
  if (res.ok) return { table, status: 'ok', detail: 'exists' };
  if (res.status === 404) return { table, status: 'missing', detail: 'not found: apply the migrations (or wait a few seconds and retry)' };
  if (res.status === 401 || res.status === 403) return { table, status: 'fail', detail: `the service key was rejected (${res.status})` };
  return { table, status: 'fail', detail: `Supabase answered ${res.status}` };
}

async function checkAll(env, fetchImpl = fetch) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return [{ table: '(settings)', status: 'fail', detail: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env' }];
  }
  if (!supabaseUrlAllowed(env.SUPABASE_URL)) {
    return [{ table: '(settings)', status: 'fail', detail: 'SUPABASE_URL must look like https://<project>.supabase.co; the key was NOT sent anywhere' }];
  }
  const results = [];
  for (const t of TABLES) results.push(await checkTable(env, t, fetchImpl));
  return results;
}

async function main() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) {
    console.log('No .env yet. See PLAN.md step 0.1.');
    return 1;
  }
  process.loadEnvFile(file);
  const results = await checkAll(process.env);
  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(7)} ${r.table.padEnd(14)} ${r.detail}`);
  const bad = results.filter((r) => r.status !== 'ok');
  console.log(bad.length ? `\n${bad.length} of ${results.length} need attention.` : `\nAll ${results.length} core tables exist. Step 1.1 is applied.`);
  return bad.length ? 1 : 0;
}

if (require.main === module) main().then((code) => process.exit(code));

module.exports = { TABLES, checkTable, checkAll };
