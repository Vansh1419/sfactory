import { useCallback, useEffect, useState } from 'react';

// The renderer is sandboxed: it only sees what src/preload.js exposes on `window`.

const DATABASE_MESSAGES = {
  ok: 'Connected',
  missing_table: 'Connected, but the database tables are missing. Apply the migrations (PLAN.md, step 1.1).',
  unauthorized: 'The database rejected the key. Check SUPABASE_SERVICE_ROLE_KEY in .env.',
  unreachable: 'Cannot reach the database. Check SUPABASE_URL and your internet connection.',
  not_configured: 'Not set up yet. Fill in the Supabase settings in .env.',
  error: 'The database returned an error.',
};

export default function App() {
  const { node, chrome, electron } = window.versions;
  const [status, setStatus] = useState(null);
  const [waiting, setWaiting] = useState(null);

  const refresh = useCallback(async () => {
    const s = await window.api.runtime.status();
    setStatus(s);
    if (s.ok && s.data.ready) {
      // Reading the queue is recorded in the audit log like any other action.
      const d = await window.api.decisions.list({});
      setWaiting(d.ok ? { count: d.data.decisions.length } : { problem: d.error.message });
    } else {
      setWaiting(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    return window.api.onEvent((event) => {
      if (event.type.startsWith('runtime.')) refresh();
    });
  }, [refresh]);

  const ready = status?.ok && status.data.ready;
  const database = status?.ok ? DATABASE_MESSAGES[status.data.database] ?? status.data.database : null;

  return (
    <main className="p-8">
      <h1 className="text-3xl font-semibold text-slate-900">sfactory</h1>
      <p id="info" className="mt-2 text-sm text-slate-600">
        {`Electron ${electron} · Chromium ${chrome} · Node ${node}`}
      </p>

      <section className="mt-8 max-w-xl rounded-lg border border-slate-200 p-4" aria-label="Runtime status">
        <h2 className="text-lg font-medium text-slate-900">Runtime</h2>
        {!status && <p className="mt-2 text-sm text-slate-600">Checking…</p>}
        {status && !status.ok && <p className="mt-2 text-sm text-red-700">{status.error.message}</p>}
        {status?.ok && (
          <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Status</dt>
            <dd className={ready ? 'text-green-700' : 'text-red-700'}>{ready ? 'Ready' : 'Not ready'}</dd>
            <dt className="text-slate-500">Database</dt>
            <dd className="text-slate-900">{database}</dd>
            {waiting?.count !== undefined && (
              <>
                <dt className="text-slate-500">Waiting for you</dt>
                <dd className="text-slate-900">{waiting.count === 0 ? 'Nothing' : `${waiting.count} decision${waiting.count === 1 ? '' : 's'}`}</dd>
              </>
            )}
          </dl>
        )}
        {status?.ok && status.data.problem && <p className="mt-3 text-sm text-red-700">{status.data.problem}</p>}
        {waiting?.problem && <p className="mt-3 text-sm text-red-700">{waiting.problem}</p>}
      </section>
    </main>
  );
}
