'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/** Thrown by a suite when the code it grades has not been written yet. */
class PendingError extends Error {}

/**
 * Load the module under evaluation. If the file does not exist yet the case is
 * reported as "pending" rather than "fail", so evals can be written before the
 * code they grade.
 */
function loadSubject(relPath) {
  const abs = path.join(ROOT, relPath);
  try {
    return require(abs);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(abs)) {
      throw new PendingError(`not implemented yet: ${relPath}`);
    }
    throw err;
  }
}

/**
 * A suite is { name, description, threshold?, cases(), run(case) }.
 *   cases()   returns an array of objects with a unique `id`.
 *   run(case) returns { pass: boolean, detail?: string } or throws.
 *   threshold is the minimum pass rate among graded cases (default 1).
 *
 * Suite status:
 *   fail    - no cases, or pass rate below threshold
 *   pending - nothing failed but some cases could not run yet
 *   pass    - every case ran and the pass rate met the threshold
 */
async function runSuite(suite) {
  const cases = suite.cases();
  const threshold = suite.threshold ?? 1;
  const seen = new Set();
  const results = [];

  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`${suite.name}: duplicate case id "${c.id}"`);
    seen.add(c.id);
    try {
      const out = await suite.run(c);
      results.push({ id: c.id, status: out.pass ? 'pass' : 'fail', detail: out.detail });
    } catch (err) {
      if (err instanceof PendingError) {
        results.push({ id: c.id, status: 'pending', detail: err.message });
      } else {
        results.push({ id: c.id, status: 'fail', detail: `threw: ${err.message}` });
      }
    }
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  const pass = count('pass');
  const fail = count('fail');
  const pending = count('pending');
  const graded = pass + fail;
  const score = graded === 0 ? null : pass / graded;

  let status;
  if (cases.length === 0) status = 'fail';
  else if (graded > 0 && score < threshold) status = 'fail';
  else if (pending > 0) status = 'pending';
  else status = 'pass';

  return {
    name: suite.name,
    description: suite.description,
    status,
    threshold,
    score,
    counts: { pass, fail, pending, total: results.length },
    results,
  };
}

/** Exit code for a set of suite reports. `strict` treats pending as failure. */
function exitCode(reports, { strict = false } = {}) {
  const bad = reports.some((r) => r.status === 'fail' || (strict && r.status === 'pending'));
  return bad ? 1 : 0;
}

module.exports = { ROOT, PendingError, loadSubject, runSuite, exitCode };
