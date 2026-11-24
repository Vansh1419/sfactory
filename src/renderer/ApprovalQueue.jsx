import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ageLabel, answerArgs, applyEvent, cardView, describeAnswer, mergeLists } from './queue.mjs';

// The approval queue (PLAN.md step 1.9): the cards waiting for the founder, in the 7-field format.
// What each card shows and what an answer means is decided by queue.mjs (graded by the `approval-queue`
// eval); this file only draws it and talks to `window.api`. All text is shown as text, never as markup.

const FETCH_DELAY_MS = 150; // several new decisions arriving together cause one fetch

// What the queue shows: cards waiting for an answer, and cards the founder asked a question about
// (those can still be approved or rejected once the question is answered).
const STATUSES_SHOWN = ['pending', 'info_requested'];

const RISK_STYLES = {
  low: 'bg-green-100 text-green-900',
  medium: 'bg-amber-100 text-amber-900',
  high: 'bg-red-100 text-red-900',
  unknown: 'bg-slate-100 text-slate-800',
};

const MESSAGE_STYLES = {
  ok: 'text-green-800',
  info: 'text-slate-700',
  error: 'text-red-800',
};

/** The waiting cards, kept live by the runtime's events instead of by polling. */
function useQueue(ready) {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState(null);
  const rowsRef = useRef([]);
  const removedDuringFetch = useRef(new Set());
  const fetchTimer = useRef(null);

  const store = useCallback((next) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  const load = useCallback(async () => {
    removedDuringFetch.current = new Set();
    // One read per status shown (these are reads only: the screen never writes a decision's status itself).
    const answers = await Promise.all(STATUSES_SHOWN.map((status) => window.api.decisions.list({ status })));
    const failed = answers.find((r) => !r.ok);
    if (failed) {
      setProblem(failed.error.message);
      return;
    }
    setProblem(null);
    // A card that an event removed while this was loading must not come back.
    const merged = mergeLists(...answers.map((r) => r.data.decisions)).filter((r) => !removedDuringFetch.current.has(r.id));
    store(merged);
    setLoaded(true);
  }, [store]);

  const loadSoon = useCallback(() => {
    clearTimeout(fetchTimer.current);
    fetchTimer.current = setTimeout(() => load().catch(() => setProblem('The queue could not be loaded.')), FETCH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    if (ready) load().catch(() => setProblem('The queue could not be loaded.'));
  }, [ready, load]);

  useEffect(() => {
    const unsubscribe = window.api.onEvent((event) => {
      const out = applyEvent(rowsRef.current, event);
      if (out.rows !== rowsRef.current) {
        for (const gone of rowsRef.current.filter((r) => !out.rows.some((n) => n.id === r.id))) removedDuringFetch.current.add(gone.id);
        store(out.rows);
      }
      if (out.refetch) loadSoon();
    });
    return () => {
      unsubscribe();
      clearTimeout(fetchTimer.current);
    };
  }, [store, loadSoon]);

  const apply = useCallback((event) => {
    const out = applyEvent(rowsRef.current, event);
    if (out.rows !== rowsRef.current) store(out.rows);
  }, [store]);

  return { rows, loaded, problem, apply };
}

function Field({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

function Card({ row, busy, message, onAnswer }) {
  const view = cardView(row);
  const [showDetails, setShowDetails] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const noteId = `note-${view.id}`;
  const age = ageLabel(view.createdAt);

  const sendQuestion = async () => {
    const done = await onAnswer(view.id, 'info_requested', note);
    if (done) {
      setAsking(false);
      setNote('');
    }
  };

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm" aria-labelledby={`title-${view.id}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
        <span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-800">{view.categoryLabel}</span>
        {view.statusLabel && view.status !== 'pending' && <span className="font-medium text-amber-800">{view.statusLabel}</span>}
        {age && <span>{age}</span>}
      </header>

      <h3 id={`title-${view.id}`} className="mt-2 text-lg font-semibold text-slate-900">
        {view.title || 'A decision is waiting'}
      </h3>

      {view.note && (
        <p role="note" className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          {view.note}
        </p>
      )}

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Why now">{view.whyNow}</Field>
        <Field label="Cost">{view.cost}</Field>
        <Field label="If you approve">{view.ifYes}</Field>
        <Field label="If you reject">{view.ifNo}</Field>
        <Field label="Risk">
          <span className={`mr-2 inline-block rounded px-2 py-0.5 text-xs font-semibold ${RISK_STYLES[view.risk.tone]}`}>
            {view.risk.level ? `${view.risk.level} risk` : 'Risk not stated'}
          </span>
          {view.risk.reason}
        </Field>
        <Field label="My recommendation">{view.recommendation}</Field>
      </dl>

      {view.details && (
        <div className="mt-4">
          <button
            type="button"
            className="text-sm font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            aria-expanded={showDetails}
            aria-controls={`details-${view.id}`}
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
          {showDetails && (
            <div id={`details-${view.id}`} className="mt-2 rounded bg-slate-50 p-3 text-sm text-slate-800">
              <p className="whitespace-pre-wrap">{view.details}</p>
              {view.tool && <p className="mt-2 text-xs text-slate-600">Tool: {view.tool}</p>}
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => onAnswer(view.id, 'approved')} className="rounded bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-900 disabled:opacity-50">
          Approve
        </button>
        <button type="button" disabled={busy} onClick={() => onAnswer(view.id, 'rejected')} className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-900 disabled:opacity-50">
          Reject
        </button>
        {view.canAskMore && (
          <button type="button" disabled={busy} aria-expanded={asking} onClick={() => setAsking((v) => !v)} className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50">
            Ask more
          </button>
        )}
      </div>

      {asking && (
        <div className="mt-3">
          <label htmlFor={noteId} className="block text-sm font-medium text-slate-800">
            Your question (optional)
          </label>
          <textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} className="mt-1 w-full rounded border border-slate-300 p-2 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-slate-900" />
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={sendQuestion} className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50">
              Send question
            </button>
            <button type="button" onClick={() => setAsking(false)} className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <p role="status" className={`mt-3 text-sm ${MESSAGE_STYLES[message.tone]}`}>
          {message.text}
        </p>
      )}
    </article>
  );
}

export default function ApprovalQueue({ ready }) {
  const { rows, loaded, problem, apply } = useQueue(ready);
  const [busy, setBusy] = useState(() => new Set());
  const [messages, setMessages] = useState({});
  const [announcement, setAnnouncement] = useState('');

  const say = useCallback((id, message) => setMessages((m) => ({ ...m, [id]: message })), []);

  /** Returns true when the answer was accepted, so a question box can close. */
  const answer = useCallback(
    async (id, decision, note) => {
      const built = answerArgs({ id, decision, note });
      if (!built.ok) {
        say(id, { tone: 'error', text: built.problem });
        return false;
      }
      setBusy((b) => new Set(b).add(id));
      try {
        const result = await window.api.decisions.resolve(built.args);
        const outcome = describeAnswer(result);
        say(id, { tone: outcome.tone, text: outcome.text });
        setAnnouncement(outcome.text);
        if (outcome.tone !== 'error') {
          // The runtime also announces this answer as an event; applying it here too is harmless and instant.
          apply({ type: 'decision.resolved', data: { id, status: result.data.status } });
        }
        return outcome.tone !== 'error';
      } catch {
        say(id, { tone: 'error', text: 'Something went wrong and nothing was changed. You can try again.' });
        return false;
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(id);
          return next;
        });
      }
    },
    [apply, say],
  );

  const count = rows.length;
  const heading = useMemo(() => (count === 0 ? 'Waiting for you' : `Waiting for you (${count})`), [count]);

  if (!ready) return null;

  return (
    <section aria-labelledby="queue-heading" className="mt-8">
      <h2 id="queue-heading" className="text-xl font-semibold text-slate-900">
        {heading}
      </h2>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      {problem && <p className="mt-3 text-sm text-red-800">{problem}</p>}
      {!problem && !loaded && <p className="mt-3 text-sm text-slate-600">Loading…</p>}
      {!problem && loaded && count === 0 && <p className="mt-3 text-sm text-slate-700">Nothing is waiting for you.</p>}

      <div className="mt-4 grid gap-4">
        {rows.map((row) => (
          <Card key={row.id} row={row} busy={busy.has(row.id)} message={messages[row.id]} onAnswer={answer} />
        ))}
      </div>
    </section>
  );
}
