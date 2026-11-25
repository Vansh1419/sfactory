// The logic behind the Settings page (PLAN.md step 4.3). Plain functions, no React and no `window`, so they are graded directly by the `settings-page` eval;
// SettingsPanel.jsx only draws what they return. The forms are checked here BEFORE anything is sent (the runtime checks everything again, and refuses a value
// outside its bounds rather than correcting it). Every text from the database is passed through as TEXT. Nothing here throws.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');

const TEAMS = Object.freeze({ product_engineering: 'Product and Engineering', marketing_sales: 'Marketing and Sales', support: 'Customer Support', finance_legal_ops: 'Finance, Legal and Ops' });
const ROLES = Object.freeze({ worker: 'Workers', specialist: 'Specialists' });
const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const LIMIT_BOUNDS = Object.freeze({ maxTasksPerDay: [1, 1000, 'The daily task cap'], loopRepeats: [2, 10, 'The number of repeats that make a loop'] });
const RULE_BOUNDS = Object.freeze({
  max_agents: [1, 50, 'The most agents'],
  scale_up_queue_threshold: [1, 1000, 'The waiting tasks per agent that add one'],
  scale_up_wait_minutes: [1, 10_080, 'The minutes a task may wait before one is added'],
  idle_minutes_before_removal: [1, 10_080, 'The idle minutes before a copy is removed'],
});

/** "2026-12-09" as "9 December 2026", or "" when it is not a day. */
function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(iso));
  if (!m) return '';
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : '';
}

/** The runtime's `settings.get` as what the page draws. */
export function settingsView(data) {
  const d = isObject(data) ? data : {};
  const limits = isObject(d.limits) ? d.limits : {};
  const outbound = isObject(d.approvals) && isObject(d.approvals.outbound) ? d.approvals.outbound : {};
  const until = dayLabel(outbound.until);
  const asked = outbound.mode === 'until' && until !== '';
  return {
    limits: Object.entries(LIMIT_BOUNDS).map(([key, [min, max, label]]) => ({ key, label, value: Number.isInteger(limits[key]) ? limits[key] : null, min, max })),
    scaling: (Array.isArray(d.scaling) ? d.scaling : []).filter((r) => isObject(r) && Object.hasOwn(TEAMS, r.team) && Object.hasOwn(ROLES, r.role)).map((r) => ({
      team: r.team,
      role: r.role,
      teamLabel: TEAMS[r.team],
      roleLabel: ROLES[r.role],
      enabled: r.enabled !== false,
      sourceNote: r.source === 'table' ? 'your saved rule' : 'the built-in default',
      values: Object.entries(RULE_BOUNDS).map(([key, [min, max, label]]) => ({ key, label, value: Number.isInteger(r[key]) ? r[key] : null, min, max })),
    })),
    stopped: (Array.isArray(d.stoppedTeams) ? d.stoppedTeams : []).filter((t) => Object.hasOwn(TEAMS, t)).map((t) => TEAMS[t]),
    approvalLine: asked ? `Your approval is required for every message to a client until ${until}.` : 'Your approval is required for every message to a client.',
    approvalNote: 'To change this, edit OUTBOUND_FOUNDER_APPROVAL_UNTIL in your .env file. It is not changed here, because ending it loosens the rules.',
    tools: (Array.isArray(d.tools) ? d.tools : []).filter((t) => isObject(t) && typeof t.tool === 'string').map((t) => ({ tool: t.tool, summary: t.kind === 'ask' ? `always asks you first (${text(t.category).replace(/_/g, ' ')})` : `runs without asking (${text(t.access)}), ${t.status === 'active' ? 'active' : 'waiting for your confirmation'}` })),
  };
}

const whole = (raw) => {
  const t = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  return t !== '' && /^\d+$/.test(t) ? Number(t) : null;
};

/** One value of a form: undefined when left empty, or the whole number, or a problem. */
function readValue(raw, [min, max, label]) {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (empty) return { skip: true };
  const n = whole(raw);
  if (n === null || n < min || n > max) return { problem: `${label} must be a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.` };
  return { value: n };
}

/** The limits form: only the boxes that were filled are sent. */
export function limitsFormView(form) {
  if (!isObject(form)) return { ok: false, problem: 'Fill in a value first.' };
  const args = {};
  for (const [key, bounds] of Object.entries(LIMIT_BOUNDS)) {
    const got = readValue(form[key], bounds);
    if (got.problem) return { ok: false, problem: got.problem };
    if (!got.skip) args[key] = got.value;
  }
  return Object.keys(args).length === 0 ? { ok: false, problem: 'Fill in at least one value.' } : { ok: true, args };
}

/** One scaling rule's form: only the boxes that were filled (and the switch, when it was touched) are sent. */
export function scalingFormView(row) {
  if (!isObject(row) || typeof row.team !== 'string' || typeof row.role !== 'string') return { ok: false, problem: 'Pick a team and a role first.' };
  const args = { team: row.team, role: row.role };
  for (const [key, bounds] of Object.entries(RULE_BOUNDS)) {
    const got = readValue(row[key], bounds);
    if (got.problem) return { ok: false, problem: got.problem };
    if (!got.skip) args[key] = got.value;
  }
  if (typeof row.enabled === 'boolean') args.enabled = row.enabled;
  return Object.keys(args).length === 2 ? { ok: false, problem: 'Change at least one value.' } : { ok: true, args };
}
