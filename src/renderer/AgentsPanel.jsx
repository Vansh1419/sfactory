import { useCallback, useEffect, useRef, useState } from 'react';
import { agentsView, applyAgentEvent, feedView, shouldRefetch } from './agents.mjs';

// The agents panel and live feed (PLAN.md step 3.7): every agent with its role, status and current task; pick one to see each step it takes as it takes
// it, pause or resume it, type it a note and move one of its waiting tasks to a colleague. What each part says is decided by agents.mjs (graded by the
// `agents-panel` eval); this file only draws it, and every text is shown as text, never as markup. The feed is pushed by the runtime as `agent.event`
// (and is read once, from `agents.events`, when an agent is opened); the list reloads when the runtime announces `tasks.changed`, on focus and from
// the Refresh button. There is no timer: every call to the runtime is written to the audit log.

const FETCH_DELAY_MS = 150; // several announcements arriving together cause one fetch
const FAILED = 'That could not be done.';
const BUTTON = 'rounded border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50';
const CHIP = { active: 'bg-blue-100 text-blue-900', waiting: 'bg-amber-100 text-amber-900', ok: 'bg-green-100 text-green-900', problem: 'bg-red-100 text-red-900', neutral: 'bg-slate-100 text-slate-800' };

export default function AgentsPanel({ ready }) {
  const [agents, setAgents] = useState([]);
  const [openId, setOpenId] = useState('');
  const [feed, setFeed] = useState([]);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState(null); // { tone, text }
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const open = agents.find((a) => a.id === openId) ?? null;

  const say = (tone, text) => setMessage({ tone, text });
  const failure = (result) => say('error', result?.error?.message ?? FAILED);

  const load = useCallback(async () => {
    const result = await window.api.agents.list();
    if (result.ok) setAgents(agentsView(result.data));
    else say('error', result.error?.message ?? FAILED);
  }, []);

  const loadSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load().catch(() => say('error', FAILED)), FETCH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    if (ready) load().catch(() => say('error', FAILED));
  }, [ready, load]);

  useEffect(() => {
    const unsubscribe = window.api.onEvent((event) => {
      if (shouldRefetch(event)) loadSoon();
      setFeed((lines) => applyAgentEvent(lines, event, openId));
    });
    const onFocus = () => loadSoon();
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      clearTimeout(timer.current);
    };
  }, [openId, loadSoon]);

  useEffect(() => {
    setFeed([]);
    if (!openId) return;
    window.api.agents.events({ agentId: openId, limit: 50 }).then((result) => {
      if (result.ok) setFeed(result.data.events);
    }).catch(() => say('error', FAILED));
  }, [openId]);

  async function act(work, done) {
    setBusy(true);
    try {
      const result = await work();
      if (result.ok) {
        if (done) say('ok', done);
        await load();
      } else failure(result);
      return result.ok;
    } catch {
      say('error', FAILED);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const togglePause = () => act(() => window.api.agents.pause({ agentId: open.id, paused: open.pauseLabel === 'Pause' }), open.pauseLabel === 'Pause' ? `${open.name} is paused. It stops at its next step.` : `${open.name} can work again.`);
  const send = async () => {
    if (await act(() => window.api.agents.message({ agentId: open.id, text: note }), `${open.name} will read your note at its next step.`)) setNote('');
  };
  const move = (taskId, agentId) => act(() => window.api.agents.reassign({ taskId, agentId }), 'The task was moved.');

  if (!ready) return null;
  const lines = feedView(feed);
  const colleagues = open ? agents.filter((a) => a.id !== open.id && a.team === open.team && (a.role === 'worker' || a.role === 'specialist') && a.shared === open.shared && a.status !== 'paused') : [];

  return (
    <section aria-labelledby="agents-heading" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="agents-heading" className="text-xl font-semibold text-slate-900">Agents</h2>
        <button type="button" className={BUTTON} onClick={() => loadSoon()}>Refresh</button>
      </div>
      {message && <p className={`mt-3 text-sm ${message.tone === 'error' ? 'text-red-800' : message.tone === 'ok' ? 'text-green-800' : 'text-slate-700'}`}>{message.text}</p>}

      <div className="mt-4 grid gap-4 sm:grid-cols-[18rem_1fr]">
        <ul className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm" aria-label="Agents">
          {agents.length === 0 && <li className="p-2 text-sm text-slate-600">No agents yet.</li>}
          {agents.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setOpenId(a.id)} className={`w-full rounded p-2 text-left hover:bg-slate-50 ${a.id === openId ? 'bg-slate-100' : ''}`}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-slate-900">{a.name}</span>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${CHIP[a.status.tone]}`}>{a.status.label}</span>
                </span>
                <span className="block text-xs text-slate-600">{`${a.roleLabel}${a.teamLabel ? `, ${a.teamLabel}` : ''}`}</span>
                <span className="block text-xs text-slate-700">{a.taskLine}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm" aria-label="Agent">
          {!open && <p className="text-sm text-slate-600">Pick an agent to see what it is doing, step by step.</p>}
          {open && (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">{`${open.name} · ${open.roleLabel}`}</h3>
                <button type="button" className={BUTTON} disabled={busy} onClick={togglePause}>{open.pauseLabel}</button>
              </div>

              {open.canMessage && (
                <div className="mt-3">
                  <textarea aria-label="Note to the agent" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder={`Write to ${open.name}. It reads this at its next step.`} className="w-full rounded border border-slate-300 p-2 text-sm" />
                  <div className="mt-1 flex items-center gap-2">
                    <button type="button" className={BUTTON} disabled={busy || note.trim() === ''} onClick={send}>Send note</button>
                    {open.pending > 0 && <span className="text-xs text-slate-600">{`${open.pending} waiting to be read`}</span>}
                  </div>
                </div>
              )}

              {open.waiting.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-xs font-semibold uppercase text-slate-500">Waiting tasks</h4>
                  <ul className="mt-1 space-y-1">
                    {open.waiting.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-800">
                        <span>{`${t.title}${t.blocked ? ' (blocked)' : ''}`}</span>
                        {colleagues.length > 0 && (
                          <select aria-label={`Move ${t.title} to`} defaultValue="" disabled={busy} onChange={(e) => e.target.value && move(t.id, e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                            <option value="">Move to…</option>
                            {colleagues.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <h4 className="mt-4 text-xs font-semibold uppercase text-slate-500">Live feed</h4>
              {lines.length === 0 ? <p className="mt-1 text-sm text-slate-600">Nothing yet.</p> : (
                <ul className="mt-1 max-h-72 space-y-1 overflow-auto text-sm" aria-live="polite">
                  {lines.map((l) => (
                    <li key={l.id} className="flex gap-2">
                      <span className={`h-fit rounded px-1.5 py-0.5 text-xs font-medium ${CHIP[l.tone]}`}>{l.label}</span>
                      <span className="text-slate-900">{l.summary}</span>
                      <span className="ml-auto whitespace-nowrap text-xs text-slate-500">{l.when}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
