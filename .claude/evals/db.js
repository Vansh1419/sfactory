'use strict';

// Test database for the schema evals (PLAN.md step 1.1). A real Postgres (PGlite,
// in-process, no credentials) dressed up like Supabase:
//   - the roles anon, authenticated and service_role (the last one bypasses RLS),
//   - auth.jwt(), which reads the request's JWT claims the way Supabase does,
//   - Supabase's default privileges, which grant everything on new tables to the API
//     roles. The migrations must lock that down; the evals check that they do,
//   - pgvector in the `extensions` schema.
// Migrations are applied exactly as written in supabase/migrations/*.sql.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, PendingError } = require('./lib');

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const SEED_FILE = path.join(ROOT, 'supabase', 'seed.sql');
const EMBEDDING_DIMENSIONS = 768;

const SUPABASE_STUB = `
create schema if not exists extensions;
create schema if not exists auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema public, extensions, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IDS = {
  clientA: uuid(11), clientB: uuid(12),
  projectA: uuid(21), projectB: uuid(22),
  podA: uuid(31), podB: uuid(32),
  agentA: uuid(41), agentB: uuid(42), agentShared: uuid(43),
  taskA: uuid(51), taskB: uuid(52), taskCompany: uuid(53),
  decPendingA: uuid(61), decPendingB: uuid(62), decApprovedA: uuid(63),
  memA: uuid(71), memB: uuid(72), memCompany: uuid(73),
};

/** A unit vector with a 1 at position i, as pgvector text. */
const vec = (i) => `[${Array.from({ length: EMBEDDING_DIMENSIONS }, (_, k) => (k === i ? 1 : 0)).join(',')}]`;

/** A plain-language card with all 7 fields (see the decision-cards eval). */
const CARD = JSON.stringify({
  decide: 'Can we make the new page live?',
  why_now: 'The client asked for it this week.',
  if_yes: 'It goes live tonight.',
  if_no: 'It waits.',
  cost: '₹0 ($0)',
  risk: { level: 'Low', reason: 'We can switch back.' },
  recommendation: 'Yes.',
});
const ACTION = JSON.stringify({ tool: 'vercel.deploy', access: 'write', args: { target: 'production' } });

// Two pods with rows in every pod-scoped table, plus company-level rows (no pod).
const FIXTURE = `
insert into clients (id, name) values ('${IDS.clientA}', 'Client A'), ('${IDS.clientB}', 'Client B');
insert into projects (id, client_id, name, kind) values
  ('${IDS.projectA}', '${IDS.clientA}', 'Project A', 'agency_client'),
  ('${IDS.projectB}', '${IDS.clientB}', 'Project B', 'agency_client');
insert into pods (id, project_id, template) values
  ('${IDS.podA}', '${IDS.projectA}', 'agency_client'),
  ('${IDS.podB}', '${IDS.projectB}', 'agency_client');
insert into agents (id, name, team, role, is_shared) values
  ('${IDS.agentA}', 'Worker A', 'product_engineering', 'worker', false),
  ('${IDS.agentB}', 'Worker B', 'product_engineering', 'worker', false),
  ('${IDS.agentShared}', 'Shared specialist', 'marketing_sales', 'specialist', true);
insert into pod_members (pod_id, agent_id) values
  ('${IDS.podA}', '${IDS.agentA}'), ('${IDS.podB}', '${IDS.agentB}'),
  ('${IDS.podA}', '${IDS.agentShared}'), ('${IDS.podB}', '${IDS.agentShared}');
insert into tasks (id, pod_id, team, title) values
  ('${IDS.taskA}', '${IDS.podA}', 'product_engineering', 'Task A'),
  ('${IDS.taskB}', '${IDS.podB}', 'product_engineering', 'Task B'),
  ('${IDS.taskCompany}', null, 'orchestrator', 'Company task');
insert into decisions (id, pod_id, category, action, card, status) values
  ('${IDS.decPendingA}', '${IDS.podA}', 'launch_or_pricing', '${ACTION}', '${CARD}', 'pending'),
  ('${IDS.decPendingB}', '${IDS.podB}', 'launch_or_pricing', '${ACTION}', '${CARD}', 'pending');
insert into decisions (id, pod_id, category, action, card, status, resolved_at, resolved_via) values
  ('${IDS.decApprovedA}', '${IDS.podA}', 'launch_or_pricing', '${ACTION}', '${CARD}', 'approved', now(), 'dashboard');
insert into memory (id, pod_id, kind, content, embedding) values
  ('${IDS.memA}', '${IDS.podA}', 'fact', 'A fact', '${vec(0)}'),
  ('${IDS.memB}', '${IDS.podB}', 'fact', 'B fact', '${vec(1)}'),
  ('${IDS.memCompany}', null, 'fact', 'Company fact', '${vec(2)}');
insert into agent_events (pod_id, agent_id, kind, summary) values
  ('${IDS.podA}', '${IDS.agentA}', 'tool_used', 'A step'),
  ('${IDS.podB}', '${IDS.agentB}', 'tool_used', 'B step');
insert into audit_log (actor_type, pod_id, action) values
  ('system', '${IDS.podA}', 'fixture'), ('system', '${IDS.podB}', 'fixture'), ('system', null, 'fixture');
insert into scaling_rules (scope, max_agents) values ('global', 10);
`;

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** A database dressed like a fresh Supabase project: the roles, auth.jwt() and pgvector, but no tables. */
async function createEmptyDatabase() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const db = new PGlite({ extensions: { vector } });
  await db.exec(SUPABASE_STUB);
  return db;
}

/** Fresh database with the migrations applied. Pending until the migrations exist. */
async function build({ fixture = false, seed = false } = {}) {
  const files = migrationFiles();
  if (files.length === 0) throw new PendingError('not implemented yet: supabase/migrations/*.sql');
  const db = await createEmptyDatabase();
  for (const f of files) await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  if (fixture) await db.exec(FIXTURE);
  if (seed) await applySeed(db);
  return db;
}

/** Apply supabase/seed.sql. Pending until the seed exists. */
async function applySeed(db) {
  if (!fs.existsSync(SEED_FILE)) throw new PendingError('not implemented yet: supabase/seed.sql');
  await db.exec(fs.readFileSync(SEED_FILE, 'utf8'));
}

let shared;
/** One database with the two-pod fixture, shared by every case (each case rolls back). */
const getEnv = () => (shared ??= build({ fixture: true }));

/** Who is asking. Pod agents are `authenticated` with a pod_id claim, like a pod-scoped JWT. */
const who = {
  service: { role: 'service_role' },
  anon: { role: 'anon' },
  owner: { role: null },
  noPod: { role: 'authenticated', claims: {} },
  pod: (podId) => ({ role: 'authenticated', claims: { pod_id: podId } }),
};

/** Run `fn(tx)` as `actor` inside a transaction that is always rolled back. */
async function withRole(db, actor, fn) {
  let out;
  await db.transaction(async (tx) => {
    if (actor.role) await tx.query(`set local role ${actor.role}`);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [actor.claims ? JSON.stringify(actor.claims) : '']);
    out = await fn(tx);
    await tx.rollback();
  });
  return out;
}

/** Run one statement without poisoning the transaction if it fails. */
async function attempt(tx, sql, params) {
  await tx.query('savepoint attempt');
  try {
    const r = await tx.query(sql, params);
    await tx.query('release savepoint attempt');
    return { ok: true, rows: r.rows, count: r.affectedRows ?? r.rows.length };
  } catch (err) {
    await tx.query('rollback to savepoint attempt');
    return { ok: false, error: err.message, count: 0 };
  }
}

module.exports = { IDS, CARD, ACTION, EMBEDDING_DIMENSIONS, vec, build, createEmptyDatabase, applySeed, getEnv, who, withRole, attempt };
