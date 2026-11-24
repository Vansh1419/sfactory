'use strict';

// The skills loader (PLAN.md step 2.1). An agent is given the shared skills first (the company charter, how to ask
// the founder, escalation rules, handoff notes) and then its own team's skills; never another team's. Graded by the
// `skills-loader` eval.
//
//   <dir>/shared/<name>/SKILL.md      for every agent
//   <dir>/<team>/<name>/SKILL.md      for that team only
//
// A skill needs frontmatter (`name` equal to its folder, a `description`) and a body. One that does not is skipped with a
// note and the good ones stay. A folder that is a link is skipped (it could point anywhere). The team name cannot reach
// any other folder. Nothing here throws.

const fs = require('node:fs');
const path = require('node:path');

const CHARTER = 'company-charter';
const TEAM_NAME = /^[a-z][a-z_]{0,39}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const MAX_SKILL_CHARS = 20_000;
const MAX_TOTAL_CHARS = 60_000;
const DEFAULT_TEXT_CHARS = 70_000;
const SHORTENED_NOTICE = '\n[Shortened]';

/** { name, description, body } for the text of one SKILL.md, or { problem }. */
function parse(folderName, text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { problem: `${folderName}: no frontmatter` };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m[2].trim();
  if (fields.name !== folderName) return { problem: `${folderName}: the name in the file does not match the folder` };
  if (!fields.description) return { problem: `${folderName}: no description` };
  if (body === '') return { problem: `${folderName}: no body` };
  if (body.length > MAX_SKILL_CHARS) return { problem: `${folderName}: too long (over ${MAX_SKILL_CHARS} characters)` };
  return { skill: { name: fields.name, description: fields.description, body } };
}

/** The skills of one folder, in name order. */
function readFolder(folder, label) {
  const skills = [];
  const problems = [];
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return { skills, problems, found: false };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      problems.push(`${label}/${entry.name}: a link, so it was skipped`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (!SKILL_NAME.test(entry.name)) {
      problems.push(`${label}/${entry.name}: not a skill name`);
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(folder, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      problems.push(`${label}/${entry.name}: no SKILL.md`);
      continue;
    }
    const parsed = parse(entry.name, text);
    if (parsed.problem) problems.push(`${label}/${parsed.problem}`);
    else skills.push(parsed.skill);
  }
  return { skills, problems, found: true };
}

/** { skills, problems }: shared first, then the team's own. */
function loadSkills(input) {
  const { dir, team } = input !== null && typeof input === 'object' ? input : {};
  if (typeof dir !== 'string' || dir === '') return { skills: [], problems: ['No skills folder was given, so there are no skills.'] };

  const problems = [];
  const shared = readFolder(path.join(dir, 'shared'), 'shared');
  if (!shared.found) problems.push('The shared skills folder was not found.');
  problems.push(...shared.problems);
  let all = [...shared.skills];

  if (team !== undefined) {
    if (typeof team !== 'string' || !TEAM_NAME.test(team) || team === 'shared') {
      problems.push('The team name is not valid, so only the shared skills are loaded.');
    } else {
      const own = readFolder(path.join(dir, team), team);
      problems.push(...own.problems);
      all = [...all, ...own.skills];
    }
  }

  // A total limit: the shared skills come first, so they are the last to be cut.
  const kept = [];
  let total = 0;
  for (const s of all) {
    if (total + s.body.length > MAX_TOTAL_CHARS) {
      problems.push(`${s.name}: left out, the skills together are too long`);
      continue;
    }
    total += s.body.length;
    kept.push(s);
  }
  return { skills: kept, problems };
}

/** The text an agent is given for its skills. */
function skillsText(skills, { maxChars = DEFAULT_TEXT_CHARS } = {}) {
  if (!Array.isArray(skills) || skills.length === 0) return '';
  const text = skills.map((s) => `## Skill: ${s.name}\n${s.description}\n\n${s.body}`).join('\n\n---\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}${SHORTENED_NOTICE}` : text;
}

module.exports = { loadSkills, skillsText, CHARTER };
