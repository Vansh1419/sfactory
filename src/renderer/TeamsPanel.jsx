import { useCallback, useEffect, useRef, useState } from 'react';
import { overviewView, shouldRefetch } from './teams.mjs';

// The Teams page (PLAN.md step 2.5): each team's status, its agents, its open tasks and its blocked tasks with the reason. It is kept live by
// the runtime's announcements ("tasks.changed") instead of a timer, and it also loads again when the window gets focus and when the founder
// presses Refresh. A timer would call the runtime over and over, and every call is written to the audit log.
// Work done by another process (for example `npm run lead` in a terminal) does not announce itself to this window: it shows up the next time the
// window gets focus or Refresh is pressed.
// What each line says is decided by teams.mjs (graded by the `teams-view` eval); this file only draws it. All text is shown as text, never as markup.

const FETCH_DELAY_MS = 150; // several announcements arriving together cause one fetch

const CHIP_STYLES = {
  active: 'bg-blue-100 text-blue-900',
  waiting: 'bg-amber-100 text-amber-900',
  ok: 'bg-green-100 text-green-900',
  problem: 'bg-red-100 text-red-900',
  neutral: 'bg-slate-100 text-slate-800',
};

const TEXT_STYLES = {
  active: 'text-blue-900',
  waiting: 'text-amber-900',
  ok: 'text-green-900',
  problem: 'text-red-800',
  neutral: 'text-slate-600',
};

/** The overview, kept live by the runtime's announcements and by focus. */
function useTeams(ready) {
  const [overview, setOverview] = useState(null);
  const [problem, setProblem] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    const result = await window.api.teams.list();
    if (!result.ok) {
      setProblem(result.error.message);
      return;
    }
    setProblem(null);
    setOverview(result.data);
  }, []);

  const loadSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load().catch(() => setProblem('The teams could not be loaded.')), FETCH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    if (ready) load().catch(() => setProblem('The teams could not be loaded.'));
  }, [ready, load]);

  useEffect(() => {
    const unsubscribe = window.api.onEvent((event) => {
      if (shouldRefetch(event)) loadSoon();
    });
    const onFocus = () => loadSoon();
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      clearTimeout(timer.current);
    };
  }, [loadSoon]);

  return { overview, problem, refresh: loadSoon };
}

function Team({ view }) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label={`Team: ${view.title}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-slate-900">{view.title}</h3>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${CHIP_STYLES[view.status.tone]}`}>{view.status.label}</span>
      </header>
      <p className="mt-1 text-sm text-slate-700">{view.status.explanation}</p>
      <p className="mt-1 text-sm text-slate-600">{view.agentLine}</p>

      {!view.isEmpty && (
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Task counts">
          {view.countRows.map((row) => (
            <div key={row.key} className="flex items-baseline gap-1.5">
              <dt className="text-slate-600">{row.label}</dt>
              <dd className={`font-semibold ${TEXT_STYLES[row.tone]}`}>{row.display}</dd>
            </div>
          ))}
        </dl>
      )}

      {view.blocked.length > 0 && (
        <section className="mt-3" aria-label="Blocked tasks">
          <h4 className="text-sm font-semibold text-red-800">Blocked</h4>
          <ul className="mt-1 grid gap-2">
            {view.blocked.map((task) => (
              <li key={task.id || task.title} className="rounded border border-red-200 bg-red-50 p-2 text-sm">
                <span className="font-medium text-slate-900">{task.title}</span>
                {task.age && <span className="ml-2 text-xs text-slate-600">{task.age}</span>}
                <p className="mt-0.5 whitespace-pre-wrap text-red-900">{task.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.open.length > 0 && (
        <section className="mt-3" aria-label="Open tasks">
          <h4 className="text-sm font-semibold text-slate-900">Open</h4>
          <ul className="mt-1 grid gap-1.5">
            {view.open.map((task) => (
              <li key={task.id || task.title} className="text-sm">
                <span className="text-slate-900">{task.title}</span>
                <span className={`ml-2 ${TEXT_STYLES[task.tone]}`}>{task.stateLabel}</span>
                {task.who && <span className="ml-2 text-slate-600">by {task.who}</span>}
                {task.age && <span className="ml-2 text-xs text-slate-600">{task.age}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.recentlyDone.length > 0 && (
        <section className="mt-3" aria-label="Recently finished">
          <h4 className="text-sm font-semibold text-slate-900">Recently finished</h4>
          <ul className="mt-1 grid gap-1">
            {view.recentlyDone.map((task) => (
              <li key={task.id || task.title} className="text-sm text-slate-700">
                {task.title}
                {task.age && <span className="ml-2 text-xs text-slate-600">{task.age}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

export default function TeamsPanel({ ready }) {
  const { overview, problem, refresh } = useTeams(ready);
  if (!ready) return null;

  const page = overview ? overviewView(overview) : null;

  return (
    <section aria-labelledby="teams-heading" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="teams-heading" className="text-xl font-semibold text-slate-900">
          Teams
        </h2>
        <button
          type="button"
          onClick={refresh}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          Refresh
        </button>
      </div>

      {problem && <p className="mt-3 text-sm text-red-800">{problem}</p>}
      {!problem && !page && <p className="mt-3 text-sm text-slate-600">Loading…</p>}
      {page && !page.ok && <p className="mt-3 text-sm text-red-800">{page.message}</p>}
      {page?.ok && (
        <>
          <p className="mt-2 text-sm text-slate-700">
            {page.headline}
            {page.updatedLabel && <span className="ml-2 text-xs text-slate-600">{page.updatedLabel}</span>}
          </p>
          <div className="mt-4 grid gap-3">
            {page.teams.map((view) => (
              <Team key={view.team || view.title} view={view} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
