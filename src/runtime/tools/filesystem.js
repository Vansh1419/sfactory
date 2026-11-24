'use strict';

// The Filesystem tools (PLAN.md step 1.10): read a text file or list a folder, only inside one project folder.
// Read-only; both have built-in policy rules in policy.js. Graded by the `filesystem-tools` eval.
//
// Staying inside the folder is checked twice: once on the path as written (so ".." that leaves the folder is
// refused), and again after the system has followed every link (so a link inside the folder that points outside is
// refused). Files that hold secrets, and folders that are not the project's own, are never read or listed.
// Errors are one plain sentence: they never show the folder's real path or the system's error text.

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_PATH_CHARS = 500;
const MAX_FILE_BYTES = 200_000;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000, so the notice below always fits
const MAX_LIST_ENTRIES = 200;
const SHORTENED_NOTICE = '\n[Shortened: the file is larger than this.]';
const CANNOT_READ = 'That path cannot be read.';

// A name that holds secrets or is not the project's own. Compared in lower case, for every part of a path.
const DENIED_NAME = /^(\.env.*|\.git|node_modules|\.ssh|\.aws|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519).*|credentials.*|.*\.(pem|key|p12|pfx))$/;
const isDenied = (name) => DENIED_NAME.test(name.toLowerCase());

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkPathArgs(args) {
  if (!isObject(args)) return 'the arguments must be an object';
  const extra = Object.keys(args).find((k) => k !== 'path');
  if (extra) return `unknown argument: ${extra}`;
  if (typeof args.path !== 'string' || args.path.trim() === '' || args.path.length > MAX_PATH_CHARS || args.path.includes('\u0000')) {
    return `path must be text of 1 to ${MAX_PATH_CHARS} characters, relative to the project folder`;
  }
  return null;
}

const insideRoot = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const partsOf = (rel) => rel.split(path.sep).filter((p) => p !== '');

/** The real path of `given` (relative to the folder), or an error. Both checks happen here. */
async function resolveInside(root, given) {
  const realRoot = await fs.realpath(root);
  const lexical = path.resolve(realRoot, given.replace(/\\/g, '/'));
  if (!insideRoot(realRoot, lexical) || path.isAbsolute(given) || given.startsWith('~')) throw new Error(CANNOT_READ);
  const real = await fs.realpath(lexical); // follows every link; fails if the path does not exist
  if (!insideRoot(realRoot, real)) throw new Error(CANNOT_READ);
  const names = [...partsOf(path.relative(realRoot, lexical)), ...partsOf(path.relative(realRoot, real))];
  if (names.some(isDenied)) throw new Error(CANNOT_READ);
  return { realRoot, real };
}

async function readText({ root, args }) {
  try {
    const { real } = await resolveInside(root, args.path);
    const info = await fs.stat(real);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(CANNOT_READ);
    const bytes = await fs.readFile(real);
    if (bytes.includes(0)) throw new Error(CANNOT_READ); // binary
    const text = bytes.toString('utf8');
    return { text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}${SHORTENED_NOTICE}` : text };
  } catch {
    throw new Error(CANNOT_READ);
  }
}

async function listNames({ root, args }) {
  try {
    const { realRoot, real } = await resolveInside(root, args.path);
    if (!(await fs.stat(real)).isDirectory()) throw new Error(CANNOT_READ);

    const names = [];
    for (const entry of await fs.readdir(real, { withFileTypes: true })) {
      if (isDenied(entry.name)) continue;
      let target;
      try {
        target = await fs.realpath(path.join(real, entry.name));
      } catch {
        continue; // a broken link
      }
      if (!insideRoot(realRoot, target) || partsOf(path.relative(realRoot, target)).some(isDenied)) continue;
      names.push((await fs.stat(target)).isDirectory() ? `${entry.name}/` : entry.name);
    }
    names.sort((a, b) => a.localeCompare(b));
    const shown = names.slice(0, MAX_LIST_ENTRIES);
    if (names.length > shown.length) shown.push(`… and ${names.length - shown.length} more not shown`);
    return { text: shown.join('\n') };
  } catch {
    throw new Error(CANNOT_READ);
  }
}

/** The two tools, for one folder. With no usable folder (not an absolute path) there are none. */
function createFilesystemTools({ root } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return [];
  const folder = path.resolve(root);

  return [
    Object.freeze({
      name: 'filesystem.read_file',
      access: 'read',
      summary: 'Reads one text file inside the project folder and gives back its text. Secrets and binary files are refused.',
      args: '{ "path": the file\'s path relative to the project folder, for example "README.md" or "src/app.js" }',
      checkArgs: checkPathArgs,
      run: ({ args }) => readText({ root: folder, args }),
    }),
    Object.freeze({
      name: 'filesystem.list_directory',
      access: 'read',
      summary: 'Lists the files and folders inside one folder of the project (folders end with a slash). Use "." for the project folder itself.',
      args: '{ "path": the folder\'s path relative to the project folder, for example "." or "src" }',
      checkArgs: checkPathArgs,
      run: ({ args }) => listNames({ root: folder, args }),
    }),
  ];
}

module.exports = { createFilesystemTools, isDeniedName: isDenied };
