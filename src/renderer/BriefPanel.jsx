import { useCallback, useEffect, useRef, useState } from 'react';

// The daily brief (PLAN.md step 2.6): what the founder should know this morning. It draws ONLY the lines the runtime's `brief.get` gives: the very
// lines Telegram's /brief and the morning digest are built from, so the phone and this window cannot disagree. There is no wording written here.
// It loads when the window opens, when the runtime announces something that changes the brief (a decision, a task), when the window gets focus and
// when the founder presses Refresh. There is no timer: every call to the runtime is written to the audit log.
// All text is shown as text, never as markup (a lead's name comes from the outside world).

const FETCH_DELAY_MS = 150; // several announcements arriving together cause one fetch
const CHANGES_THE_BRIEF = new Set(['tasks.changed', 'decision.created', 'decision.resolved', 'runtime.ready']);

function useBrief(ready) {
  const [brief, setBrief] = useState(null);
  const [problem, setProblem] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    const result = await window.api.brief.get();
    if (!result.ok) {
      setProblem(result.error.message);
      return;
    }
    setProblem(null);
    setBrief(result.data);
  }, []);

  const loadSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load().catch(() => setProblem('The brief could not be loaded.')), FETCH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    if (ready) load().catch(() => setProblem('The brief could not be loaded.'));
  }, [ready, load]);

  useEffect(() => {
    const unsubscribe = window.api.onEvent((event) => {
      if (CHANGES_THE_BRIEF.has(event?.type)) loadSoon();
    });
    const onFocus = () => loadSoon();
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      clearTimeout(timer.current);
    };
  }, [loadSoon]);

  return { brief, problem, refresh: loadSoon };
}

export default function BriefPanel({ ready }) {
  const { brief, problem, refresh } = useBrief(ready);
  if (!ready) return null;

  const sections = Array.isArray(brief?.sections) ? brief.sections : [];

  return (
    <section aria-labelledby="brief-heading" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="brief-heading" className="text-xl font-semibold text-slate-900">
          Today&apos;s brief
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
      {!problem && !brief && <p className="mt-3 text-sm text-slate-600">Loading…</p>}
      {brief && <p className="mt-2 text-sm text-slate-700">{typeof brief.headline === 'string' ? brief.headline : ''}</p>}

      {brief && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {sections.map((section) => (
            <article key={section.key} className={`rounded-lg border p-4 ${section.available ? 'border-slate-200 bg-white shadow-sm' : 'border-slate-200 bg-slate-50'}`} aria-label={section.title}>
              <h3 className="text-sm font-semibold text-slate-900">{section.title}</h3>
              <ul className="mt-1 grid gap-1">
                {(Array.isArray(section.lines) ? section.lines : []).map((line, i) => (
                  <li key={i} className={`text-sm ${section.available ? 'text-slate-800' : 'text-slate-600'}`}>
                    {line}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
