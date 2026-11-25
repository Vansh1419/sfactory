// The logic behind the Audit log page (PLAN.md step 4.3). Plain functions, no React and no `window`, so they are graded directly by the `audit-search` eval;
// AuditPanel.jsx only draws what they return. Every text from the log is passed through as TEXT: the page never builds markup from it.
// Nothing here throws: an odd or missing field gives a safe, plain default.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const HOUR_MS = 3_600_000;
const MAX_HOURS = 24 * 365;
const MAX_TEXT_CHARS = 200;

const WHO = Object.freeze({ founder: 'The founder', agent: 'An agent', system: 'The system' });
const FORM_WHO = Object.freeze({ founder: 'founder', agent: 'agent', system: 'system' });

const ist = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A moment as "26 Nov 2026, 10:30 IST", or "" when it is not a moment. */
function whenLabel(iso) {
  const ms = typeof iso === 'string' && iso !== '' ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? '' : `${ist.format(new Date(ms))} IST`;
}

/**
 * What the founder typed on the search form, as the arguments for `audit.search`: { ok: true, args } or { ok: false, problem }.
 * `hours` means "only the last N hours"; the runtime checks everything again.
 */
export function searchFormView(form, now = new Date()) {
  if (!isObject(form)) return { ok: false, problem: 'Fill in the search first.' };
  const field = (v) => (typeof v === 'string' ? v.trim() : '');
  const words = field(form.text);
  if (words.length > MAX_TEXT_CHARS) return { ok: false, problem: `Use at most ${MAX_TEXT_CHARS} characters for the words.` };
  const who = field(form.who);
  if (who !== '' && !Object.hasOwn(FORM_WHO, who)) return { ok: false, problem: 'Pick who from the list.' };
  const hours = field(form.hours);
  let since;
  if (hours !== '') {
    const n = Number(hours);
    if (!/^\d+$/.test(hours) || !Number.isInteger(n) || n < 1 || n > MAX_HOURS) return { ok: false, problem: `The hours must be a whole number from 1 to ${MAX_HOURS.toLocaleString('en-US')}.` };
    since = new Date((now instanceof Date ? now : new Date()).getTime() - n * HOUR_MS).toISOString();
  }
  const action = field(form.action);
  const podId = field(form.podId);
  return { ok: true, args: { ...(words === '' ? {} : { text: words }), ...(action === '' ? {} : { action }), ...(who === '' ? {} : { actorType: FORM_WHO[who] }), ...(podId === '' ? {} : { podId }), ...(since === undefined ? {} : { since }) } };
}

/** The runtime's search result as rows the page draws: { rows: [{ id, when, who, action, summary }], more, note }. */
export function auditRowsView(result) {
  const entries = isObject(result) && Array.isArray(result.entries) ? result.entries : [];
  const rows = entries.filter(isObject).map((e) => ({
    id: e.id,
    when: whenLabel(text(e.at)),
    who: WHO[e.actorType] ?? 'Someone',
    action: text(e.action),
    summary: text(e.summary),
  }));
  const scanned = isObject(result) && Number.isInteger(result.scanned) ? result.scanned : null;
  return {
    rows,
    more: isObject(result) && result.more === true,
    note: scanned === null ? '' : `Looked at the newest ${scanned.toLocaleString('en-US')} entries that fit the filters.`,
  };
}
