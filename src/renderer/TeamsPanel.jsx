import { useCallback, useEffect, useRef, useState } from 'react';
import { jobNotice, leadFormView, overviewView, shouldRefetch, taskFormView } from './teams.mjs';

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
  const [notice, setNotice] = useState(null); // what the last start or the last finished job said
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
      const ended = jobNotice(event);
      if (ended) setNotice(ended);
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

  return { overview, problem, notice, setNotice, refresh: loadSoon };
}

const FIELD = 'w-full rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-900';
const BUTTON = 'rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50';

const SWITCHES = [
  { team: 'product_engineering', label: 'Product and Engineering' },
  { team: 'marketing_sales', label: 'Marketing and Sales' },
  { team: 'support', label: 'Customer Support' },
  { team: 'finance_legal_ops', label: 'Finance, Legal and Ops' },
];

/** A kill switch for each team (step 4.2): a team that is switched off stops at its next step and takes no new work. The state comes from the runtime. */
function TeamSwitches({ setNotice }) {
  const [stopped, setStopped] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await window.api.guardrails.status();
    if (result.ok) setStopped(result.data.stoppedTeams);
  }, []);

  useEffect(() => {
    load().catch(() => {});
    return window.api.onEvent((event) => {
      if (event?.type === 'guardrails.changed') load().catch(() => {});
    });
  }, [load]);

  const flip = async (team, label) => {
    const stop = !stopped.includes(team);
    setBusy(true);
    try {
      const result = await window.api.guardrails.stopTeam({ team, stopped: stop });
      setNotice(result.ok
        ? { kind: 'start', message: stop ? `The ${label} team is switched off. Its agents stop at their next step.` : `The ${label} team is switched on again.`, tone: stop ? 'waiting' : 'ok' }
        : { kind: 'start', message: result.error.message, tone: 'problem' });
      await load();
    } catch {
      setNotice({ kind: 'start', message: 'That could not be done.', tone: 'problem' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Team switches">
      <h3 className="text-base font-semibold text-slate-900">Team switches</h3>
      <p className="mt-1 text-xs text-slate-600">Switch a team off to stop its agents at their next step and keep it from taking new work.</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {SWITCHES.map(({ team, label }) => {
          const off = stopped.includes(team);
          return (
            <li key={team}>
              <button type="button" disabled={busy} onClick={() => flip(team, label)} className={BUTTON} aria-pressed={off}>
                {off ? `Switch ${label} on` : `Switch ${label} off`}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Give the Finance, Legal and Ops team or the Engineering team a task. Engineering works inside one project, so it needs one; finance may have one. */
function TaskForms({ setNotice }) {
  const [projects, setProjects] = useState([]);
  const [finance, setFinance] = useState({ title: '', description: '', podId: '' });
  const [engineer, setEngineer] = useState({ title: '', description: '', podId: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.files.pods().then((result) => {
      if (result.ok) setProjects(result.data.pods);
    }).catch(() => {});
  }, []);

  const start = async (event, form, needsProject, run, reset) => {
    event.preventDefault();
    const checked = taskFormView(form, { needsProject });
    if (!checked.ok) {
      setNotice({ kind: 'start', message: checked.problem, tone: 'problem' });
      return;
    }
    setBusy(true);
    try {
      const result = await run(checked.args);
      setNotice(result.ok ? { kind: 'start', message: result.data.message, tone: 'active' } : { kind: 'start', message: result.error.message, tone: 'problem' });
      if (result.ok) reset();
    } catch {
      setNotice({ kind: 'start', message: 'That could not be started.', tone: 'problem' });
    } finally {
      setBusy(false);
    }
  };

  const picker = (form, setForm, optional) => (
    <label className="text-sm text-slate-700">
      {optional ? 'Project (optional)' : 'Project'}
      <select className={FIELD} value={form.podId} onChange={(e) => setForm({ ...form, podId: e.target.value })}>
        <option value="">{optional ? 'The company (no project)' : 'Pick a project'}</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{`${p.name} (${p.priority})`}</option>)}
      </select>
    </label>
  );

  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <form onSubmit={(e) => start(e, finance, false, (args) => window.api.teams.startFinance(args), () => setFinance({ title: '', description: '', podId: '' }))} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Finance task">
        <h3 className="text-base font-semibold text-slate-900">Finance, Legal and Ops task</h3>
        <p className="mt-1 text-xs text-slate-600">An invoice draft, an expense, a contract to read. Nothing is paid, signed or sent.</p>
        <label className="mt-2 block text-sm text-slate-700">
          What should it do?
          <input className={FIELD} value={finance.title} onChange={(e) => setFinance({ ...finance, title: e.target.value })} maxLength={200} />
        </label>
        <label className="mt-2 block text-sm text-slate-700">
          Details (optional)
          <textarea className={FIELD} rows={2} value={finance.description} onChange={(e) => setFinance({ ...finance, description: e.target.value })} maxLength={4000} />
        </label>
        <div className="mt-2">{picker(finance, setFinance, true)}</div>
        <button type="submit" disabled={busy} className={`${BUTTON} mt-2`}>Give the finance team this task</button>
      </form>

      <form onSubmit={(e) => start(e, engineer, true, (args) => window.api.teams.startEngineer(args), () => setEngineer({ title: '', description: '', podId: '' }))} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Engineering task">
        <h3 className="text-base font-semibold text-slate-900">Engineering task</h3>
        <p className="mt-1 text-xs text-slate-600">It works on a branch and opens a pull request. A merge or a deploy is always your decision.</p>
        <label className="mt-2 block text-sm text-slate-700">
          What should it do?
          <input className={FIELD} value={engineer.title} onChange={(e) => setEngineer({ ...engineer, title: e.target.value })} maxLength={200} />
        </label>
        <label className="mt-2 block text-sm text-slate-700">
          Details (optional)
          <textarea className={FIELD} rows={2} value={engineer.description} onChange={(e) => setEngineer({ ...engineer, description: e.target.value })} maxLength={4000} />
        </label>
        <div className="mt-2">{picker(engineer, setEngineer, false)}</div>
        <button type="submit" disabled={busy} className={`${BUTTON} mt-2`}>Give the engineering team this task</button>
      </form>
    </div>
  );
}

/** Start the sales team on a lead, or the support team on the oldest open ticket. A team takes minutes: this only starts it and says so. */
function StartWork({ setNotice }) {
  const [company, setCompany] = useState('');
  const [website, setWebsite] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const report = (result) => setNotice(result.ok ? { kind: 'start', message: result.data.message, tone: 'active' } : { kind: 'start', message: result.error.message, tone: 'problem' });

  const startLead = async (event) => {
    event.preventDefault();
    const form = leadFormView({ company, website, email });
    if (!form.ok) {
      setNotice({ kind: 'start', message: form.problem, tone: 'problem' });
      return;
    }
    setBusy(true);
    try {
      const result = await window.api.teams.startLead(form.args);
      report(result);
      if (result.ok) {
        setCompany('');
        setWebsite('');
        setEmail('');
      }
    } catch {
      setNotice({ kind: 'start', message: 'That could not be started.', tone: 'problem' });
    } finally {
      setBusy(false);
    }
  };

  const startTicket = async () => {
    setBusy(true);
    try {
      report(await window.api.teams.startTicket({}));
    } catch {
      setNotice({ kind: 'start', message: 'That could not be started.', tone: 'problem' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Start work">
      <h3 className="text-base font-semibold text-slate-900">Start work</h3>
      <form onSubmit={startLead} className="mt-2 grid gap-2 sm:grid-cols-3">
        <label className="text-sm text-slate-700">
          Company
          <input className={FIELD} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={200} />
        </label>
        <label className="text-sm text-slate-700">
          Their web address (optional)
          <input className={FIELD} value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={300} placeholder="https://" />
        </label>
        <label className="text-sm text-slate-700">
          Their email (optional)
          <input className={FIELD} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
        </label>
        <div className="sm:col-span-3 flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={BUTTON}>
            Give the sales team this lead
          </button>
          <button type="button" disabled={busy} onClick={startTicket} className={BUTTON}>
            Work the next open ticket
          </button>
        </div>
      </form>
    </div>
  );
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
  const { overview, problem, notice, setNotice, refresh } = useTeams(ready);
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

      <StartWork setNotice={setNotice} />

      <TaskForms setNotice={setNotice} />
      <TeamSwitches setNotice={setNotice} />
      {notice && (
        <p role="status" className={`mt-2 text-sm ${TEXT_STYLES[notice.tone] ?? TEXT_STYLES.neutral}`}>
          {notice.message}
        </p>
      )}

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
