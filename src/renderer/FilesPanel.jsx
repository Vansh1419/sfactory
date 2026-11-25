import { useCallback, useEffect, useState } from 'react';
import { historyView, shouldRefetch, sizeLabel, treeView } from './files.mjs';

// The project view's files panel (PLAN.md step 3.6): a project's file tree and history, read from its own folder and git history, with open, edit and
// upload. Opening a file for editing locks it for agents (their writes to it are refused until the founder saves or closes it); a save is a commit by
// the founder. What each part shows is decided by files.mjs (graded by the `pod-files` eval); this file only draws it, and every text is shown as text,
// never as markup. It reloads when the runtime announces `pod.file_changed` for the open project and when the founder presses Refresh: there is no
// timer, because every call to the runtime is written to the audit log.

const BUTTON = 'rounded border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50';
const FAILED = 'That could not be done.';

function Tree({ nodes, open, onOpen }) {
  return (
    <ul className="ml-3 border-l border-slate-200 pl-2">
      {nodes.map((node) => (
        <li key={`${node.kind}:${node.path}`} className="text-sm">
          {node.kind === 'folder' ? (
            <>
              <span className="font-medium text-slate-700">{node.name}/</span>
              <Tree nodes={node.children} open={open} onOpen={onOpen} />
            </>
          ) : (
            <button type="button" onClick={() => onOpen(node.path)} className={`text-left hover:underline ${open === node.path ? 'font-semibold text-blue-900' : 'text-slate-900'}`}>
              {node.name} <span className="text-xs text-slate-500">{sizeLabel(node.size)}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function FilesPanel({ ready }) {
  const [pods, setPods] = useState([]);
  const [podId, setPodId] = useState('');
  const [files, setFiles] = useState([]);
  const [commits, setCommits] = useState([]);
  const [current, setCurrent] = useState(null); // { path, content, editing }
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState(null); // { tone, text }
  const [busy, setBusy] = useState(false);

  const say = (tone, text) => setMessage({ tone, text });
  const failure = (result) => say('error', result?.error?.message ?? FAILED);

  const loadProject = useCallback(async (id) => {
    if (!id) return;
    const [tree, history] = await Promise.all([window.api.files.tree({ podId: id }), window.api.files.history({ podId: id, limit: 30 })]);
    if (tree.ok) setFiles(tree.data.files);
    else failure(tree);
    if (history.ok) setCommits(history.data.commits);
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.api.files.pods().then((result) => {
      if (result.ok) {
        setPods(result.data.pods);
        setPodId((now) => now || result.data.pods[0]?.id || '');
      } else failure(result);
    }).catch(() => say('error', FAILED));
  }, [ready]);

  useEffect(() => {
    setCurrent(null);
    setFiles([]);
    setCommits([]);
    loadProject(podId).catch(() => say('error', FAILED));
  }, [podId, loadProject]);

  useEffect(() => window.api.onEvent((event) => {
    if (shouldRefetch(event, podId)) loadProject(podId).catch(() => say('error', FAILED));
  }), [podId, loadProject]);

  async function openFile(file) {
    const result = await window.api.files.read({ podId, path: file });
    if (!result.ok) return failure(result);
    setMessage(null);
    setCurrent({ path: result.data.path, content: result.data.content, editing: false });
    setDraft(result.data.content);
    setNote('');
  }

  async function startEditing() {
    setBusy(true);
    const result = await window.api.files.beginEdit({ podId, path: current.path });
    setBusy(false);
    if (!result.ok) return failure(result);
    setCurrent({ ...current, editing: true });
    say('info', 'You are editing this file. Agents cannot change it until you save or cancel.');
  }

  async function stopEditing() {
    await window.api.files.endEdit({ podId, path: current.path });
    setDraft(current.content);
    setCurrent({ ...current, editing: false });
    setMessage(null);
  }

  async function save() {
    setBusy(true);
    const result = await window.api.files.save({ podId, path: current.path, content: draft, ...(note.trim() ? { message: note.trim() } : {}) });
    setBusy(false);
    if (!result.ok) return failure(result);
    setCurrent({ path: current.path, content: draft, editing: false });
    setNote('');
    say('ok', 'Saved and added to the history.');
    loadProject(podId).catch(() => {});
  }

  async function upload(event) {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    setBusy(true);
    try {
      const content = await picked.text();
      const result = await window.api.files.upload({ podId, path: picked.name, content });
      if (result.ok) {
        say('ok', `Added ${result.data.path} to the project.`);
        loadProject(podId).catch(() => {});
      } else failure(result);
    } catch {
      say('error', FAILED);
    }
    setBusy(false);
  }

  if (!ready) return null;
  const rows = historyView(commits);

  return (
    <section aria-labelledby="files-heading" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="files-heading" className="text-xl font-semibold text-slate-900">Project files</h2>
        <div className="flex items-center gap-2">
          <select aria-label="Project" value={podId} onChange={(e) => setPodId(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 text-sm">
            {pods.length === 0 && <option value="">No projects yet</option>}
            {pods.map((p) => <option key={p.id} value={p.id}>{`${p.name} (${p.priority})`}</option>)}
          </select>
          <button type="button" className={BUTTON} onClick={() => loadProject(podId).catch(() => say('error', FAILED))}>Refresh</button>
          <label className={`${BUTTON} cursor-pointer`}>
            Upload a text file
            <input type="file" className="sr-only" onChange={upload} disabled={!podId || busy} />
          </label>
        </div>
      </div>

      {message && <p className={`mt-3 text-sm ${message.tone === 'error' ? 'text-red-800' : message.tone === 'ok' ? 'text-green-800' : 'text-slate-700'}`}>{message.text}</p>}

      {podId && (
        <div className="mt-4 grid gap-4 sm:grid-cols-[14rem_1fr]">
          <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm" aria-label="Files">
            {files.length === 0 ? <p className="text-sm text-slate-600">No files yet.</p> : <Tree nodes={treeView(files)} open={current?.path} onOpen={(f) => openFile(f).catch(() => say('error', FAILED))} />}
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm" aria-label="File">
            {!current && <p className="text-sm text-slate-600">Pick a file to read it.</p>}
            {current && (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">{current.path}</h3>
                  {!current.editing && <button type="button" className={BUTTON} disabled={busy} onClick={() => startEditing().catch(() => say('error', FAILED))}>Edit</button>}
                </div>
                {current.editing ? (
                  <>
                    <textarea aria-label="File text" value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} className="mt-2 w-full rounded border border-slate-300 p-2 font-mono text-xs" />
                    <input aria-label="What changed" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="What changed? (optional)" className="mt-2 w-full rounded border border-slate-300 p-2 text-sm" />
                    <div className="mt-2 flex gap-2">
                      <button type="button" className={BUTTON} disabled={busy} onClick={() => save().catch(() => say('error', FAILED))}>Save</button>
                      <button type="button" className={BUTTON} disabled={busy} onClick={() => stopEditing().catch(() => say('error', FAILED))}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-xs text-slate-900">{current.content}</pre>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {podId && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm" aria-label="History">
          <h3 className="text-sm font-semibold text-slate-900">History</h3>
          {rows.length === 0 ? <p className="mt-1 text-sm text-slate-600">Nothing saved yet.</p> : (
            <ul className="mt-1 space-y-1 text-sm text-slate-800">
              {rows.map((row) => <li key={row.id}>{`${row.message} — ${row.who}, ${row.when}`}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
