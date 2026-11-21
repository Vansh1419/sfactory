// The renderer is sandboxed: it only sees what src/preload.js exposes on `window`.
export default function App() {
  const { node, chrome, electron } = window.versions;
  return (
    <main className="p-8">
      <h1 className="text-3xl font-semibold text-slate-900">sfactory</h1>
      <p id="info" className="mt-2 text-sm text-slate-600">
        {`Electron ${electron} · Chromium ${chrome} · Node ${node}`}
      </p>
    </main>
  );
}
