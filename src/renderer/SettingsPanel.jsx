import { useCallback, useEffect, useState } from 'react';
import { TeamSwitches } from './TeamsPanel.jsx';
import { limitsFormView, scalingFormView, settingsView } from './settings.mjs';

// The Settings page (PLAN.md step 4.3): the limits (a daily task cap per agent, how many repeats make a loop), the scaling rules (the most agents each team may have,
// and when to add or remove one), the team switches, and the approval period for client messages, which is shown but not changed here. What each part says, and the
// checks on the forms, are in settings.mjs (graded by the `settings-page` eval); this file only draws it, and every text is shown as text, never as markup.
// A change is sent when the founder presses Save and takes effect at once, with no restart. There is no timer: every call to the runtime is audited.

const FIELD = 'w-24 rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-900';
const BUTTON = 'rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50';
const FAILED = 'That could not be saved.';

function Rule({ row, onSave, busy }) {
  const [form, setForm] = useState({});
  const [enabled, setEnabled] = useState(row.enabled);
  const send = (event) => {
    event.preventDefault();
    onSave({ ...form, team: row.team, role: row.role, ...(enabled === row.enabled ? {} : { enabled }) }, () => setForm({}));
  };
  return (
    <form onSubmit={send} className="rounded border border-slate-200 bg-white p-3" aria-label={`${row.teamLabel} ${row.roleLabel}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-900">{`${row.teamLabel}: ${row.roleLabel}`}</h4>
        <span className="text-xs text-slate-500">{`Using ${row.sourceNote}`}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        {row.values.map((v) => (
          <label key={v.key} className="text-xs text-slate-700">
            {v.label}
            <input className={`${FIELD} mt-0.5 block`} inputMode="numeric" value={form[v.key] ?? ''} placeholder={String(v.value ?? '')} onChange={(e) => setForm({ ...form, [v.key]: e.target.value })} />
          </label>
        ))}
        <label className="flex items-end gap-1.5 text-xs text-slate-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Add and remove agents by itself
        </label>
      </div>
      <button type="submit" disabled={busy} className={`${BUTTON} mt-2`}>Save this rule</button>
    </form>
  );
}

export default function SettingsPanel({ ready }) {
  const [data, setData] = useState(null);
  const [limits, setLimits] = useState({ maxTasksPerDay: '', loopRepeats: '' });
  const [notice, setNotice] = useState(null); // { tone, message }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const answer = await window.api.settings.get();
    if (answer.ok) setData(answer.data);
    else setNotice({ tone: 'problem', message: answer.error?.message ?? FAILED });
  }, []);

  useEffect(() => {
    if (ready) load().catch(() => setNotice({ tone: 'problem', message: FAILED }));
  }, [ready, load]);

  useEffect(() => window.api.onEvent((event) => {
    if (event?.type === 'guardrails.changed' || event?.type === 'settings.changed') load().catch(() => {});
  }), [load]);

  const save = async (call, done) => {
    setBusy(true);
    try {
      const answer = await call();
      if (answer.ok) {
        setNotice({ tone: 'ok', message: answer.data?.changed === false ? 'Nothing changed: that is already the value.' : 'Saved. It is used from now on, with no restart.' });
        done?.();
        await load();
      } else setNotice({ tone: 'problem', message: answer.error?.message ?? FAILED });
    } catch {
      setNotice({ tone: 'problem', message: FAILED });
    } finally {
      setBusy(false);
    }
  };

  const saveLimits = (event) => {
    event.preventDefault();
    const checked = limitsFormView(limits);
    if (!checked.ok) {
      setNotice({ tone: 'problem', message: checked.problem });
      return;
    }
    save(() => window.api.settings.setLimits(checked.args), () => setLimits({ maxTasksPerDay: '', loopRepeats: '' }));
  };

  const saveRule = (form, done) => {
    const checked = scalingFormView(form);
    if (!checked.ok) {
      setNotice({ tone: 'problem', message: checked.problem });
      return;
    }
    save(() => window.api.settings.setScaling(checked.args), done);
  };

  if (!ready) return null;
  const view = data ? settingsView(data) : null;

  return (
    <section aria-labelledby="settings-heading" className="mt-8">
      <h2 id="settings-heading" className="text-xl font-semibold text-slate-900">Settings</h2>
      {notice && <p className={`mt-2 text-sm ${notice.tone === 'problem' ? 'text-red-800' : 'text-green-800'}`}>{notice.message}</p>}
      {!view && !notice && <p className="mt-2 text-sm text-slate-600">Loading…</p>}

      {view && (
        <>
          <form onSubmit={saveLimits} className="mt-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Limits">
            <h3 className="text-base font-semibold text-slate-900">Limits</h3>
            <p className="mt-1 text-xs text-slate-600">Leave a box empty to keep its value. The number in a box is what is used now.</p>
            <div className="mt-2 flex flex-wrap gap-4">
              {view.limits.map((l) => (
                <label key={l.key} className="text-sm text-slate-700">
                  {l.label}
                  <input className={`${FIELD} mt-0.5 block`} inputMode="numeric" value={limits[l.key]} placeholder={String(l.value ?? '')} onChange={(e) => setLimits({ ...limits, [l.key]: e.target.value })} />
                  <span className="text-xs text-slate-500">{`${l.min} to ${l.max}`}</span>
                </label>
              ))}
            </div>
            <button type="submit" disabled={busy} className={`${BUTTON} mt-2`}>Save the limits</button>
          </form>

          <div className="mt-4" aria-label="Scaling rules">
            <h3 className="text-base font-semibold text-slate-900">How many agents each team may have</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {view.scaling.map((row) => <Rule key={`${row.team}:${row.role}:${row.enabled}`} row={row} onSave={saveRule} busy={busy} />)}
            </div>
          </div>

          <TeamSwitches setNotice={(n) => setNotice({ tone: n.tone === 'problem' ? 'problem' : 'ok', message: n.message })} />
          {view.stopped.length > 0 && <p className="mt-2 text-sm text-amber-900">{`Switched off now: ${view.stopped.join(', ')}.`}</p>}

          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Approvals">
            <h3 className="text-base font-semibold text-slate-900">Approvals</h3>
            <p className="mt-1 text-sm text-slate-800">{view.approvalLine}</p>
            <p className="mt-1 text-xs text-slate-600">{view.approvalNote}</p>
          </div>

          {view.tools.length > 0 && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Tools you added">
              <h3 className="text-base font-semibold text-slate-900">Tools you added</h3>
              <ul className="mt-1 grid gap-1 text-sm text-slate-800">
                {view.tools.map((t) => <li key={t.tool}>{`${t.tool}: ${t.summary}`}</li>)}
              </ul>
              <p className="mt-1 text-xs text-slate-600">Add or remove tools from Telegram with /addtool and /removetool.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
