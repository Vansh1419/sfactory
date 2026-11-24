'use strict';

// Grades supabase/migrations/*.sql and supabase/seed.sql (PLAN.md step 1.1) by
// applying them to a real Postgres (see ../db.js) and attacking the result.
// There are no migrations yet, so every case reports "pending" until they exist.
//
// Contract the migrations must satisfy (the fixture in ../db.js inserts with these columns):
//   clients(id, name)                         projects(id, client_id, name, kind)
//   pods(id, project_id, template)            agents(id, name, team, role, is_shared)
//   pod_members(pod_id, agent_id)             tasks(id, pod_id, team, title)
//   decisions(id, pod_id, category, action, card, status, resolved_at, resolved_via, reminder_count)
//   memory(id, pod_id, kind, content, embedding vector(768))
//   agent_events(pod_id, agent_id, kind, summary)
//   audit_log(actor_type, pod_id, action)     scaling_rules(scope, max_agents)
//   policy_tools(id, tool, kind, category, access, status, proposed_via, confirmed_via, activated_at, removed_at)
//     the tools the founder added to the policy check from Telegram (step 1.6 follow-up): kind 'ask'
//     (always needs the founder, with a category) or 'routine' (allowed without asking, with a read or
//     write tag); status proposed, active or removed; service-role only, never visible to a pod
//   pod_id is NULL for company-level rows. Pod agents authenticate as role `authenticated`
//   with a `pod_id` JWT claim; the runtime uses `service_role`, which bypasses RLS.

const { IDS, EMBEDDING_DIMENSIONS, vec, build, applySeed, getEnv, who, withRole, attempt, CARD, ACTION } = require('../db');

const TABLES = [
  'tasks', 'agents', 'decisions', 'audit_log', 'memory', 'clients', 'projects',
  'agent_events', 'pods', 'pod_members', 'scaling_rules', 'policy_tools', 'graph_checkpoints', 'graph_writes',
];
const POD_ROWS = ['tasks', 'decisions', 'memory', 'agent_events', 'audit_log', 'pod_members'];

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const ids = (rows, col = 'id') => rows.map((r) => r[col]).sort();
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const decisionSql = (extraCols = '', extraVals = '') =>
  `insert into decisions (pod_id, category, action, card, status${extraCols}) values ($1, 'spend', $2, $3, $4${extraVals})`;

const cases = [
  {
    id: 'migrations-apply-cleanly-to-an-empty-database',
    standalone: true,
    async check() {
      await build();
      return verdict(true);
    },
  },
  {
    id: 'all-twelve-core-tables-exist',
    async check(db) {
      const r = await db.query("select table_name from information_schema.tables where table_schema = 'public'");
      const have = ids(r.rows, 'table_name');
      const missing = TABLES.filter((t) => !have.includes(t));
      return verdict(missing.length === 0, `missing tables: ${missing.join(', ')}`);
    },
  },
  {
    id: 'row-level-security-is-on-for-every-public-table',
    async check(db) {
      const r = await db.query(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      );
      return verdict(r.rows.length === 0, `RLS off on: ${ids(r.rows, 'relname').join(', ')}`);
    },
  },
  {
    id: 'anon-role-has-no-access-to-any-table',
    async check(db) {
      const bad = [];
      for (const t of TABLES) {
        for (const p of ['select', 'insert', 'update', 'delete']) {
          const r = await db.query('select has_table_privilege($1, $2, $3) as yes', ['anon', `public.${t}`, p]);
          if (r.rows[0].yes) bad.push(`${t}:${p}`);
        }
      }
      return verdict(bad.length === 0, `anon can: ${bad.join(', ')}`);
    },
  },
  {
    id: 'memory-embeddings-are-pgvector-and-searchable',
    async check(db) {
      const col = await db.query(
        "select udt_name from information_schema.columns where table_name = 'memory' and column_name = 'embedding'",
      );
      if (col.rows[0]?.udt_name !== 'vector') return verdict(false, `embedding column type is ${col.rows[0]?.udt_name}`);
      const dims = await db.query(
        "select atttypmod as d from pg_attribute where attrelid = 'public.memory'::regclass and attname = 'embedding'",
      );
      if (dims.rows[0].d !== EMBEDDING_DIMENSIONS) return verdict(false, `dimensions are ${dims.rows[0].d}, expected ${EMBEDDING_DIMENSIONS}`);
      const near = await withRole(db, who.service, (tx) =>
        tx.query(`select id from memory where pod_id is not null order by embedding operator(extensions.<=>) '${vec(1)}' limit 1`),
      );
      return verdict(near.rows[0]?.id === IDS.memB, `nearest to vec(1) was ${near.rows[0]?.id}`);
    },
  },
  {
    id: 'a-pod-reads-only-its-own-rows',
    async check(db) {
      const problems = [];
      await withRole(db, who.pod(IDS.podA), async (tx) => {
        for (const t of POD_ROWS) {
          const r = await tx.query(`select pod_id from ${t}`);
          if (r.rows.length === 0) problems.push(`${t}: sees nothing of its own (control failed)`);
          const foreign = r.rows.filter((x) => x.pod_id !== IDS.podA);
          if (foreign.length) problems.push(`${t}: ${foreign.length} foreign or company-level rows visible`);
        }
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-pod-sees-only-its-own-pod-and-project',
    async check(db) {
      const out = await withRole(db, who.pod(IDS.podA), async (tx) => ({
        pods: ids((await tx.query('select id from pods')).rows),
        projects: ids((await tx.query('select id from projects')).rows),
      }));
      return verdict(same(out.pods, [IDS.podA]) && same(out.projects, [IDS.projectA]), `got ${JSON.stringify(out)}`);
    },
  },
  {
    id: 'a-pod-sees-only-the-clients-of-its-own-project',
    async check(db) {
      const rows = await withRole(db, who.pod(IDS.podA), async (tx) => ids((await tx.query('select id from clients')).rows));
      return verdict(same(rows, [IDS.clientA]), `got ${JSON.stringify(rows)}`);
    },
  },
  {
    id: 'a-pod-sees-its-members-and-shared-specialists-only',
    async check(db) {
      const rows = await withRole(db, who.pod(IDS.podA), async (tx) => ids((await tx.query('select id from agents')).rows));
      return verdict(same(rows, [IDS.agentA, IDS.agentShared]), `got ${JSON.stringify(rows)}`);
    },
  },
  {
    id: 'no-pod-claim-means-no-rows-anywhere',
    async check(db) {
      const leaks = [];
      await withRole(db, who.noPod, async (tx) => {
        for (const t of TABLES) {
          const r = await attempt(tx, `select 1 from ${t}`);
          if (r.ok && r.rows.length > 0) leaks.push(t);
        }
      });
      return verdict(leaks.length === 0, `visible without a pod claim: ${leaks.join(', ')}`);
    },
  },
  {
    id: 'a-pod-cannot-write-into-another-pod',
    async check(db) {
      const problems = [];
      await withRole(db, who.pod(IDS.podA), async (tx) => {
        const own = await attempt(tx, "insert into tasks (pod_id, team, title) values ($1, 'product_engineering', 'ok')", [IDS.podA]);
        if (!own.ok) problems.push(`control failed: cannot insert into own pod (${own.error})`);
        const foreign = [
          ["insert into tasks (pod_id, team, title) values ($1, 'product_engineering', 'x')", 'tasks'],
          ["insert into agent_events (pod_id, kind, summary) values ($1, 'message', 'x')", 'agent_events'],
          ["insert into memory (pod_id, kind, content) values ($1, 'fact', 'x')", 'memory'],
        ];
        for (const [sql, t] of foreign) {
          if ((await attempt(tx, sql, [IDS.podB])).ok) problems.push(`${t}: inserted into pod B`);
        }
        const move = await attempt(tx, 'update tasks set pod_id = $1 where id = $2', [IDS.podB, IDS.taskA]);
        if (move.ok && move.count > 0) problems.push('moved a task into pod B');
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-pod-agent-cannot-approve-its-own-request',
    async check(db) {
      const problems = [];
      await withRole(db, who.pod(IDS.podA), async (tx) => {
        const control = await attempt(tx, decisionSql(), [IDS.podA, ACTION, CARD, 'pending']);
        if (!control.ok) problems.push(`control failed: cannot file a pending request (${control.error})`);
        const preApproved = await attempt(tx, decisionSql(', resolved_at, resolved_via', ', now(), $5'), [IDS.podA, ACTION, CARD, 'approved', 'dashboard']);
        if (preApproved.ok) problems.push('filed a request that is already approved');
        // A complete forgery: status plus the resolver fields, so a database constraint cannot be what stops it.
        const flip = await attempt(tx, "update decisions set status = 'approved', resolved_at = now(), resolved_via = 'dashboard' where id = $1", [IDS.decPendingA]);
        if (flip.ok && flip.count > 0) problems.push('approved a pending request');
        await tx.query('reset role');
        const after = await tx.query('select status from decisions where id = $1', [IDS.decPendingA]);
        if (after.rows[0].status !== 'pending') problems.push(`request is now ${after.rows[0].status}`);
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-pod-cannot-touch-scaling-rules-or-edit-the-audit-log',
    async check(db) {
      const problems = [];
      await withRole(db, who.pod(IDS.podA), async (tx) => {
        const rules = await attempt(tx, 'select * from scaling_rules');
        if (rules.ok && rules.rows.length > 0) problems.push('reads scaling_rules');
        if ((await attempt(tx, "insert into audit_log (actor_type, pod_id, action) values ('agent', $1, 'forged')", [IDS.podA])).ok) problems.push('wrote to audit_log');
        const upd = await attempt(tx, "update audit_log set action = 'edited'");
        if (upd.ok && upd.count > 0) problems.push('edited audit_log');
        const del = await attempt(tx, 'delete from audit_log');
        if (del.ok && del.count > 0) problems.push('deleted from audit_log');
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-pod-cannot-delete-its-rows',
    async check(db) {
      const problems = [];
      await withRole(db, who.pod(IDS.podA), async (tx) => {
        for (const t of ['tasks', 'decisions', 'memory', 'agent_events']) {
          const r = await attempt(tx, `delete from ${t}`);
          if (r.ok && r.count > 0) problems.push(`deleted ${r.count} from ${t}`);
        }
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'the-runtime-service-role-sees-everything',
    async check(db) {
      const r = await withRole(db, who.service, (tx) => tx.query('select count(*)::int as n from tasks'));
      return verdict(r.rows[0].n === 3, `service_role sees ${r.rows[0].n} tasks, expected 3 (two pods plus one company-level)`);
    },
  },
  {
    id: 'the-audit-log-is-append-only-even-for-the-owner',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const ins = await attempt(tx, "insert into audit_log (actor_type, action) values ('system', 'control')");
        if (!ins.ok) problems.push(`control failed: owner cannot append (${ins.error})`);
        if ((await attempt(tx, "update audit_log set action = 'edited'")).ok) problems.push('update allowed');
        if ((await attempt(tx, 'delete from audit_log')).ok) problems.push('delete allowed');
        if ((await attempt(tx, 'truncate audit_log')).ok) problems.push('truncate allowed');
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-resolved-decision-is-frozen',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const control = await attempt(tx, 'update decisions set reminder_count = reminder_count + 1 where id = $1', [IDS.decPendingA]);
        if (!control.ok) problems.push(`control failed: cannot update a pending decision (${control.error})`);
        if ((await attempt(tx, "update decisions set status = 'rejected' where id = $1", [IDS.decApprovedA])).ok) problems.push('flipped approved to rejected');
        if ((await attempt(tx, "update decisions set resolution_note = 'changed' where id = $1", [IDS.decApprovedA])).ok) problems.push('edited a resolved decision');
        if ((await attempt(tx, 'delete from decisions where id = $1', [IDS.decApprovedA])).ok) problems.push('deleted a resolved decision');
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'the-content-of-a-decision-cannot-change-after-it-is-filed',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const edits = [
          ['card', `update decisions set card = '{"decide":"changed"}'::jsonb where id = $1`],
          ['action', `update decisions set action = '{"tool":"other"}'::jsonb where id = $1`],
          ['category', `update decisions set category = 'unknown' where id = $1`],
          ['pod_id', `update decisions set pod_id = '${IDS.podB}' where id = $1`],
        ];
        for (const [col, sql] of edits) {
          if ((await attempt(tx, sql, [IDS.decPendingA])).ok) problems.push(`${col} was editable`);
        }
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'an-approved-or-rejected-decision-needs-a-resolver-and-a-time',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        if ((await attempt(tx, decisionSql(), [IDS.podA, ACTION, CARD, 'approved'])).ok) problems.push('approved without resolved_at and resolved_via');
        const ok = await attempt(tx, decisionSql(', resolved_at, resolved_via', ', now(), $5'), [IDS.podA, ACTION, CARD, 'approved', 'telegram']);
        if (!ok.ok) problems.push(`control failed: ${ok.error}`);
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-decision-card-must-have-all-seven-fields',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        if ((await attempt(tx, decisionSql(), [IDS.podA, ACTION, '{"decide":"only one field"}', 'pending'])).ok) problems.push('accepted a card with one field');
        const noRisk = JSON.stringify({ ...JSON.parse(CARD), risk: undefined });
        if ((await attempt(tx, decisionSql(), [IDS.podA, ACTION, noRisk, 'pending'])).ok) problems.push('accepted a card without risk');
        const ok = await attempt(tx, decisionSql(), [IDS.podA, ACTION, CARD, 'pending']);
        if (!ok.ok) problems.push(`control failed: ${ok.error}`);
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-pod-cannot-read-or-write-the-policy-table',
    async check(db) {
      const problems = [];
      const control = await withRole(db, who.service, (tx) => tx.query('select count(*)::int as n from policy_tools'));
      if (control.rows[0].n !== 2) problems.push(`control failed: the runtime sees ${control.rows[0].n} policy rows, expected 2`);
      for (const [name, actor] of [['pod', who.pod(IDS.podA)], ['no pod claim', who.noPod], ['anon', who.anon]]) {
        await withRole(db, actor, async (tx) => {
          const read = await attempt(tx, 'select * from policy_tools');
          if (read.ok && read.rows.length > 0) problems.push(`${name} reads the policy table`);
          const add = await attempt(tx, "insert into policy_tools (tool, kind, access, proposed_via) values ('evil.pay', 'routine', 'write', 'telegram')");
          if (add.ok) problems.push(`${name} added a routine tool`);
          const edit = await attempt(tx, "update policy_tools set status = 'active', confirmed_via = 'telegram', activated_at = now()");
          if (edit.ok && edit.count > 0) problems.push(`${name} activated a rule`);
        });
      }
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-pod-cannot-read-or-write-the-graph-checkpoint-tables',
    async check(db) {
      const problems = [];
      const row = "insert into graph_checkpoints (thread_id, checkpoint_id, checkpoint, metadata) values ('t', 'c1', 'e30=', 'e30=')";
      const write = "insert into graph_writes (thread_id, checkpoint_id, task_id, idx, channel, value) values ('t', 'c1', 'task', 0, 'x', 'e30=')";
      await withRole(db, who.service, async (tx) => {
        const control = [await attempt(tx, row), await attempt(tx, write)];
        if (!control.every((r) => r.ok)) problems.push('control failed: the runtime cannot write a checkpoint and a write');
        const seen = await attempt(tx, 'select (select count(*) from graph_checkpoints) as a, (select count(*) from graph_writes) as b');
        if (!seen.ok || Number(seen.rows[0].a) !== 1 || Number(seen.rows[0].b) !== 1) problems.push('control failed: the runtime cannot read them back');
      });
      for (const [name, actor] of [['pod', who.pod(IDS.podA)], ['no pod claim', who.noPod], ['anon', who.anon]]) {
        await withRole(db, actor, async (tx) => {
          for (const table of ['graph_checkpoints', 'graph_writes']) {
            const read = await attempt(tx, `select * from ${table}`);
            if (read.ok && read.rows.length > 0) problems.push(`${name} reads ${table}`);
          }
          if ((await attempt(tx, row)).ok) problems.push(`${name} wrote a checkpoint`);
          if ((await attempt(tx, write)).ok) problems.push(`${name} wrote a pending write`);
        });
      }
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-policy-rule-cannot-be-rewritten-or-deleted-and-removal-is-final',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const control = await attempt(tx, "update policy_tools set status = 'active', confirmed_via = 'dashboard', activated_at = now() where id = $1", [IDS.policyToolProposed]);
        if (!control.ok || control.count !== 1) problems.push(`control failed: a proposed rule cannot be activated (${control.error})`);
        // The active "ask" rule: every field that defines the rule is fixed once it exists.
        const edits = [
          ['tool', "update policy_tools set tool = 'other.tool' where id = $1"],
          ['kind', "update policy_tools set kind = 'routine', category = null, access = 'write' where id = $1"],
          ['category', "update policy_tools set category = 'legal_or_public' where id = $1"],
        ];
        for (const [col, sql] of edits) {
          if ((await attempt(tx, sql, [IDS.policyToolActive])).ok) problems.push(`${col} was editable`);
        }
        // The routine rule (activated above): its read tag cannot be widened to write afterwards.
        if ((await attempt(tx, "update policy_tools set access = 'write' where id = $1", [IDS.policyToolProposed])).ok) problems.push('the access tag of a routine rule was editable');
        if ((await attempt(tx, 'delete from policy_tools where id = $1', [IDS.policyToolActive])).ok) problems.push('a rule was deleted');
        const removed = await attempt(tx, "update policy_tools set status = 'removed', removed_at = now() where id = $1", [IDS.policyToolActive]);
        if (!removed.ok) problems.push(`control failed: an active rule cannot be removed (${removed.error})`);
        if ((await attempt(tx, "update policy_tools set status = 'active', confirmed_via = 'telegram', activated_at = now(), removed_at = null where id = $1", [IDS.policyToolActive])).ok) problems.push('a removed rule came back');
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-policy-rule-must-be-well-formed-and-a-tool-has-one-live-rule',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const good = await attempt(tx, "insert into policy_tools (tool, kind, access, proposed_via) values ('acme.read_orders', 'routine', 'read', 'telegram')");
        if (!good.ok) problems.push(`control failed: a well-formed rule was refused (${good.error})`);
        const bad = [
          ['an ask rule without a category', "insert into policy_tools (tool, kind, proposed_via, status, confirmed_via, activated_at) values ('acme.a', 'ask', 'telegram', 'active', 'telegram', now())"],
          ['an ask rule with an access tag', "insert into policy_tools (tool, kind, category, access, proposed_via) values ('acme.b', 'ask', 'spend', 'read', 'telegram')"],
          ['a routine rule without an access tag', "insert into policy_tools (tool, kind, proposed_via) values ('acme.c', 'routine', 'telegram')"],
          ['a routine rule with a category', "insert into policy_tools (tool, kind, category, access, proposed_via) values ('acme.d', 'routine', 'spend', 'read', 'telegram')"],
          ['the unknown category', "insert into policy_tools (tool, kind, category, proposed_via, status, confirmed_via, activated_at) values ('acme.e', 'ask', 'unknown', 'telegram', 'active', 'telegram', now())"],
          ['a name with capitals', "insert into policy_tools (tool, kind, access, proposed_via) values ('Acme.Read', 'routine', 'read', 'telegram')"],
          ['a name with a look-alike letter', "insert into policy_tools (tool, kind, access, proposed_via) values ('acme.booKs', 'routine', 'read', 'telegram')"],
          ['an agent as the proposer', "insert into policy_tools (tool, kind, access, proposed_via) values ('acme.f', 'routine', 'read', 'agent')"],
          ['an active rule nobody confirmed', "insert into policy_tools (tool, kind, access, status, proposed_via) values ('acme.g', 'routine', 'read', 'active', 'telegram')"],
          ['a second live rule for the same tool', "insert into policy_tools (tool, kind, access, proposed_via) values ('acme.read_orders', 'routine', 'write', 'telegram')"],
        ];
        for (const [what, sql] of bad) if ((await attempt(tx, sql)).ok) problems.push(`accepted ${what}`);
        await attempt(tx, "update policy_tools set status = 'removed', removed_at = now() where tool = 'acme.read_orders'");
        const again = await attempt(tx, "insert into policy_tools (tool, kind, access, proposed_via) values ('acme.read_orders', 'routine', 'write', 'telegram')");
        if (!again.ok) problems.push(`a removed tool could not be proposed again (${again.error})`);
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'seed-creates-exactly-one-fake-pod-and-agent-and-can-run-twice',
    standalone: true,
    async check() {
      const db = await build();
      await applySeed(db);
      const count = async (t) => (await db.query(`select count(*)::int as n from ${t}`)).rows[0].n;
      const snapshot = async () => ({ pods: await count('pods'), agents: await count('agents'), members: await count('pod_members') });
      const once = await snapshot();
      await applySeed(db);
      const twice = await snapshot();
      const unlabelled = (await db.query("select count(*)::int as n from agents where name not like '[seed]%'")).rows[0].n;
      const ok = once.pods === 1 && once.agents === 1 && once.members === 1 && JSON.stringify(once) === JSON.stringify(twice) && unlabelled === 0;
      return verdict(ok, `after one run ${JSON.stringify(once)}, after two ${JSON.stringify(twice)}, unlabelled agents ${unlabelled}`);
    },
  },
];

module.exports = {
  name: 'database-schema',
  description: 'Schema, row-level security per pod, append-only audit log, frozen decisions, pgvector, seed',
  threshold: 1,
  cases: () => cases,
  async run(c) {
    return c.check(c.standalone ? undefined : await getEnv());
  },
};
