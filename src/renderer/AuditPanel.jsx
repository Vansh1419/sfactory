import { useState } from 'react';
import { auditRowsView, searchFormView } from './audit.mjs';

// The Audit log page (PLAN.md step 4.3): every action anyone took, searchable by words, an action's name, who did it, which project and how long ago. What the form
// sends and how each row reads is decided by audit.mjs (graded by the `audit-search` eval); this file only draws it, and every text is shown as text, never as
// markup. A search runs only when the founder asks (there is no timer: every call to the runtime is itself written to the audit log).

const FIELD = 'w-full rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-900';
const BUTTON = 'rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50';
const FAILED = 'The search could not be done.';

export default function AuditPanel({ ready }) {
  const [form, setForm] = useState({ text: '', action: '', who: '', hours: '' });
  const [result, setResult] = useState(null); // { rows, more, note }
  const [lastId, setLastId] = useState(null);
  const [lastArgs, setLastArgs] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (args, { append }) => {
    setBusy(true);
    try {
      const answer = await window.api.audit.search(args);
      if (!answer.ok) {
        setProblem(answer.error?.message ?? FAILED);
        return;
      }
      const view = auditRowsView(answer.data);
      setProblem(null);
      setResult((old) => (append && old ? { ...view, rows: [...old.rows, ...view.rows] } : view));
      setLastId(view.rows.length > 0 ? view.rows[view.rows.length - 1].id : null);
    } catch {
      setProblem(FAILED);
    } finally {
      setBusy(false);
    }
  };

  const search = async (event) => {
    event.preventDefault();
    const checked = searchFormView(form);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    setLastArgs(checked.args);
    await run({ ...checked.args, limit: 50 }, { append: false });
  };

  if (!ready) return null;

  return (
    <section aria-labelledby="audit-heading" className="mt-8">
      <h2 id="audit-heading" className="text-xl font-semibold text-slate-900">Audit log</h2>
      <p className="mt-1 text-sm text-slate-600">Everything that was done, newest first. Leave the boxes empty to see the latest.</p>

      <form onSubmit={search} className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-4" aria-label="Search the audit log">
        <label className="text-sm text-slate-700 sm:col-span-2">
          Words (all of them must appear)
          <input className={FIELD} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} maxLength={200} placeholder="for example: git.push_branch Dev" />
        </label>
        <label className="text-sm text-slate-700">
          Action name (exact)
          <input className={FIELD} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} maxLength={100} placeholder="decision.created" />
        </label>
        <label className="text-sm text-slate-700">
          Who
          <select className={FIELD} value={form.who} onChange={(e) => setForm({ ...form, who: e.target.value })}>
            <option value="">Anyone</option>
            <option value="founder">The founder</option>
            <option value="agent">An agent</option>
            <option value="system">The system</option>
          </select>
        </label>
        <label className="text-sm text-slate-700">
          Only the last (hours)
          <input className={FIELD} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} inputMode="numeric" maxLength={5} placeholder="24" />
        </label>
        <div className="sm:col-span-3 flex items-end">
          <button type="submit" disabled={busy} className={BUTTON}>Search</button>
        </div>
      </form>

      {problem && <p className="mt-3 text-sm text-red-800">{problem}</p>}

      {result && (
        <div className="mt-3">
          {result.rows.length === 0 ? <p className="text-sm text-slate-600">Nothing matches.</p> : (
            <ul className="grid gap-1.5" aria-label="Audit entries">
              {result.rows.map((row) => (
                <li key={row.id} className="rounded border border-slate-200 bg-white p-2 text-sm">
                  <span className="font-medium text-slate-900">{row.action}</span>
                  <span className="ml-2 text-xs text-slate-600">{`${row.who} · ${row.when}`}</span>
                  {row.summary && <p className="mt-0.5 break-words text-slate-700">{row.summary}</p>}
                </li>
              ))}
            </ul>
          )}
          {result.note && <p className="mt-2 text-xs text-slate-500">{result.note}</p>}
          {result.more && lastId !== null && (
            <button type="button" disabled={busy} className={`${BUTTON} mt-2`} onClick={() => run({ ...lastArgs, before: lastId, limit: 50 }, { append: true })}>Show older entries</button>
          )}
        </div>
      )}
    </section>
  );
}
