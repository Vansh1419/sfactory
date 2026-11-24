'use strict';

// A tool may hand back one file: { name, content }. These two functions make sure nothing unsafe or odd is kept.
// Graded by the `tool-loader` and `orchestrator` evals. The window cleans names again on its own side
// (src/renderer/goals.mjs) because it must never trust what it is given.

const MAX_FILE_NAME_CHARS = 100;
const MAX_FILE_CHARS = 20_000;

// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f:*?"<>|]/g;

/** A plain file name (no folders, no odd characters, not hidden), or null if nothing usable is left. */
function sanitizeFileName(name) {
  if (typeof name !== 'string') return null;
  const lastPart = name.split(/[\\/]/).pop();
  const cleaned = lastPart.replace(UNSAFE_NAME_CHARS, '_').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (cleaned === '' || cleaned.length > MAX_FILE_NAME_CHARS) return null;
  return cleaned;
}

/** `{ name, content }` with a safe name and text content within the limit, or null. Extra fields are dropped. */
function cleanFile(file) {
  if (file === null || typeof file !== 'object' || Array.isArray(file)) return null;
  const name = sanitizeFileName(file.name);
  if (name === null || typeof file.content !== 'string' || file.content.length > MAX_FILE_CHARS) return null;
  return { name, content: file.content };
}

module.exports = { sanitizeFileName, cleanFile, MAX_FILE_CHARS, MAX_FILE_NAME_CHARS };
