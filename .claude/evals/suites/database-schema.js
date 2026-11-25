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
//   outbound_messages(id, team, to_address, subject, body, content_hash, status, review, decision_id, founder_approval_required)
//     an outbound client message and where it stands (step 2.2): drafted, review_failed, awaiting_founder, ready,
//     rejected, sending, sent, send_failed, cancelled. Service-role only. The content is fixed when it is written (the
//     database computes its hash), a message becomes `ready` only with a passing review and, when the founder's approval
//     is required, an APPROVED decision, and it is `sent` only after `sending`
//   tickets(id, customer_email, customer_name, subject, body, status, reply_message_id, decision_id, note)
//     a customer's question or complaint and where it stands (step 2.4): open, in_progress, answered, escalated, closed.
//     Service-role only. What the customer wrote is fixed when it is written, a ticket is `answered` only with the reply
//     message it was answered with and `escalated` only with a decision, and its life only moves forward
//   pod_id is NULL for company-level rows. Pod agents authenticate as role `authenticated`
//   with a `pod_id` JWT claim; the runtime uses `service_role`, which bypasses RLS.

const { IDS, EMBEDDING_DIMENSIONS, vec, build, applySeed, getEnv, who, withRole, attempt, CARD, ACTION } = require('../db');

const TABLES = [
  'tasks', 'agents', 'decisions', 'audit_log', 'memory', 'clients', 'projects',
  'agent_events', 'pods', 'pod_members', 'scaling_rules', 'policy_tools', 'graph_checkpoints', 'graph_writes', 'outbound_messages', 'tickets',
];
const POD_ROWS = ['tasks', 'decisions', 'memory', 'agent_events', 'audit_log', 'pod_members'];

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const ids = (rows, col = 'id') => rows.map((r) => r[col]).sort();
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const decisionSql = (extraCols = '', extraVals = '') =>
  `insert into decisions (pod_id, category, action, card, status${extraCols}) values ($1, 'spend', $2, $3, $4${extraVals})`;


const MESSAGE = "insert into outbound_messages (team, to_address, subject, body, founder_approval_required) values ('marketing_sales', 'client@example.com', 'Your proposal', 'Hello, here it is.', $1) returning id";
const PASS = JSON.stringify({ verdict: 'pass', problems: [] });
const FAILED_REVIEW = JSON.stringify({ verdict: 'fail', problems: ['It promises a refund.'] });
const decisionRow = (status) => `insert into decisions (category, action, card, status${status === 'pending' ? '' : ', resolved_at, resolved_via'}) values ('legal_or_public', $1, $2, '${status}'${status === 'pending' ? '' : ", now(), 'telegram'"}) returning id`;
const idOf = (r) => r.rows[0].id;

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
    // Step 3.2 (Nov 26, 2026): "check row-level security on every pod table". The cases above name their tables, so a table added later with a
    // `pod_id` column would be missed. This one finds every table that holds a pod's rows and fails until it is in POD_ROWS (so the cases above attack it)
    // and has a read rule for pods; and every table a pod may see at all must say, in its rule, that the pod is the one in the token.
    id: 'every-table-that-holds-a-pods-rows-is-covered-by-the-isolation-cases-and-has-a-rule-keyed-on-the-pod',
    async check(db) {
      const problems = [];
      const withPod = (await db.query("select table_name from information_schema.columns where table_schema = 'public' and column_name = 'pod_id' order by 1")).rows.map((r) => r.table_name);
      const expected = [...POD_ROWS].sort();
      if (JSON.stringify(withPod) !== JSON.stringify(expected)) problems.push(`tables with a pod_id column are [${withPod}] but the isolation cases cover [${expected}]: add the new table to POD_ROWS`);
      const policies = (await db.query("select tablename, cmd, qual, with_check from pg_policies where schemaname = 'public'")).rows;
      const keyed = (p) => /pod_id/i.test(`${p.qual ?? ''} ${p.with_check ?? ''}`);
      for (const table of new Set([...withPod, ...POD_ROWS, 'pods', 'projects', 'clients', 'agents'])) {
        const mine = policies.filter((p) => p.tablename === table);
        if (!mine.some((p) => ['SELECT', 'ALL'].includes(p.cmd))) problems.push(`${table}: no read rule for pods`);
        if (mine.some((p) => !keyed(p) && !/is_shared/i.test(`${p.qual}`))) problems.push(`${table}: a rule that is not keyed on the pod in the token`);
      }
      const noRules = (await db.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1)", [withPod])).rows.length;
      if (noRules !== withPod.length) problems.push('a pod table could not be found');
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
    id: 'outbound-messages-are-service-only-and-never-visible-to-a-pod',
    async check(db) {
      const problems = [];
      await withRole(db, who.service, async (tx) => {
        const add = await attempt(tx, MESSAGE, [true]);
        const seen = await attempt(tx, 'select count(*)::int as n from outbound_messages');
        if (!add.ok || !seen.ok || seen.rows[0].n < 1) problems.push(`control failed: the runtime cannot write and read a message (${add.error ?? seen.error})`);
      });
      await withRole(db, who.owner, async (tx) => {
        await tx.query(MESSAGE, [true]);
        for (const [name, role, claims] of [['pod', 'authenticated', { pod_id: IDS.podA }], ['no pod claim', 'authenticated', {}], ['anon', 'anon', {}]]) {
          await tx.query(`set local role ${role}`);
          await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
          const read = await attempt(tx, 'select * from outbound_messages');
          if (read.ok && read.rows.length > 0) problems.push(`${name} reads outbound messages`);
          if ((await attempt(tx, MESSAGE, [false])).ok) problems.push(`${name} wrote an outbound message`);
          const edit = await attempt(tx, "update outbound_messages set status = 'cancelled'");
          if (edit.ok && edit.count > 0) problems.push(`${name} changed a message`);
          await tx.query('reset role');
        }
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'the-content-of-an-outbound-message-is-fixed-and-the-database-computes-its-hash',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const made = await attempt(tx, "insert into outbound_messages (team, to_address, subject, body, content_hash) values ('support', 'a@example.com', 'Subject', E'Line one\nLine two', 'forged') returning id, content_hash, content_hash = encode(sha256(convert_to(to_address || E'\n' || subject || E'\n' || body, 'UTF8')), 'hex') as right_hash");
        if (!made.ok) {
          problems.push(`control failed: a message could not be written (${made.error})`);
          return;
        }
        const { id, content_hash: hash, right_hash: rightHash } = made.rows[0];
        if (hash === 'forged' || rightHash !== true) problems.push('the stored hash is not the one the database computes from the content');
        for (const [col, value] of [['to_address', "'b@example.com'"], ['subject', "'Another'"], ['body', "'Changed'"], ['team', "'finance_legal_ops'"], ['content_hash', "'0000'"]]) {
          if ((await attempt(tx, `update outbound_messages set ${col} = ${value} where id = $1`, [id])).ok) problems.push(`${col} could be changed after the message was written`);
        }
        const review = await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'review_failed' where id = $1", [id, FAILED_REVIEW]);
        if (!review.ok) problems.push(`control failed: a review result could not be recorded (${review.error})`);
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-message-becomes-ready-only-with-a-passing-review-and-when-required-an-approved-decision',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const approved = idOf(await tx.query(decisionRow('approved'), [ACTION, CARD]));
        const rejected = idOf(await tx.query(decisionRow('rejected'), [ACTION, CARD]));
        const pending = idOf(await tx.query(decisionRow('pending'), [ACTION, CARD]));
        const ready = (id, extra = '') => attempt(tx, `update outbound_messages set review = coalesce(review, $2::jsonb), status = 'ready' ${extra} where id = $1`, [id, PASS]);
        const fresh = async (required) => idOf(await tx.query(MESSAGE, [required]));

        // No review at all, and a failed review: never ready.
        const noReview = await fresh(false);
        if ((await attempt(tx, "update outbound_messages set status = 'ready' where id = $1", [noReview])).ok) problems.push('ready with no review');
        const failed = await fresh(false);
        if ((await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'ready' where id = $1", [failed, FAILED_REVIEW])).ok) problems.push('ready after a failed review');
        const odd = await fresh(false);
        for (const bad of ['{}', '{"verdict":"PASS"}', '{"verdict":true}', '"pass"', '[]']) {
          if ((await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'ready' where id = $1", [odd, bad])).ok) problems.push(`ready with the review ${bad}`);
        }

        // When the founder's approval is not required, a passing review is enough.
        const free = await fresh(false);
        const okFree = await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'ready' where id = $1", [free, PASS]);
        if (!okFree.ok) problems.push(`control failed: a reviewed message that needs no approval could not become ready (${okFree.error})`);

        // A review that passes but says it must go to the founder counts as "approval required" even when the setting is off.
        const ESCALATED = JSON.stringify({ verdict: 'pass', escalate: true, problems: ['It promises a refund.'] });
        const esc = await fresh(false);
        if ((await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'ready' where id = $1", [esc, ESCALATED])).ok) problems.push('an escalated message became ready without the founder');
        const escApproved = await fresh(false);
        await attempt(tx, "update outbound_messages set review = $3::jsonb, decision_id = $2, status = 'awaiting_founder' where id = $1", [escApproved, approved, ESCALATED]);
        const escDone = await attempt(tx, "update outbound_messages set status = 'ready' where id = $1", [escApproved]);
        if (!escDone.ok) problems.push(`control failed: an escalated message with an approved decision could not become ready (${escDone.error})`);
        const escPending = await fresh(false);
        await attempt(tx, "update outbound_messages set review = $3::jsonb, decision_id = $2, status = 'awaiting_founder' where id = $1", [escPending, pending, ESCALATED]);
        if ((await attempt(tx, "update outbound_messages set status = 'ready' where id = $1", [escPending])).ok) problems.push('an escalated message became ready on a pending decision');

        // When it is required: never straight from drafted, however good the review.
        const direct = await fresh(true);
        if ((await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'ready' where id = $1", [direct, PASS])).ok) problems.push('ready without the founder although approval is required');

        // awaiting_founder needs a passing review and a decision.
        const await1 = await fresh(true);
        if ((await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'awaiting_founder' where id = $1", [await1, PASS])).ok) problems.push('awaiting the founder with no decision');
        if ((await attempt(tx, "update outbound_messages set review = $3::jsonb, decision_id = $2, status = 'awaiting_founder' where id = $1", [await1, pending, FAILED_REVIEW])).ok) problems.push('awaiting the founder after a failed review');
        const into = await attempt(tx, "update outbound_messages set review = $3::jsonb, decision_id = $2, status = 'awaiting_founder' where id = $1", [await1, pending, PASS]);
        if (!into.ok) problems.push(`control failed: a reviewed message could not wait for the founder (${into.error})`);
        if ((await attempt(tx, "update outbound_messages set status = 'ready' where id = $1", [await1])).ok) problems.push('ready while the decision is still pending');

        // The decision must be an APPROVED one.
        const rej = await fresh(true);
        await attempt(tx, "update outbound_messages set review = $3::jsonb, decision_id = $2, status = 'awaiting_founder' where id = $1", [rej, rejected, PASS]);
        if ((await attempt(tx, "update outbound_messages set status = 'ready' where id = $1", [rej])).ok) problems.push('ready on a rejected decision');
        const yes = await fresh(true);
        await attempt(tx, "update outbound_messages set review = $3::jsonb, decision_id = $2, status = 'awaiting_founder' where id = $1", [yes, approved, PASS]);
        const done = await attempt(tx, "update outbound_messages set status = 'ready' where id = $1", [yes]);
        if (!done.ok) problems.push(`control failed: an approved message could not become ready (${done.error})`);
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'an-outbound-message-only-moves-forward-and-is-sent-only-after-sending',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const fresh = async () => idOf(await tx.query(MESSAGE, [false]));
        const go = (id, status, extra = '') => attempt(tx, `update outbound_messages set status = '${status}' ${extra} where id = $1`, [id]);
        const readyOne = async () => {
          const id = await fresh();
          await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'ready' where id = $1", [id, PASS]);
          return id;
        };

        const a = await readyOne();
        if ((await go(a, 'sent', ', sent_at = now()')).ok) problems.push('sent without sending first');
        const toSending = await go(a, 'sending');
        if (!toSending.ok) problems.push(`control failed: ready could not go to sending (${toSending.error})`);
        if ((await go(a, 'ready')).ok) problems.push('sending went back to ready');
        const sent = await go(a, 'sent', ', sent_at = now()');
        if (!sent.ok) problems.push(`control failed: sending could not go to sent (${sent.error})`);
        for (const next of ['sending', 'ready', 'send_failed', 'cancelled', 'drafted']) if ((await go(a, next)).ok) problems.push(`sent went to ${next}`);
        if ((await attempt(tx, 'delete from outbound_messages where id = $1', [a])).ok) problems.push('a message was deleted');

        const b = await readyOne();
        await go(b, 'sending');
        const failed = await go(b, 'send_failed');
        if (!failed.ok) problems.push(`control failed: sending could not go to send_failed (${failed.error})`);
        for (const next of ['ready', 'sending', 'sent']) if ((await go(b, next)).ok) problems.push(`send_failed went to ${next}`);

        const c = await fresh();
        for (const next of ['sent', 'sending']) if ((await go(c, next)).ok) problems.push(`drafted went to ${next}`);
        await attempt(tx, "update outbound_messages set review = $2::jsonb, status = 'review_failed' where id = $1", [c, FAILED_REVIEW]);
        if ((await go(c, 'ready')).ok) problems.push('review_failed went to ready');
        if (!(await go(c, 'cancelled')).ok) problems.push('review_failed could not be cancelled');
        if ((await go(c, 'drafted')).ok) problems.push('cancelled came back');
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'an-outbound-message-must-be-one-recipient-one-line-subject-and-a-body-of-sensible-size',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const add = (to, subject, body) => attempt(tx, "insert into outbound_messages (team, to_address, subject, body) values ('support', $1, $2, $3)", [to, subject, body]);
        const good = await add('person@example.co.in', 'A subject', 'A body.');
        if (!good.ok) problems.push(`control failed: a good message was refused (${good.error})`);
        const bad = [
          ['two recipients', 'a@example.com, b@example.com', 's', 'b'],
          ['two recipients with a semicolon', 'a@example.com;b@example.com', 's', 'b'],
          ['a name and an address', 'Ann <a@example.com>', 's', 'b'],
          ['a line break in the recipient (header injection)', 'a@example.com\r\nBcc: x@example.com', 's', 'b'],
          ['no at sign', 'example.com', 's', 'b'],
          ['an empty recipient', '', 's', 'b'],
          ['a line break in the subject', 'a@example.com', 'Hi\r\nBcc: x@example.com', 'b'],
          ['an empty subject', 'a@example.com', '', 'b'],
          ['a very long subject', 'a@example.com', 'x'.repeat(301), 'b'],
          ['an empty body', 'a@example.com', 's', ''],
          ['a very long body', 'a@example.com', 's', 'x'.repeat(20_001)],
          ['an unknown team', 'a@example.com', 's', 'b', 'sales'],
        ];
        for (const [what, to, subject, body, team] of bad) {
          const r = team
            ? await attempt(tx, "insert into outbound_messages (team, to_address, subject, body) values ($4, $1, $2, $3)", [to, subject, body, team])
            : await add(to.replace(/\\r\\n/g, '\r\n'), subject.replace(/\\r\\n/g, '\r\n'), body);
          if (r.ok) problems.push(`accepted ${what}`);
        }
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
  {
    // Step 3.1 (Nov 26, 2026): opening a pod is the founder's decision. The database refuses a pod on any decision but an approved `pod.create`, and
    // one decision opens one pod.
    id: 'a-pod-opened-on-a-decision-needs-an-approved-pod-create-decision-and-one-decision-opens-one-pod',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const project = async (name) => idOf(await tx.query("insert into projects (name, kind) values ($1, 'agency_client') returning id", [name]));
        const decision = async (status, tool) => idOf(await tx.query(`insert into decisions (category, action, card, status${status === 'pending' ? '' : ', resolved_at, resolved_via'}) values ('people_or_contracts', $1::jsonb, $2, '${status}'${status === 'pending' ? '' : ", now(), 'telegram'"}) returning id`, [JSON.stringify({ tool, access: 'write', args: {} }), CARD]));
        const open = (projectId, decisionId) => attempt(tx, "insert into pods (project_id, template, decision_id) values ($1, 'agency_client', $2) returning id", [projectId, decisionId]);

        const good = await decision('approved', 'pod.create');
        const first = await open(await project('First'), good);
        if (!first.ok) problems.push(`control failed: an approved pod.create decision could not open a pod (${first.error})`);
        if ((await open(await project('Second'), good)).ok) problems.push('one decision opened two pods');
        for (const [label, id] of [['a pending decision', await decision('pending', 'pod.create')], ['a rejected decision', await decision('rejected', 'pod.create')], ['an approved decision of another kind', await decision('approved', 'razorpay.create_payout')], ['a decision that does not exist', '00000000-0000-4000-8000-000000000000']]) {
          if ((await open(await project(label), id)).ok) problems.push(`a pod was opened on ${label}`);
        }
        if (!(await attempt(tx, "insert into pods (project_id, template) values ($1, 'saas_product') returning id", [await project('No card')])).ok) problems.push('a pod without a decision (the dev seed and the isolation tests) could not be made');
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'what-a-pod-was-opened-for-is-fixed-and-a-closed-pod-stays-closed',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const projectA = idOf(await tx.query("insert into projects (name, kind) values ('A', 'agency_client') returning id"));
        const projectB = idOf(await tx.query("insert into projects (name, kind) values ('B', 'agency_client') returning id"));
        const decisionId = idOf(await tx.query("insert into decisions (category, action, card, status, resolved_at, resolved_via) values ('people_or_contracts', $1::jsonb, $2, 'approved', now(), 'telegram') returning id", [JSON.stringify({ tool: 'pod.create', access: 'write', args: {} }), CARD]));
        const pod = idOf(await tx.query("insert into pods (project_id, template, decision_id) values ($1, 'agency_client', $2) returning id", [projectA, decisionId]));
        for (const [col, value] of [['project_id', `'${projectB}'`], ['template', "'saas_product'"], ['decision_id', 'null'], ['opened_at', "now() - interval '1 day'"]]) {
          if ((await attempt(tx, `update pods set ${col} = ${value} where id = $1`, [pod])).ok) problems.push(`${col} of a pod could be changed`);
        }
        if (!(await attempt(tx, "update pods set status = 'closed', closed_at = now() where id = $1", [pod])).ok) problems.push('control failed: an open pod could not be closed');
        if ((await attempt(tx, "update pods set status = 'open', closed_at = null where id = $1", [pod])).ok) problems.push('a closed pod was reopened');
        if (!(await attempt(tx, "update pods set closed_at = closed_at where id = $1", [pod])).ok) problems.push('a closed pod could not be left as it is');
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'tickets-are-service-only-and-never-visible-to-a-pod',
    async check(db) {
      const problems = [];
      const TICKET = "insert into tickets (customer_email, subject, body) values ('ann@example.com', 'Where is my order?', 'It has not arrived.') returning id";
      await withRole(db, who.service, async (tx) => {
        const add = await attempt(tx, TICKET);
        const seen = await attempt(tx, 'select count(*)::int as n from tickets');
        if (!add.ok || !seen.ok || seen.rows[0].n < 1) problems.push(`control failed: the runtime cannot write and read a ticket (${add.error ?? seen.error})`);
      });
      await withRole(db, who.owner, async (tx) => {
        await tx.query(TICKET);
        for (const [name, role, claims] of [['pod', 'authenticated', { pod_id: IDS.podA }], ['no pod claim', 'authenticated', {}], ['anon', 'anon', {}]]) {
          await tx.query(`set local role ${role}`);
          await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
          const read = await attempt(tx, 'select * from tickets');
          if (read.ok && read.rows.length > 0) problems.push(`${name} reads tickets`);
          if ((await attempt(tx, TICKET)).ok) problems.push(`${name} wrote a ticket`);
          const edit = await attempt(tx, "update tickets set status = 'closed'");
          if (edit.ok && edit.count > 0) problems.push(`${name} changed a ticket`);
          await tx.query('reset role');
        }
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-ticket-starts-open-and-what-the-customer-wrote-is-fixed-and-sensible',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const add = (email, subject, body, extra = '', extraValue = '') => attempt(tx, `insert into tickets (customer_email, subject, body${extra}) values ($1, $2, $3${extraValue}) returning id`, [email, subject, body]);
        const made = await add('ann@example.com', 'Where is my order?', 'It has not arrived.');
        if (!made.ok) return problems.push(`control failed: a ticket could not be written (${made.error})`);
        const id = made.rows[0].id;
        const row = (await tx.query('select status, reply_message_id, decision_id from tickets where id = $1', [id])).rows[0];
        if (row.status !== 'open' || row.reply_message_id !== null || row.decision_id !== null) problems.push('a ticket did not start open and empty');
        for (const [col, value] of [['customer_email', "'b@example.com'"], ['subject', "'Changed'"], ['body', "'Changed'"], ['customer_name', "'Someone'"], ['created_at', "now() - interval '1 day'"]]) {
          if ((await attempt(tx, `update tickets set ${col} = ${value} where id = $1`, [id])).ok) problems.push(`${col} could be changed after the ticket was written`);
        }
        for (const status of ['answered', 'escalated', 'in_progress', 'closed']) {
          if ((await attempt(tx, `insert into tickets (customer_email, subject, body, status) values ('a@example.com', 'S', 'B', '${status}')`)).ok) problems.push(`a ticket was written as ${status}`);
        }
        const bad = [['a@example.com, b@example.com', 'S', 'B'], ['not-an-address', 'S', 'B'], ['a@example.com', 'Hi\r\nBcc: x@y.co', 'B'], ['a@example.com', '', 'B'], ['a@example.com', 'S', ''], ['a@example.com', 'x'.repeat(301), 'B'], ['a@example.com', 'S', 'x'.repeat(20001)]];
        for (const [email, subject, body] of bad) {
          if ((await add(email, subject, body)).ok) problems.push(`a bad ticket was written: ${email.slice(0, 20)} / ${subject.slice(0, 10)}`);
        }
      });
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-ticket-moves-forward-is-answered-only-with-its-reply-escalated-only-with-a-decision-and-is-never-deleted',
    async check(db) {
      const problems = [];
      await withRole(db, who.owner, async (tx) => {
        const fresh = async () => (await tx.query("insert into tickets (customer_email, subject, body) values ('ann@example.com', 'Help', 'Please help.') returning id")).rows[0].id;
        const go = (id, status, extra = '', params = []) => attempt(tx, `update tickets set status = '${status}' ${extra} where id = $1`, [id, ...params]);
        const message = idOf(await tx.query("insert into outbound_messages (team, to_address, subject, body, founder_approval_required) values ('support', 'ann@example.com', 'Re: Help', 'We are on it.', false) returning id"));
        const message2 = idOf(await tx.query("insert into outbound_messages (team, to_address, subject, body, founder_approval_required) values ('support', 'ann@example.com', 'Re: Help 2', 'We are on it.', false) returning id"));
        const pending = idOf(await tx.query(decisionRow('pending'), [ACTION, CARD]));

        const a = await fresh();
        for (const next of ['answered', 'escalated']) if ((await go(a, next)).ok) problems.push(`open went straight to ${next}`);
        if (!(await go(a, 'in_progress')).ok) problems.push('control failed: open could not go to in_progress');
        if ((await go(a, 'answered')).ok) problems.push('answered without a reply');
        if ((await go(a, 'escalated')).ok) problems.push('escalated without a decision');
        if ((await go(a, 'answered', ', reply_message_id = $2', [message])).ok !== true) problems.push('control failed: in_progress could not become answered with a reply');
        if ((await attempt(tx, 'update tickets set reply_message_id = $2 where id = $1', [a, message2])).ok) problems.push('the reply of an answered ticket was swapped');
        for (const next of ['open', 'in_progress', 'escalated']) if ((await go(a, next)).ok) problems.push(`answered went to ${next}`);
        if (!(await go(a, 'closed')).ok) problems.push('answered could not be closed');
        for (const next of ['open', 'in_progress', 'answered', 'escalated']) if ((await go(a, next)).ok) problems.push(`closed went to ${next}`);
        if ((await attempt(tx, 'delete from tickets where id = $1', [a])).ok) problems.push('a ticket was deleted');

        const b = await fresh();
        await go(b, 'in_progress');
        if (!(await go(b, 'escalated', ', decision_id = $2', [pending])).ok) problems.push('control failed: in_progress could not become escalated with a decision');
        if ((await attempt(tx, 'update tickets set decision_id = null where id = $1', [b])).ok) problems.push('the decision of an escalated ticket was removed');
        for (const next of ['open', 'in_progress', 'answered']) if ((await go(b, next)).ok) problems.push(`escalated went to ${next}`);

        const c = await fresh();
        await go(c, 'in_progress');
        if (!(await go(c, 'open')).ok) problems.push('in_progress could not go back to open');
      });
      return verdict(problems.length === 0, problems.join('; '));
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
