'use strict';

// The agent factory (PLAN.md step 2.1): builds a team of one lead and its workers from `shared` plus that team's own tool
// configuration and skills. Graded by the `team-framework` eval.
//
//   createAgentFactory({ router, store, audit, policy, catalogue, hasRule, configDir, skillsDir, limits? })
//     .buildTeam({ team, lead: { name }, workers: [{ name, summary? }] }) -> { ok, team?, problems }
//
// - the team's tools are exactly what config/mcp/shared.yaml plus <team>.yaml list, that exist in the catalogue with the
//   same read/write tag, and that have a policy rule (the loader refuses any other); never another team's
// - the team's skills are `shared` plus <team>; never another team's. The company charter is REQUIRED: without it no team
//   is built, so no agent ever runs without the company's rules
// - the step and token limits reach every agent
// - it never throws: a problem comes back in `problems`

const { createAgent } = require('./agent');
const { createLead } = require('./lead');
const { createTeam } = require('./team');
const { loadSkills, skillsText, CHARTER } = require('./skills');
const { loadToolConfig, selectTools } = require('../tools/config');
const { createToolLoader } = require('../tools');

const TEAMS = Object.freeze(['orchestrator', 'product_engineering', 'marketing_sales', 'support', 'finance_legal_ops']);
const AGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_WORKERS = 8;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The team build request, checked. Returns { problems }. */
function checkRequest(input) {
  if (!isObject(input)) return ['The team request is not valid.'];
  const problems = [];
  if (!TEAMS.includes(input.team)) problems.push(`The team must be one of ${TEAMS.join(', ')}.`);
  if (!isObject(input.lead) || typeof input.lead.name !== 'string' || !AGENT_NAME.test(input.lead.name)) problems.push('The lead needs a plain name.');
  if (!Array.isArray(input.workers) || input.workers.length < 1 || input.workers.length > MAX_WORKERS) {
    problems.push(`A team needs between 1 and ${MAX_WORKERS} workers.`);
    return problems;
  }
  const names = new Set([isObject(input.lead) && typeof input.lead.name === 'string' ? input.lead.name.toLowerCase() : '']);
  for (const w of input.workers) {
    if (!isObject(w) || typeof w.name !== 'string' || !AGENT_NAME.test(w.name)) {
      problems.push('Every worker needs a plain name.');
      continue;
    }
    if (names.has(w.name.toLowerCase())) problems.push(`The name "${w.name}" is used twice.`);
    names.add(w.name.toLowerCase());
  }
  return problems;
}

function createAgentFactory({ router, store, audit, policy, catalogue, hasRule, configDir, skillsDir, limits } = {}) {
  async function buildTeam(input) {
    try {
      const bad = checkRequest(input);
      if (bad.length > 0) return { ok: false, problems: bad };

      const { team } = input;
      const problems = [];

      const skills = loadSkills({ dir: skillsDir, team });
      problems.push(...skills.problems);
      if (!skills.skills.some((s) => s.name === CHARTER)) {
        return { ok: false, problems: [...problems, 'The company charter is missing, so no team was built.'] };
      }

      const config = loadToolConfig({ dir: configDir, team });
      const selection = selectTools({ catalogue, config });
      problems.push(...config.problems, ...selection.problems);
      const loader = createToolLoader({ tools: selection.tools, hasRule });
      const loaded = await loader.load();
      problems.push(...loaded.refused.map((r) => `${r.tool}: ${r.reason}`));

      const instructions = skillsText(skills.skills);
      const workers = {};
      for (const w of input.workers) {
        workers[w.name] = createAgent({ name: w.name, role: 'worker', team, instructions, router, tools: loader, policy, audit, limits, tier: 'cheap' });
      }
      const lead = createLead({
        name: input.lead.name,
        team,
        instructions,
        router,
        workers: input.workers.map((w) => ({ name: w.name, summary: typeof w.summary === 'string' ? w.summary : '' })),
      });
      const built = createTeam({ team, lead, workers, store, audit });
      try {
        await built.register();
      } catch {
        return { ok: false, problems: [...problems, 'The agents could not be registered.'] };
      }
      return { ok: true, team: built, problems };
    } catch {
      return { ok: false, problems: ['The team could not be built.'] };
    }
  }

  return { buildTeam };
}

module.exports = { createAgentFactory, TEAMS };
