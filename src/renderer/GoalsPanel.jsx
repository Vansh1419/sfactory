import { useCallback, useEffect, useRef, useState } from 'react';
import { ageLabel } from './queue.mjs';
import { goalView, shouldRefetch } from './goals.mjs';
import { makeZip } from './zip.mjs';

// The Goals panel: every goal the founder has given, and where it stands, live. A goal sent from the phone
// shows up the moment it is submitted ("Planning and working"), then its tasks, then what happened to each.
// What each line says is decided by goals.mjs (graded by the `goals-view` eval); this file only draws it.
// All text is shown as text, never as markup.

const FETCH_DELAY_MS = 150; // several announcements arriving together cause one fetch
const SHOWN_AT_FIRST = 5;

const CHIP_STYLES = {
  active: 'bg-blue-100 text-blue-900',
  waiting: 'bg-amber-100 text-amber-900',
  ok: 'bg-green-100 text-green-900',
  problem: 'bg-red-100 text-red-900',
  neutral: 'bg-slate-100 text-slate-800',
};

const TASK_TEXT_STYLES = {
  active: 'text-blue-900',
  waiting: 'text-amber-900',
  ok: 'text-slate-900',
  problem: 'text-red-800',
  neutral: 'text-slate-600',
};

/** Saves a file to the founder's computer: one file as itself, or several as a .zip. Nothing is sent anywhere. */
function saveDownload(download) {
  const isZip = download.kind === 'zip';
  const blob = isZip
    ? new Blob([makeZip(download.files)], { type: 'application/zip' })
    : new Blob([download.files[0].content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = download.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function DownloadButton({ download }) {
  const [problem, setProblem] = useState(null);
  const onClick = () => {
    try {
      setProblem(null);
      saveDownload(download);
    } catch {
      setProblem('The download could not be made.');
    }
  };
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={onClick}
        className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
      >
        {download.label}
      </button>
      {download.kind === 'zip' && <p className="mt-1 text-xs text-slate-600">Includes: {download.files.map((f) => f.name).join(', ')}</p>}
      {problem && <p className="mt-1 text-sm text-red-800">{problem}</p>}
    </div>
  );
}

/** The goals, kept live by the runtime's announcements instead of by polling. */
function useGoals(ready) {
  const [goals, setGoals] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    const result = await window.api.goals.list({});
    if (!result.ok) {
      setProblem(result.error.message);
      return;
    }
    setProblem(null);
    setGoals(Array.isArray(result.data.goals) ? result.data.goals : []);
    setLoaded(true);
  }, []);

  const loadSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load().catch(() => setProblem('The goals could not be loaded.')), FETCH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    if (ready) load().catch(() => setProblem('The goals could not be loaded.'));
  }, [ready, load]);

  useEffect(() => {
    const unsubscribe = window.api.onEvent((event) => {
      if (shouldRefetch(event)) loadSoon();
    });
    return () => {
      unsubscribe();
      clearTimeout(timer.current);
    };
  }, [loadSoon]);

  return { goals, loaded, problem };
}

function Goal({ summary }) {
  const view = goalView(summary);
  const age = ageLabel(view.submittedAt);

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label={`Goal: ${view.goal}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
        <span className={`rounded px-2 py-0.5 font-semibold ${CHIP_STYLES[view.tone]}`}>
          {view.isActive && <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-600" />}
          {view.statusLabel}
        </span>
        {age && <span>{age}</span>}
      </header>

      <h3 className="mt-2 whitespace-pre-wrap text-base font-semibold text-slate-900">{view.goal}</h3>
      <p className="mt-1 text-sm text-slate-700">{view.explanation}</p>

      {view.tasks.length > 0 && (
        <ul className="mt-3 grid gap-1.5" aria-label="Tasks">
          {view.tasks.map((task) => (
            <li key={task.taskId || task.title} className="text-sm">
              <span className="text-slate-900">{task.title || 'A task'}</span>
              <span className={`ml-2 ${TASK_TEXT_STYLES[task.tone]}`}>{task.stateLabel}</span>
            </li>
          ))}
        </ul>
      )}

      {view.download && <DownloadButton download={view.download} />}
    </article>
  );
}

export default function GoalsPanel({ ready }) {
  const { goals, loaded, problem } = useGoals(ready);
  const [showAll, setShowAll] = useState(false);

  if (!ready) return null;

  const shown = showAll ? goals : goals.slice(0, SHOWN_AT_FIRST);
  const hidden = goals.length - shown.length;

  return (
    <section aria-labelledby="goals-heading" className="mt-8">
      <h2 id="goals-heading" className="text-xl font-semibold text-slate-900">
        Goals
      </h2>

      {problem && <p className="mt-3 text-sm text-red-800">{problem}</p>}
      {!problem && !loaded && <p className="mt-3 text-sm text-slate-600">Loading…</p>}
      {!problem && loaded && goals.length === 0 && (
        <p className="mt-3 text-sm text-slate-700">No goals yet. Send one from Telegram with /goal and it will appear here.</p>
      )}

      <div className="mt-4 grid gap-3">
        {shown.map((summary) => (
          <Goal key={summary.threadId} summary={summary} />
        ))}
      </div>

      {(hidden > 0 || showAll) && goals.length > SHOWN_AT_FIRST && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="mt-3 text-sm font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          {showAll ? 'Show fewer' : `Show ${hidden} older goal${hidden === 1 ? '' : 's'}`}
        </button>
      )}
    </section>
  );
}
