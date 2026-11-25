'use strict';

// The Marketing and Sales team (PLAN.md step 2.3). Graded by the `sales-team` eval.
//
//   createSalesTeam({ factory, decisions, writeCard, onError? })
//     .workLead({ company, website?, email?, price? })
//       -> { status: 'done', taskId, outputs }
//        | { status: 'blocked', taskId, reason }
//        | { status: 'needs_founder', taskId, decisionId }
//        | { status: 'failed', reason, problems? }
//
// One lead goes through the team's workflow: Scout researches the lead on the web, judges the fit and saves it in the lead list;
// Scribe writes the proposal and puts the email through email.submit, which has it reviewed and, while the founder's approval
// is required, files the founder's card. Maya, the lead, plans that and checks each piece of work (the framework of step 2.1).
//
// If an agent reaches a crucial action (anything the policy says needs the founder), it is stopped and the request comes back
// here; this turns it into a plain-language card through the decisions service. The card records the founder's answer; it does
// not run the action, and the task stays blocked until the founder gives a new instruction.
//
// The team is built the first time it is needed (that writes the agents' rows), once. The lead's details are the founder's own
// input and are checked here (plain text, short, one email address, an https web address) before they reach any model.

const TEAM = 'marketing_sales';
const LEAD = Object.freeze({ name: 'Maya' });
const WORKERS = Object.freeze([
  Object.freeze({ name: 'Scout', summary: 'researches a lead on the web, judges whether it fits, and saves it in the lead list' }),
  Object.freeze({ name: 'Scribe', summary: 'writes the proposal for a lead and sends the email through email.submit so it is reviewed and approved' }),
]);

const MAX_COMPANY_CHARS = 200;
const MAX_URL_CHARS = 300;
const MAX_PRICE_CHARS = 100;
const EMAIL = /^[^\s@,;<>()[\]\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
const PLAIN = /^[^\u0000-\u001f\u007f]+$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The lead's details, checked. Returns { ok, lead?, problems }. */
function checkLead(input) {
  if (!isObject(input)) return { ok: false, problems: ['The lead is not valid.'] };
  const problems = [];
  const lead = {};
  const text = (key, max, label, pattern = PLAIN) => {
    const v = input[key];
    if (v === undefined) return false;
    if (typeof v !== 'string' || v.trim() === '' || v.length > max || !pattern.test(v.trim())) {
      problems.push(`${label} is not valid.`);
      return false;
    }
    lead[key] = v.trim();
    return true;
  };
  if (!text('company', MAX_COMPANY_CHARS, 'The company name') && input.company === undefined) problems.push('The company name is needed.');
  text('website', MAX_URL_CHARS, 'The web address', /^https:\/\/[^\s]+$/);
  text('email', 200, 'The email address', EMAIL);
  text('price', MAX_PRICE_CHARS, 'The price');
  const extra = Object.keys(input).find((k) => !['company', 'website', 'email', 'price'].includes(k));
  if (extra) problems.push('Only the company, web address, email address and price can be given.');
  return problems.length === 0 ? { ok: true, lead, problems } : { ok: false, problems: [...new Set(problems)] };
}

/** The task the team is given for one lead. The lead's details are data inside it. */
function leadTask(lead) {
  const known = [
    `Company: ${lead.company}`,
    lead.website ? `Website: ${lead.website}` : null,
    lead.email ? `Business email: ${lead.email}` : null,
    lead.price ? `Price the founder has set (write it exactly as given): ${lead.price}` : 'Price: none given. Do not state a price.',
  ].filter(Boolean);
  return {
    title: `Research ${lead.company} and draft a proposal`,
    description: [
      'Take this one lead from research to a drafted proposal that the founder can approve.',
      '',
      'What we know:',
      ...known,
      '',
      'Steps, in this order:',
      '1. Scout: find out what the business does and which of our services it may need (search.web, fetch.get). Judge the fit with the ideal-client-profile skill. Check crm.find_lead first, then save the lead with crm.save_lead, with short factual notes and where each fact came from. If it is not a fit, say so and stop: no proposal.',
      '2. Scribe: write the proposal with the proposal-writing and brand-voice skills, and put it into one email to the business address with email.submit. Use only a business address that was given or found on their own website. Never send it any other way.',
      '3. Report: the lead name, the fit, the message id, and whether the email is ready or waiting for the founder. Do not say anything was sent unless email.send confirmed it.',
    ].join('\n'),
  };
}

function createSalesTeam({ factory, decisions, writeCard, onError = () => {} } = {}) {
  let building = null;

  function ensureTeam() {
    building ??= factory.buildTeam({ team: TEAM, lead: { ...LEAD }, workers: WORKERS.map((w) => ({ ...w })) }).then((built) => {
      if (!built.ok) building = null; // try again next time
      return built;
    }, (err) => {
      building = null;
      throw err;
    });
    return building;
  }

  /** Make the founder's card for a request an agent was stopped on. Returns the decision id, or null. */
  async function fileCard(taskId, title, request) {
    try {
      const action = { tool: request.tool, access: request.access, args: request.args ?? {} };
      const card = await writeCard({ task: { id: taskId, title }, category: request.category, action });
      const filed = await decisions.create({ action, card });
      return filed.id;
    } catch (err) {
      onError(err);
      return null;
    }
  }

  async function workLead(input) {
    const checked = checkLead(input);
    if (!checked.ok) return { status: 'failed', reason: 'bad_lead', problems: checked.problems };
    const task = leadTask(checked.lead);

    let built;
    try {
      built = await ensureTeam();
    } catch (err) {
      onError(err);
      return { status: 'failed', reason: 'team_unavailable' };
    }
    if (!built.ok) return { status: 'failed', reason: 'team_unavailable', problems: built.problems };

    let result;
    try {
      result = await built.team.runTask(task);
    } catch (err) {
      onError(err);
      return { status: 'failed', reason: 'error' };
    }
    if (result.status === 'needs_founder') {
      const decisionId = await fileCard(result.taskId, task.title, result.request ?? {});
      if (decisionId === null) return { status: 'failed', reason: 'card_failed', taskId: result.taskId };
      return { status: 'needs_founder', taskId: result.taskId, decisionId };
    }
    return result;
  }

  return { workLead };
}

module.exports = { createSalesTeam, checkLead, leadTask, TEAM, LEAD, WORKERS };
