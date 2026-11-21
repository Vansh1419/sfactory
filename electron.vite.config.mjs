import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vite's dev server needs inline scripts (React refresh) and a websocket (HMR),
// which the strict production CSP in src/renderer/index.html forbids. This
// plugin relaxes the CSP in `electron-vite dev` only (apply: 'serve'); builds
// keep the strict policy from the HTML file untouched.
const devOnlyCsp = () => ({
  name: 'dev-only-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace(
      /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
      `$1default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*$2`,
    ),
});

export default defineConfig({
  // Entry points keep the paths from PLAN.md: src/main.js, src/preload.js.
  // Output: out/main/main.js, out/preload/preload.js, out/renderer/.
  main: {
    build: { lib: { entry: 'src/main.js' } },
  },
  preload: {
    build: { lib: { entry: 'src/preload.js' } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), devOnlyCsp()],
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
  },
});
