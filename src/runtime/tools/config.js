'use strict';

// The per-team tool configuration (PLAN.md step 1.10). Graded by the `tool-config` eval.
//
// config/mcp/shared.yaml lists the tools every team may use; config/mcp/<team>.yaml adds that team's own. Each entry
// names a tool and tags it `read` or `write`:
//     tools:
//       filesystem.read_file: read
//       github.create_pull_request: write
// The configuration is an ALLOW-LIST and a TAG CHECK. A tool that is not listed is never loaded, and a listed tool
// is only used when the tag in the file equals the tag the tool itself declares, so a file can never call a write
// tool "read". It fails closed: a missing shared file, a broken file or a wrong entry gives fewer tools, never more.
// It only chooses among tools that exist (it cannot create one), and the policy rule is still required by the loader,
// so this is a second gate, not a replacement.

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { normaliseTool } = require('../policy');

const MAX_FILE_BYTES = 100_000;
const ACCESS_TAGS = ['read', 'write'];
const TEAM_NAME = /^[a-z][a-z_]{0,39}$/;
const NAME_SHAPE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const SHARED_FILE = 'shared.yaml';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The tools of one file as { name: tag }, plus what was wrong with it. Never throws. */
function readFile(dir, file) {
  const problems = [];
  const tools = {};
  const label = file;
  let text;
  try {
    const target = path.join(dir, file);
    if (fs.statSync(target).size > MAX_FILE_BYTES) return { tools, problems: [`${label} is too large, so none of it was used.`], found: true };
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return { tools, problems: err?.code === 'ENOENT' ? [] : [`${label} could not be read.`], found: err?.code !== 'ENOENT' };
  }

  let parsed;
  try {
    parsed = YAML.parse(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    return { tools, problems: [`${label} is not valid, so none of it was used.`], found: true };
  }
  if (!isObject(parsed) || !isObject(parsed.tools)) return { tools, problems: [`${label} needs a "tools:" list of name: read or write.`], found: true };
  for (const key of Object.keys(parsed)) if (key !== 'tools') problems.push(`${label}: "${key}" is not used.`);

  for (const [rawName, tag] of Object.entries(parsed.tools)) {
    const name = normaliseTool(rawName);
    if (name === null || !NAME_SHAPE.test(name)) {
      problems.push(`${label}: "${String(rawName).slice(0, 60)}" is not a tool name.`);
    } else if (!ACCESS_TAGS.includes(tag)) {
      problems.push(`${label}: ${name} must be tagged read or write.`);
    } else if (name in tools) {
      problems.push(`${label}: ${name} is listed twice.`);
      delete tools[name];
    } else {
      tools[name] = tag;
    }
  }
  return { tools, problems, found: true };
}

/** { tools: { name: 'read' | 'write' }, problems: [string] }. A bad team name or file gives the shared tools and a note. */
function loadToolConfig(input) {
  const { dir, team } = isObject(input) ? input : {};
  const frozen = (tools, problems) => Object.freeze({ tools: Object.freeze(tools), problems: Object.freeze(problems) });
  if (typeof dir !== 'string' || dir === '') return frozen({}, ['No tool configuration folder was given, so no tools are available.']);

  const shared = readFile(dir, SHARED_FILE);
  if (!shared.found) return frozen({}, [`${SHARED_FILE} was not found, so no tools are available.`]);
  if (Object.keys(shared.tools).length === 0 && shared.problems.length > 0) return frozen({}, shared.problems);

  const tools = { ...shared.tools };
  const problems = [...shared.problems];
  if (team === undefined) return frozen(tools, problems);

  if (typeof team !== 'string' || !TEAM_NAME.test(team)) {
    problems.push('The team name is not valid, so only the shared tools are available.');
    return frozen(tools, problems);
  }
  const own = readFile(dir, `${team}.yaml`);
  if (!own.found) {
    problems.push(`There is no tool file for the ${team} team, so only the shared tools are available.`);
    return frozen(tools, problems);
  }
  problems.push(...own.problems);
  for (const [name, tag] of Object.entries(own.tools)) {
    if (name in tools && tools[name] !== tag) {
      problems.push(`${team}.yaml tags ${name} differently from ${SHARED_FILE}, so it was removed.`);
      delete tools[name];
    } else if (!(name in tools) || tools[name] === tag) {
      tools[name] = tag;
    }
  }
  return frozen(tools, problems);
}

/** The tool definitions the configuration allows. Never throws; odd input selects nothing. */
function selectTools(input) {
  const { catalogue, config } = isObject(input) ? input : {};
  const tools = [];
  const problems = [];
  const listed = isObject(config?.tools) ? config.tools : {};
  const have = new Set();

  for (const def of Array.isArray(catalogue) ? catalogue : []) {
    if (!isObject(def) || typeof def.name !== 'string') continue;
    have.add(def.name);
    if (!Object.hasOwn(listed, def.name)) continue;
    if (listed[def.name] !== def.access) {
      problems.push(`${def.name} is tagged ${String(listed[def.name])} in the configuration but is a ${def.access} tool, so it is not loaded.`);
      continue;
    }
    tools.push(def);
  }
  const missing = Object.keys(listed).filter((name) => !have.has(name));
  return { tools, problems, missing };
}

module.exports = { loadToolConfig, selectTools };
