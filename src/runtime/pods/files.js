'use strict';

// The project view's files panel, runtime side (PLAN.md step 3.6). Graded by the `pod-files` eval.
//
//   createPodFiles({ store, audit, podFolder, isBlocked?, emit?, now?, lockMinutes?, git? })
//     .tree({ podId })                          -> { files: [{ path, size }], truncated }
//     .read({ podId, path })                    -> { path, content, locked }
//     .history({ podId, path?, limit? })        -> { commits: [{ id, author, date, message }] }   read from the project's own git history
//     .beginEdit({ podId, path })               -> { path, expiresAt }       the founder opens a file: agents are locked out of it
//     .endEdit({ podId, path })                 -> { released }              the founder closes it without saving
//     .save({ podId, path, content, message? }) -> { path, commit }          writes the file, commits only that file, unlocks it, tells agents to reload
//     .upload({ podId, path, content })         -> { path, commit }          adds a NEW file and commits it; it never replaces one
//     .isLocked({ podId, path })                -> boolean                   what the agent's write tool (`pod.write_file`) asks before it writes
//
// This is the FOUNDER's side, for trusted code (the window's commands): it is never handed to an agent's tools. The pod is always a project the caller
// names by id; nothing outside that project's folder is read or written (the same path rules as `pod.write_file`: no "..", no absolute path, no link,
// nothing that holds secrets, never `.git` or `node_modules`), and only text: no NUL byte, 100,000 characters at most, nothing that looks like a key.
//
// The lock lives in memory, for the project and the file (lower case, so a different spelling cannot get round it), and runs out after `lockMinutes`
// (30) so a window closed in the middle of an edit never locks a file for good; opening the file again renews it. A save needs the lock of an
// existing file; a new file is added with `upload`. A save commits that one file by the founder ("Founder") on the branch the project is on, and never
// sweeps in what an agent left uncommitted. If the history cannot take the commit the file is put back as it was. Saves run one at a time.
// Every change is audited BEFORE it is made (the file's words never go to the audit log: only the path and the size), and when the audit entry cannot be
// written, or the runtime is blocked, nothing changes. Errors are plain sentences for the founder, never a real path or the system's own text.

const fs = require('node:fs/promises');
const path = require('node:path');
const { checkTarget, prepareFolder } = require('../tools/pod-files');
const { isDeniedName } = require('../tools/filesystem');
const { runGit } = require('../tools/git');
const { redactDetail } = require('../audit');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PATH_CHARS = 300;
const MAX_CONTENT_CHARS = 100_000;
const MAX_READ_BYTES = 400_000;
const MAX_FILES = 500;
const MAX_DEPTH = 8;
const DEFAULT_LOG = 30;
const MAX_LOG = 100;
const MAX_MESSAGE_CHARS = 200;
const LOCK_MINUTES = 30;
const FOUNDER = ['-c', 'user.name=Founder', '-c', 'user.email=founder@sfactory.local'];

class PodFilesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PodFilesError';
    this.code = code;
  }
}
const fail = (code, message) => new PodFilesError(code, message);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (value, keys) => isObject(value) && Object.keys(value).every((k) => keys.includes(k));
// eslint-disable-next-line no-control-regex
const PLAIN_LINE = /^[^\u0000-\u001f\u007f]+$/;

function createPodFiles({ store, audit, podFolder, isBlocked = () => null, emit, now = () => new Date(), lockMinutes = LOCK_MINUTES, git = runGit } = {}) {
  const locks = new Map(); // `${podId}|${lower-case path}` -> the time it runs out, in milliseconds
  let chain = Promise.resolve();

  /** Run one change at a time, so two saves at the same moment cannot meet inside git. */
  function exclusive(work) {
    const run = chain.then(work, work);
    chain = run.catch(() => {});
    return run;
  }

  /** Turn anything unexpected (a file system or git error) into one plain sentence: their own text can hold a real path. */
  async function guard(work) {
    try {
      return await work();
    } catch (err) {
      if (err instanceof PodFilesError) throw err;
      throw fail('failed', 'That could not be done, and nothing was changed.');
    }
  }

  const ensureRunning = () => {
    const reason = isBlocked();
    if (reason) throw fail('blocked', reason);
  };

  async function record(action, podId, detail) {
    try {
      await audit.append({ actorType: 'founder', podId, action, targetType: 'pod', targetId: podId, detail });
    } catch {
      throw fail('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
    }
  }

  const keyOf = (podId, rel) => `${String(podId).toLowerCase()}|${String(rel).toLowerCase()}`;

  function isLocked({ podId, path: file } = {}) {
    try {
      if (typeof podId !== 'string' || typeof file !== 'string') return false;
      const expires = locks.get(keyOf(podId, path.posix.normalize(file.replace(/\\/g, '/'))));
      return expires !== undefined && expires > now().getTime();
    } catch {
      return false;
    }
  }

  /** A real, open project and its real folder. */
  async function podRoot(podId) {
    if (typeof podId !== 'string' || !UUID.test(podId)) throw fail('invalid', 'The project (pod) id is not valid.');
    const [pod] = await store.select('pods', { where: { id: podId.toLowerCase() }, limit: 1 });
    if (!pod || pod.status !== 'open') throw fail('not_found', 'There is no open project with that id.');
    const given = await podFolder(pod.id);
    if (typeof given !== 'string' || !path.isAbsolute(given)) throw fail('not_found', 'That project has no folder here.');
    try {
      return { podId: pod.id, root: await fs.realpath(given) };
    } catch {
      throw fail('not_found', 'That project has no folder here.');
    }
  }

  /** A file the founder may name: written plainly, inside the folder, and not a secret. `existing` is what is there now (null when nothing is). */
  async function target(root, written) {
    if (typeof written !== 'string' || written.trim() === '' || written.length > MAX_PATH_CHARS || !PLAIN_LINE.test(written)) throw fail('invalid', 'The file name is not valid.');
    if (written.replace(/\\/g, '/').split('/').some((part) => part === '.' || part === '..') || /\/\//.test(written.replace(/\\/g, '/'))) throw fail('invalid', 'The file name is not valid.');
    try {
      return await checkTarget(root, written);
    } catch {
      throw fail('invalid', 'That file cannot be used here.');
    }
  }

  /** The project's history, only when it has a real `.git` folder of its own. */
  async function needHistory(root) {
    const info = await fs.lstat(path.join(root, '.git')).catch(() => null);
    if (!info || !info.isDirectory()) throw fail('no_history', 'This project has no saved history, so nothing was changed.');
  }

  async function readText(file) {
    const info = await fs.stat(file);
    if (info.size > MAX_READ_BYTES) throw fail('too_large', 'That file is too large to open here.');
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) throw fail('not_text', 'That file is not plain text, so it cannot be opened here.');
    const text = bytes.toString('utf8');
    if (text.length > MAX_CONTENT_CHARS) throw fail('too_large', 'That file is too large to open here.');
    return text;
  }

  function checkContent(content) {
    if (typeof content !== 'string' || content.length > MAX_CONTENT_CHARS || content.includes('\u0000')) throw fail('invalid', `The text must be plain text of up to ${MAX_CONTENT_CHARS.toLocaleString('en-US')} characters.`);
    if (redactDetail(content) !== content) throw fail('secret', 'The text looks like it holds a key or a password, so it was not saved.');
  }

  function checkMessage(message, fallback) {
    if (message === undefined) return fallback;
    if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_MESSAGE_CHARS || !PLAIN_LINE.test(message.trim())) throw fail('invalid', 'The note for the history is not valid.');
    return message.trim();
  }

  const announce = (podId, rel) => {
    try {
      emit?.('pod.file_changed', { podId, path: rel, by: 'founder' });
    } catch {
      // A broken listener must not undo a save.
    }
  };

  async function tree(input) {
    ensureRunning();
    if (!onlyKeys(input, ['podId'])) throw fail('invalid', 'Only a project can be given.');
    return guard(async () => {
      const { root } = await podRoot(input.podId);
      const files = [];
      let truncated = false;
      async function walk(dir, prefix, depth) {
        const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const entry of entries) {
          if (truncated) return;
          if (isDeniedName(entry.name)) continue;
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (depth < MAX_DEPTH) await walk(path.join(dir, entry.name), rel, depth + 1);
          } else if (entry.isFile()) {
            if (files.length >= MAX_FILES) {
              truncated = true;
              return;
            }
            files.push({ path: rel, size: (await fs.stat(path.join(dir, entry.name))).size });
          }
        }
      }
      await walk(root, '', 0);
      return { files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), truncated };
    });
  }

  async function read(input) {
    ensureRunning();
    if (!onlyKeys(input, ['podId', 'path'])) throw fail('invalid', 'Only a project and a file can be given.');
    return guard(async () => {
      const { podId, root } = await podRoot(input.podId);
      const { target: file, rel, existing } = await target(root, input.path);
      if (!existing) throw fail('not_found', 'There is no such file in this project.');
      return { path: rel, content: await readText(file), locked: isLocked({ podId, path: rel }) };
    });
  }

  async function history(input) {
    ensureRunning();
    if (!onlyKeys(input, ['podId', 'path', 'limit'])) throw fail('invalid', 'Only a project, a file and a limit can be given.');
    if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= MAX_LOG)) throw fail('invalid', `The limit must be a whole number from 1 to ${MAX_LOG}.`);
    return guard(async () => {
      const { root } = await podRoot(input.podId);
      const rel = input.path === undefined ? null : (await target(root, input.path)).rel;
      await needHistory(root);
      let out = '';
      try {
        out = await git(root, ['log', '--no-color', '--format=%h%x1f%an%x1f%ct%x1f%s', '-n', String(input.limit ?? DEFAULT_LOG), ...(rel ? ['--', rel] : [])]);
      } catch {
        return { commits: [] }; // a history with no saved version yet
      }
      const commits = out.split('\n').filter(Boolean).map((line) => {
        const [id, author, seconds, ...message] = line.split('\u001f');
        return { id, author, date: new Date(Number(seconds) * 1000).toISOString(), message: message.join('\u001f') };
      });
      return { commits };
    });
  }

  async function beginEdit(input) {
    ensureRunning();
    if (!onlyKeys(input, ['podId', 'path'])) throw fail('invalid', 'Only a project and a file can be given.');
    return guard(async () => {
      const { podId, root } = await podRoot(input.podId);
      const { rel, existing } = await target(root, input.path);
      if (!existing) throw fail('not_found', 'There is no such file in this project. Add it with an upload instead.');
      await record('pod.file_locked', podId, { path: rel });
      const expires = now().getTime() + lockMinutes * 60_000;
      locks.set(keyOf(podId, rel), expires);
      return { path: rel, expiresAt: new Date(expires).toISOString() };
    });
  }

  async function endEdit(input) {
    ensureRunning();
    if (!onlyKeys(input, ['podId', 'path'])) throw fail('invalid', 'Only a project and a file can be given.');
    return guard(async () => {
      const { podId, root } = await podRoot(input.podId);
      const { rel } = await target(root, input.path);
      if (!isLocked({ podId, path: rel })) {
        locks.delete(keyOf(podId, rel));
        return { released: false };
      }
      await record('pod.file_unlocked', podId, { path: rel });
      locks.delete(keyOf(podId, rel));
      return { released: true };
    });
  }

  /** Commit one path by the founder, and say which version it is. */
  async function commitOne(root, rel, message) {
    await git(root, ['add', '--', rel]);
    await git(root, [...FOUNDER, 'commit', '-q', '--no-verify', '--no-gpg-sign', '-m', message, '--', rel]);
    return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
  }

  async function save(input) {
    ensureRunning();
    if (!onlyKeys(input, ['podId', 'path', 'content', 'message'])) throw fail('invalid', 'Only a project, a file, its text and a note can be given.');
    checkContent(input.content);
    return guard(async () => {
      const { podId, root } = await podRoot(input.podId);
      const { target: file, rel, existing } = await target(root, input.path);
      if (!existing) throw fail('not_found', 'There is no such file in this project. Add it with an upload instead.');
      if (!isLocked({ podId, path: rel })) throw fail('not_locked', 'Open the file for editing first: its lock has run out or was never taken, so someone else may have changed it.');
      const message = checkMessage(input.message, `Edit ${rel}`);
      await needHistory(root);
      await record('pod.file_saved', podId, { path: rel, bytes: Buffer.byteLength(input.content) });
      return exclusive(async () => {
        const before = await readText(file);
        if (before === input.content) {
          locks.delete(keyOf(podId, rel));
          return { path: rel, commit: (await git(root, ['rev-parse', '--short', 'HEAD'])).trim(), unchanged: true };
        }
        await fs.writeFile(file, input.content, { encoding: 'utf8', mode: 0o644 });
        let commit;
        try {
          commit = await commitOne(root, rel, message);
        } catch {
          await fs.writeFile(file, before, { encoding: 'utf8', mode: 0o644 }); // the file is put back as it was
          await git(root, ['reset', '-q', '--', rel]).catch(() => {});
          throw fail('failed', 'The history could not record the change, so the file was left as it was.');
        }
        locks.delete(keyOf(podId, rel));
        announce(podId, rel);
        return { path: rel, commit };
      });
    });
  }

  async function upload(input) {
    ensureRunning();
    if (!onlyKeys(input, ['podId', 'path', 'content'])) throw fail('invalid', 'Only a project, a file and its text can be given.');
    checkContent(input.content);
    return guard(async () => {
      const { podId, root } = await podRoot(input.podId);
      const { target: file, rel, existing } = await target(root, input.path);
      if (existing) throw fail('exists', 'There is already a file with that name. Open it for editing instead.');
      await needHistory(root);
      await record('pod.file_uploaded', podId, { path: rel, bytes: Buffer.byteLength(input.content) });
      return exclusive(async () => {
        await prepareFolder(root, file);
        try {
          await fs.writeFile(file, input.content, { encoding: 'utf8', mode: 0o644, flag: 'wx' }); // never over a file that appeared a moment ago
        } catch {
          throw fail('exists', 'There is already a file with that name. Open it for editing instead.');
        }
        let commit;
        try {
          commit = await commitOne(root, rel, `Add ${rel}`);
        } catch {
          await fs.rm(file, { force: true }); // the file is taken away again
          await git(root, ['reset', '-q', '--', rel]).catch(() => {});
          throw fail('failed', 'The history could not record the file, so it was not added.');
        }
        announce(podId, rel);
        return { path: rel, commit };
      });
    });
  }

  return { tree, read, history, beginEdit, endEdit, save, upload, isLocked };
}

module.exports = { createPodFiles, PodFilesError };
