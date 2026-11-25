'use strict';

// The tool loader (PLAN.md step 1.10, the loader part). It holds the tools an agent run may actually use and runs
// them. Graded by the `tool-loader` eval.
//
//   - A tool is loaded ONLY if it has a policy rule (built-in, or one the founder activated): the plan says
//     "refuse to load a tool that has neither". The rule is checked again on every call, so a rule removed later
//     stops the tool at once, and a rule check that fails stops it too.
//   - run() runs a loaded tool with the access tag it declares and arguments its own check accepts. The graph has
//     already put the action through the policy; this is a second, independent check, not a replacement.
//   - A tool's result is reduced to `{ text?, file? }`: text, and one file { name, content } with a safe plain name.
//     Anything else it returns (tokens, objects, ids) is dropped here.
//   - No error text from a tool ever reaches the caller (it can hold a key or a connection string), and a tool
//     that hangs is stopped.
//
// External servers (Filesystem, GitHub, Fetch, Supabase through MCP) are the rest of step 1.10; they will be
// tools in this same shape.

const { normaliseTool } = require('../policy');
const { cleanFile } = require('./files');

const NAME_SHAPE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const ACCESS_TAGS = ['read', 'write'];
// How a tool behaves in a run that belongs to a pod (step 3.2). `scoped`: it reads the run's pod from its context and only ever touches that pod's own
// files, history, memory or rows. `neutral`: it touches nothing of the company or of any pod (the open web, text it is handed). A tool with neither is
// REFUSED in a pod run, so a tool added later is closed to pods until someone has decided how it stays inside one.
const POD_ACCESS = ['scoped', 'neutral'];
const NOT_IN_A_POD = 'That tool cannot be used inside a project.';
const MAX_TEXT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SUMMARY_CHARS = 300;
const MAX_ARGS_HINT_CHARS = 500;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** Why a tool definition cannot be loaded, or null if it is well formed. */
function problemWith(def) {
  if (!isObject(def)) return 'the definition is not an object';
  if (typeof def.name !== 'string' || !NAME_SHAPE.test(def.name)) return 'the name must look like server.tool';
  if (!ACCESS_TAGS.includes(def.access)) return 'the access tag must be read or write';
  if (!isText(def.summary, MAX_SUMMARY_CHARS)) return 'it needs a plain one-sentence summary';
  if (!isText(def.args, MAX_ARGS_HINT_CHARS)) return 'it needs a line saying which arguments it takes';
  if (def.podAccess !== undefined && !POD_ACCESS.includes(def.podAccess)) return 'podAccess must be scoped or neutral';
  if (typeof def.checkArgs !== 'function') return 'it needs an arguments check';
  if (typeof def.run !== 'function') return 'it needs a run function';
  return null;
}

function withTimeout(work, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([Promise.resolve(work), timeout]).finally(() => clearTimeout(timer));
}

function createToolLoader({ tools, hasRule, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const loaded = new Map(); // name -> definition

  /** Load every tool that has a rule. Never throws; says which tools were refused and why. */
  async function load() {
    loaded.clear();
    const refused = [];
    const list = Array.isArray(tools) ? tools : [];

    for (const def of list) {
      const label = isObject(def) && typeof def.name === 'string' ? def.name : '(unnamed)';
      const problem = problemWith(def);
      if (problem) {
        refused.push({ tool: label, reason: problem });
        continue;
      }
      if (loaded.has(def.name)) {
        refused.push({ tool: label, reason: 'a tool with that name is already loaded' });
        continue;
      }
      let ruled = false;
      try {
        ruled = typeof hasRule === 'function' && (await hasRule(def.name)) === true;
      } catch {
        refused.push({ tool: label, reason: 'the policy rule could not be checked' });
        continue;
      }
      if (!ruled) {
        refused.push({ tool: label, reason: 'it has no policy rule, so it is not loaded' });
        continue;
      }
      loaded.set(def.name, def);
    }
    return { loaded: [...loaded.keys()], refused };
  }

  /** What the planner is told about the loaded tools. A copy: nothing here can change the loader. */
  function describe({ inPod = false } = {}) {
    return [...loaded.values()]
      .filter((d) => !inPod || POD_ACCESS.includes(d.podAccess))
      .map((d) => ({ tool: d.name, access: d.access, summary: d.summary, args: d.args }));
  }

  /** Run one action. Resolves to { text? }; rejects with a plain message that never carries a tool's own text. */
  async function run(request) {
    const action = request?.action;
    if (!isObject(action)) throw new Error('That is not an action I can run.');

    const name = normaliseTool(action.tool);
    const def = name ? loaded.get(name) : undefined;
    if (!def) throw new Error('That tool is not connected.');
    if (action.access !== def.access) throw new Error('The access tag does not match this tool, so it did not run.');
    // A run that belongs to a pod may use only tools that say how they stay inside one. The pod is in the CONTEXT the agent loop builds from the task,
    // never in the arguments, so a model cannot choose it. A pod id that is present but odd is still a pod run.
    if (isObject(request.context) && request.context.podId !== undefined && !POD_ACCESS.includes(def.podAccess)) throw new Error(NOT_IN_A_POD);

    // The rule is checked again NOW: a rule removed after loading must stop the tool at once.
    let ruled = false;
    try {
      ruled = typeof hasRule === 'function' && (await hasRule(def.name)) === true;
    } catch {
      throw new Error('The policy rule for this tool could not be checked, so it did not run.');
    }
    if (!ruled) throw new Error('This tool has no policy rule any more, so it did not run.');

    let args;
    try {
      if (action.args !== undefined && !isObject(action.args)) throw new Error('not an object');
      args = structuredClone(action.args ?? {});
      if (def.checkArgs(args) !== null) throw new Error('refused');
    } catch {
      throw new Error('The arguments for this tool were not accepted.');
    }

    let result;
    try {
      // The tool is told which run it belongs to (the team, the agent): a copy, so a tool cannot change the caller's.
      const context = isObject(request.context) ? structuredClone(request.context) : {};
      result = await withTimeout(def.run({ args, key: request.key, context }), timeoutMs);
    } catch (err) {
      throw new Error(err?.message === 'timed out' ? 'The tool took too long and was stopped.' : 'The tool failed.');
    }

    // Only plain text and one clean file leave a tool.
    const out = typeof result?.text === 'string' ? { text: result.text.slice(0, MAX_TEXT_CHARS) } : {};
    const file = cleanFile(result?.file);
    return file ? { ...out, file } : out;
  }

  return { load, describe, run };
}

module.exports = { createToolLoader, MAX_TEXT_CHARS };
