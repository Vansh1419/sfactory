// The logic behind the approval queue screen (PLAN.md step 1.9). Plain functions, no React and no `window`,
// so they are graded directly by the `approval-queue` eval. The screen (ApprovalQueue.jsx) only shows what
// these return.
//
// The queue stays live without polling: the runtime announces every decision change as an event, from any
// channel, so a card approved on the phone arrives here as `decision.resolved` and is removed on the spot.
// Only a NEW decision needs a fetch, because its event carries an id and nothing else.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINAL = ['approved', 'rejected', 'cancelled'];
const ANSWERS = ['approved', 'rejected', 'info_requested'];
const MAX_NOTE_CHARS = 2000;

const CATEGORY_LABELS = Object.freeze({
  spend: 'Spending money',
  people_or_contracts: 'People or contracts',
  launch_or_pricing: 'Launch or price change',
  legal_or_public: 'Legal or public statement',
  unknown: 'A tool that is not known yet',
});

const STATUS_LABELS = Object.freeze({
  pending: 'Waiting for you',
  info_requested: 'You asked for more information',
});

const UNKNOWN_TOOL_NOTE =
  'This tool is not in the policy table yet. Approving this does not run it. Add the tool to the policy table first (in Telegram: /addtool), then give the goal again.';

const GENERIC_PROBLEM = 'Something went wrong and nothing was changed. You can try again.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const timeOf = (row) => Date.parse(row.created_at) || 0;

// ---- keeping the list -------------------------------------------------------------------------

/** Rows from several lists, oldest first, one per id (a later list wins). Skips anything without an id. */
export function mergeLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (isObject(row) && typeof row.id === 'string' && row.id !== '') byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * How one runtime event changes the queue. Returns { rows, refetch }: `rows` is the same array when
 * nothing changed, and `refetch` says the screen should load the list again (a new decision, or the
 * runtime coming up). Anything malformed changes nothing.
 */
export function applyEvent(rows, event) {
  const unchanged = { rows, refetch: false };
  if (!isObject(event) || typeof event.type !== 'string') return unchanged;
  const data = isObject(event.data) ? event.data : {};

  switch (event.type) {
    case 'runtime.ready':
      return { rows, refetch: true };
    case 'decision.created':
      return typeof data.id === 'string' ? { rows, refetch: true } : unchanged;
    case 'decision.cancelled':
      return remove(rows, data.id) ?? unchanged;
    case 'decision.resolved':
      if (FINAL.includes(data.status)) return remove(rows, data.id) ?? unchanged;
      if (data.status === 'info_requested') return mark(rows, data.id, 'info_requested') ?? unchanged;
      return unchanged;
    default:
      return unchanged;
  }
}

function remove(rows, id) {
  if (typeof id !== 'string' || !rows.some((r) => r.id === id)) return null;
  return { rows: rows.filter((r) => r.id !== id), refetch: false };
}

function mark(rows, id, status) {
  if (typeof id !== 'string' || !rows.some((r) => r.id === id)) return null;
  return { rows: rows.map((r) => (r.id === id ? { ...r, status } : r)), refetch: false };
}

// ---- what a card shows ---------------------------------------------------------------------------

const RISK_TONES = Object.freeze({ Low: 'low', Medium: 'medium', High: 'high' });

/** Everything one card shows, as plain text. The screen shows it as text, never as markup. */
export function cardView(row) {
  const r = isObject(row) ? row : {};
  const card = isObject(r.card) ? r.card : {};
  const risk = isObject(card.risk) ? card.risk : {};
  const level = text(risk.level);
  const details = typeof card.details === 'string' && card.details.trim() !== '' ? card.details.trim() : null;

  return {
    id: text(r.id),
    status: text(r.status),
    statusLabel: STATUS_LABELS[r.status] ?? '',
    category: text(r.category),
    categoryLabel: CATEGORY_LABELS[r.category] ?? 'Needs your decision',
    title: text(card.decide),
    whyNow: text(card.why_now),
    ifYes: text(card.if_yes),
    ifNo: text(card.if_no),
    cost: text(card.cost),
    risk: { level, reason: text(risk.reason), tone: RISK_TONES[level] ?? 'unknown' },
    recommendation: text(card.recommendation),
    details,
    tool: isObject(r.action) && typeof r.action.tool === 'string' ? r.action.tool : null,
    note: r.category === 'unknown' ? UNKNOWN_TOOL_NOTE : null,
    canAskMore: r.status === 'pending',
    createdAt: text(r.created_at),
  };
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". Empty when the time is not a time. */
export function ageLabel(createdAt, now = new Date()) {
  const then = typeof createdAt === 'string' && createdAt !== '' ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(then)) return '';
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  const seconds = Math.floor((reference - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

// ---- answering --------------------------------------------------------------------------------------

const DONE = Object.freeze({ approved: 'Approved.', rejected: 'Rejected.', cancelled: 'Cancelled.', info_requested: 'Asked for more information.' });

/**
 * What to tell the founder after an answer, from the runtime's reply to `decisions.resolve`.
 * { tone: 'ok' | 'info' | 'error', text, remove }: `remove` says the card is finished and can leave the list.
 */
export function describeAnswer(result) {
  if (isObject(result) && result.ok === false) {
    const message = text(result.error?.message);
    return { tone: 'error', text: message !== '' ? message : GENERIC_PROBLEM, remove: false };
  }
  if (isObject(result) && result.ok === true && isObject(result.data) && typeof result.data.status === 'string') {
    const { status, changed } = result.data;
    if (changed) return { tone: 'ok', text: DONE[status] ?? 'Done.', remove: FINAL.includes(status) };
    // The card was answered somewhere else first (the phone, or an earlier click): nothing changed.
    const said = status === 'info_requested' ? 'waiting for more information' : status;
    return { tone: 'info', text: `Already ${said}. Your click did not change anything.`, remove: FINAL.includes(status) };
  }
  return { tone: 'error', text: GENERIC_PROBLEM, remove: false };
}

/** The one thing sent to `window.api.decisions.resolve`: the id, the answer, and a trimmed note if there is one. */
export function answerArgs(input) {
  const { id, decision, note } = isObject(input) ? input : {};
  if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, problem: 'That card has no valid id.' };
  if (!ANSWERS.includes(decision)) return { ok: false, problem: 'That is not an answer I can send.' };

  let trimmed = '';
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') return { ok: false, problem: 'The note must be text.' };
    trimmed = note.trim();
    if (trimmed.length > MAX_NOTE_CHARS) return { ok: false, problem: `The note is too long. Keep it under ${MAX_NOTE_CHARS} characters.` };
  }
  return { ok: true, args: { id, decision, ...(trimmed !== '' ? { note: trimmed } : {}) } };
}
