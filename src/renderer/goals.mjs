// The logic behind the window's Goals panel (PLAN.md step 1.9 follow-up). Plain functions, no React and no
// `window`, so they are graded directly by the `goals-view` eval; GoalsPanel.jsx only draws what they return.
//
// Why it exists: a goal sent from the phone was invisible in the window (only decision cards were shown), so
// there was no sign that it was being planned, had finished, or had failed. Each entry of the runtime's
// `goals.list` is turned here into plain words, and a few runtime events say when to load the list again.

const FINISHED = 'Finished.';

// Failures the runtime reports by code. The runtime's own plain message wins when there is one.
const REASON_TEXT = Object.freeze({
  bad_request: 'The goal was not valid, so nothing was started.',
  bad_plan: 'The plan was not usable, so nothing was started.',
  planner_failed: 'The plan could not be made, so nothing was started.',
  nothing_to_do: 'There is nothing I can do for this goal with the tools I have right now, so nothing was started.',
  audit_failed: 'The goal could not be recorded, so nothing was started.',
  already_exists: 'A goal with that id already exists.',
  interrupted: 'The run stopped part-way and was not continued. An action may or may not have happened, so check before running it again.',
  error: 'The run stopped because of an unexpected problem.',
});
const GENERIC_FAILURE = 'The goal could not be completed.';

// What happened to one task, in words the founder can read. `tone` drives the colour AND the wording is always there.
const TASK_STATES = Object.freeze({
  ran: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed (not retried)', tone: 'problem' },
  rejected: { label: 'You rejected it', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  blocked_unknown_tool: { label: 'Approved, but the tool is not known yet, so it did not run', tone: 'problem' },
  blocked_card: { label: 'No usable card could be written, so it did not run', tone: 'problem' },
  blocked_decision: { label: 'The decision could not be filed, so it did not run', tone: 'problem' },
  blocked_audit: { label: 'Could not be recorded, so it did not run', tone: 'problem' },
  blocked_policy: { label: 'The policy check failed, so it did not run', tone: 'problem' },
  waiting: { label: 'Waiting for your decision', tone: 'waiting' },
  working: { label: 'Working on it', tone: 'active' },
  upcoming: { label: 'Still to come', tone: 'neutral' },
  not_started: { label: 'Did not start', tone: 'neutral' },
});
const UNEXPECTED_OUTCOME = { label: 'Ended with an unexpected result', tone: 'neutral' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const stuck = (outcome) => outcome === 'failed' || (typeof outcome === 'string' && outcome.startsWith('blocked_'));

/** The state of every planned task: its recorded outcome, or where the run is right now. */
function taskViews(summary) {
  const planned = Array.isArray(summary.tasks) ? summary.tasks : [];
  const results = Array.isArray(summary.results) ? summary.results.filter(isObject) : [];
  const status = text(summary.status);
  let current = true; // the first task with no outcome is the one waiting or being worked on

  return planned.map((raw) => {
    const task = isObject(raw) ? raw : {};
    const taskId = text(task.taskId);
    const result = results.find((r) => taskId !== '' && r.taskId === taskId);

    let state;
    if (result) state = text(result.outcome) || 'unknown';
    else if (status === 'waiting' && current) state = 'waiting';
    else if (status === 'running' && current) state = 'working';
    else if (status === 'waiting' || status === 'running') state = 'upcoming';
    else state = 'not_started';
    if (!result) current = false;

    const known = TASK_STATES[state] ?? UNEXPECTED_OUTCOME;
    return { taskId, title: text(task.title), state, stateLabel: known.label, tone: known.tone };
  });
}

// ---- Files the goal's tasks produced, and the Download button -----------------------------------------

const MAX_NAME_CHARS = 100;
const MAX_ZIP_NAME_CHARS = 40;
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f:*?"<>|]/g;

/** A plain file name (no folders, no odd characters, not hidden), or null. The runtime cleans names too; this side never trusts it. */
function plainName(name) {
  if (typeof name !== 'string') return null;
  const cleaned = name.split(/[\\/]/).pop().replace(UNSAFE_NAME_CHARS, '_').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  return cleaned === '' || cleaned.length > MAX_NAME_CHARS ? null : cleaned;
}

/** "script.py" taken twice becomes "script.py" and "script (2).py". */
function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The files of tasks that actually ran, in task order, with safe distinct names. */
function filesOf(summary) {
  const results = Array.isArray(summary.results) ? summary.results.filter(isObject) : [];
  const taken = new Set();
  const files = [];
  for (const r of results) {
    if (r.outcome !== 'ran' || !isObject(r.file)) continue;
    const name = plainName(r.file.name);
    if (name === null || typeof r.file.content !== 'string') continue;
    const unique = uniqueName(name, taken);
    taken.add(unique);
    files.push({ name: unique, content: r.file.content });
  }
  return files;
}

function zipName(goal) {
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_ZIP_NAME_CHARS).replace(/-+$/, '');
  return `${slug === '' ? 'files' : slug}.zip`;
}

/** What the Download button gives: one file as itself, several as one .zip, nothing if there is nothing. */
function downloadOf(files, goal) {
  if (files.length === 0) return null;
  if (files.length === 1) return { kind: 'file', label: `Download ${files[0].name}`, filename: files[0].name, files };
  return { kind: 'zip', label: `Download all ${files.length} files (.zip)`, filename: zipName(goal), files };
}

/** What one goal shows. Never throws; every field is text (or a list of tasks of text). */
export function goalView(input) {
  const summary = isObject(input) ? input : {};
  const status = text(summary.status);
  const tasks = taskViews(summary);
  const goal = text(summary.goal).trim();
  const files = filesOf(summary);
  const base = {
    files,
    download: downloadOf(files, text(summary.goal)),
    threadId: text(summary.threadId),
    goal: goal !== '' ? goal : 'A goal that is just starting…',
    status,
    isActive: status === 'running',
    waitingFor: typeof summary.waitingFor === 'string' ? summary.waitingFor : null,
    submittedAt: text(summary.submittedAt),
    tasks,
  };

  if (status === 'running') return { ...base, statusLabel: 'Planning and working', tone: 'active', explanation: 'Working on it. This updates by itself.' };
  if (status === 'waiting') {
    return { ...base, statusLabel: 'Waiting for you', tone: 'waiting', explanation: 'A decision is waiting for you in the queue below.' };
  }
  if (status === 'done') {
    const count = (Array.isArray(summary.results) ? summary.results : []).filter((r) => isObject(r) && stuck(r.outcome)).length;
    if (count === 0) return { ...base, statusLabel: 'Finished', tone: 'ok', explanation: FINISHED };
    return { ...base, statusLabel: 'Finished, with problems', tone: 'problem', explanation: `Finished, but ${count} task${count === 1 ? '' : 's'} did not go ahead.` };
  }
  if (status === 'failed') {
    const message = text(summary.message).trim();
    const reason = text(summary.reason);
    return {
      ...base,
      statusLabel: reason === 'interrupted' ? 'Stopped part-way' : 'Could not start',
      tone: 'problem',
      explanation: message !== '' ? message : REASON_TEXT[reason] ?? GENERIC_FAILURE,
    };
  }
  return { ...base, statusLabel: 'Not found', tone: 'problem', explanation: 'This goal could not be found.' };
}

/** True when a runtime event means the list of goals changed (a run started, paused, finished or failed). */
export function shouldRefetch(event) {
  if (!isObject(event) || typeof event.type !== 'string') return false;
  return event.type.startsWith('orchestrator.') || event.type === 'runtime.ready';
}
