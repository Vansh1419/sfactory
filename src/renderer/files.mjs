// The logic behind the project files panel (PLAN.md step 3.6). Plain functions, no React and no `window`, so they are graded directly by the `pod-files`
// eval; FilesPanel.jsx only draws what they return. Every text from a project (a file name, a commit note) is passed through as TEXT: the page never
// builds markup from it. Nothing here throws: an odd or missing field gives a safe default.

import { ageLabel } from './queue.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The runtime's flat list of files ({ path, size }) as nested folders: folders first, then files, each in name order.
 * A node is { kind: 'folder' | 'file', name, path, size?, children? }.
 */
export function treeView(files) {
  const root = { children: new Map() };
  for (const entry of Array.isArray(files) ? files : []) {
    const rel = isObject(entry) ? text(entry.path) : '';
    if (rel === '') continue;
    const parts = rel.split('/').filter((part) => part !== '');
    let here = root;
    parts.forEach((name, i) => {
      const last = i === parts.length - 1;
      const key = last ? `file:${name}` : `folder:${name}`;
      if (!here.children.has(key)) {
        here.children.set(key, last
          ? { kind: 'file', name, path: parts.join('/'), size: Number.isInteger(entry.size) && entry.size >= 0 ? entry.size : 0 }
          : { kind: 'folder', name, path: parts.slice(0, i + 1).join('/'), children: new Map() });
      }
      here = here.children.get(key);
    });
  }
  const finish = (map) => [...map.values()]
    .sort((a, b) => (a.kind === b.kind ? compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1))
    .map((node) => (node.kind === 'folder' ? { ...node, children: finish(node.children) } : node));
  return finish(root.children);
}

/** The history's commits as rows: { id, who, when, message }. `now` is only for the "5 minutes ago" labels. */
export function historyView(commits, now = new Date()) {
  return (Array.isArray(commits) ? commits : []).filter(isObject).map((c) => ({
    id: text(c.id),
    who: text(c.author) || 'Unknown',
    when: ageLabel(text(c.date), now),
    message: text(c.message),
  }));
}

/** True when a runtime event says a file of THIS project changed (an agent or the founder saved one). */
export function shouldRefetch(event, podId) {
  return isObject(event) && event.type === 'pod.file_changed' && isObject(event.data) && event.data.podId === podId;
}

/** A size in plain words: "812 bytes", "3.4 KB". */
export function sizeLabel(bytes) {
  const n = Number.isInteger(bytes) && bytes >= 0 ? bytes : 0;
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  return `${(n / 1024).toFixed(1)} KB`;
}
