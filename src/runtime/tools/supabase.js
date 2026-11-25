'use strict';

// The read-only Supabase tool (PLAN.md step 1.10): read rows from a few non-sensitive tables. Graded by the
// `supabase-tool` eval.
//
// The runtime's store uses the SERVICE key, which bypasses row-level security, so this tool is the only protection:
//   - only the tables in READABLE_TABLES can be read (never the audit log, decisions, the founder's policy table, run
//     checkpoints, memory, clients, pods or members)
//   - it keeps ONLY the store's `select`: insert and update are not reachable from here at all
//   - filters are equalities on plain column names with plain values; the limit is capped; the order is "column.asc|desc"
//   - an error is one plain sentence, never the database's own message

const READABLE_TABLES = Object.freeze(['tasks', 'projects', 'agents', 'scaling_rules']);
// What a run that belongs to a pod may read (step 3.2): its own tasks, its own project, and its own members and the shared specialists. The company's
// scaling rules are not a pod's business. The pod comes from the run's context, never from the arguments.
const POD_READABLE_TABLES = Object.freeze(['tasks', 'projects', 'agents']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_FILTERS = 10;
const MAX_FILTER_TEXT_CHARS = 200;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000, so the notice below always fits
const SHORTENED_NOTICE = '\n[Shortened: there are more rows than fit.]';
const FAILED = 'The rows could not be read.';

const COLUMN = /^[a-z_][a-z0-9_]{0,62}$/;
const ORDER = /^[a-z_][a-z0-9_]{0,62}\.(asc|desc)$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function whereProblem(where) {
  if (!isObject(where)) return 'where must be an object of column: value';
  const entries = Object.entries(where);
  if (entries.length > MAX_FILTERS) return `where can have at most ${MAX_FILTERS} filters`;
  for (const [column, value] of entries) {
    if (!COLUMN.test(column)) return 'where column names must be plain lower-case names';
    const plain = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= MAX_FILTER_TEXT_CHARS);
    if (!plain) return 'where values must be text, a number, true, false or null';
  }
  return null;
}

/** The tool, built over a store. Only the store's `select` is kept. */
function createSupabaseTools({ store } = {}) {
  if (!store || typeof store.select !== 'function') return [];
  const select = store.select.bind(store);

  /** The rows of one table that belong to this pod, and nothing else. A filter that names another pod's row gives no rows. */
  async function selectForPod(args, podId) {
    if (typeof podId !== 'string' || !UUID.test(podId) || !POD_READABLE_TABLES.includes(args.table)) throw new Error(FAILED);
    const id = podId.toLowerCase();
    const limit = args.limit ?? DEFAULT_LIMIT;
    const [pod] = await select('pods', { where: { id }, limit: 1 });
    if (!pod) return [];
    const where = { ...(args.where ?? {}) };
    const pin = (column, value) => {
      if (where[column] !== undefined && where[column] !== value) return false; // the filter names something that is not this pod's
      where[column] = value;
      return true;
    };
    if (args.table === 'tasks') return pin('pod_id', id) ? select('tasks', { where, order: args.order, limit }) : [];
    if (args.table === 'projects') return pin('id', pod.project_id) ? select('projects', { where, order: args.order, limit }) : [];
    const members = new Set((await select('pod_members', { where: { pod_id: id }, limit: 200 })).map((m) => m.agent_id));
    const agents = await select('agents', { where, order: args.order, limit: 200 });
    return agents.filter((a) => members.has(a.id) || a.is_shared === true).slice(0, limit);
  }

  return [
    Object.freeze({
      name: 'supabase.select',
      access: 'read',
      podAccess: 'scoped',
      summary: `Reads rows from one table of the company database (${READABLE_TABLES.join(', ')}) and gives them back as JSON, one row per line. Read-only.`,
      args: `{ "table": one of ${READABLE_TABLES.join(', ')}, "where": optional { column: value } equalities, "limit": optional 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}), "order": optional "column.asc" or "column.desc" }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => !['table', 'where', 'limit', 'order'].includes(k));
        if (extra) return `unknown argument: ${extra}`;
        if (!READABLE_TABLES.includes(args.table)) return `table must be one of ${READABLE_TABLES.join(', ')}`;
        if (args.where !== undefined && whereProblem(args.where)) return whereProblem(args.where);
        if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_LIMIT)) return `limit must be a whole number from 1 to ${MAX_LIMIT}`;
        if (args.order !== undefined && !(typeof args.order === 'string' && ORDER.test(args.order))) return 'order must look like column.asc or column.desc';
        return null;
      },
      async run({ args, context }) {
        let rows;
        try {
          rows = context?.podId === undefined
            ? await select(args.table, { where: { ...(args.where ?? {}) }, order: args.order, limit: args.limit ?? DEFAULT_LIMIT })
            : await selectForPod(args, context.podId);
        } catch {
          throw new Error(FAILED);
        }
        if (!Array.isArray(rows)) throw new Error(FAILED);
        if (rows.length === 0) return { text: 'No rows.' };
        const text = rows.map((row) => JSON.stringify(row)).join('\n');
        return { text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}${SHORTENED_NOTICE}` : text };
      },
    }),
  ];
}

module.exports = { createSupabaseTools, READABLE_TABLES };
