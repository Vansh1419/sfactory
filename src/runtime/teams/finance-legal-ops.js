'use strict';

// The Finance, Legal and Ops team (PLAN.md step 3.4). Graded by the `finance-team` eval.
//
//   createFinanceTeam({ factory, decisions, writeCard, onError? })
//     .workTask({ title, description?, podId? })
//       -> { status: 'done', taskId, outputs }
//        | { status: 'blocked', taskId, reason }
//        | { status: 'needs_founder', taskId, decisionId }
//        | { status: 'failed', reason: 'bad_task' | 'bad_pod' | 'team_unavailable' | 'card_failed' | 'error', problems? }
//     .describeAnswer(decision) -> a plain follow-up for the founder after they answer one of this team's cards, or null
//
// One piece of work goes through the team: Arjun drafts invoices (the GST is worked out by the tool, in code) and writes up expenses; Leela reads a
// contract or checks what personal data something collects and reports it in plain words; Anika, the lead, plans that and accepts each piece of work
// (the framework of step 2.1). With a `podId` the work belongs to one project and sees nothing of any other (step 3.2); without one it is the company's.
//
// The team holds NO payment credentials and has no tool that moves money, signs, sends for signature or issues a legal document. An agent that
// reaches for one is stopped by the policy, and THIS code turns the request into a plain-language card for the founder (tied to the pod when there is
// one) and leaves the task blocked. The card records the answer; it does not run anything, and the follow-up says so.

const TEAM = 'finance_legal_ops';
const LEAD = Object.freeze({ name: 'Anika' });
const WORKERS = Object.freeze([
  Object.freeze({ name: 'Arjun', summary: 'drafts invoices with the GST worked out by the invoice tool, and writes up expenses as plain records; never pays, sends or files anything' }),
  Object.freeze({ name: 'Leela', summary: 'reads a contract or checks what personal data a plan collects, and reports what it says and what to watch for in plain words; never signs, agrees or deletes anything' }),
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 8000;
const PLAIN_LINE = /^[^\u0000-\u001f\u007f]+$/;
const PLAIN_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/; // line breaks allowed
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// What each card this team can file is about, and what answering it did: nothing, because the team has no tool for any of them.
const ASKED_ABOUT = Object.freeze({
  'razorpay.create_payout': { about: 'paying money out', nothing: 'Nothing was paid: the team holds no payment account, so any payment is for you to make yourself.' },
  'vendor.sign_agreement': { about: 'signing an agreement', nothing: 'Nothing was signed: signing is for you to do yourself.' },
  'docusign.send_for_signature': { about: 'sending a document for signature', nothing: 'Nothing was sent for signature: that is for you to do yourself.' },
  'legal.issue_document': { about: 'issuing a legal document', nothing: 'Nothing was issued: that is for you to do yourself.' },
  'legal.escalate': { about: 'a legal or personal-data question', nothing: 'Nothing was done: the team only reads and reports, and any reply to the person is for you to write.' },
});

/** The task's details, checked. Returns { ok, task?, problems }. */
function checkTask(input) {
  if (!isObject(input)) return { ok: false, problems: ['The task is not valid.'] };
  const problems = [];
  const extra = Object.keys(input).find((k) => !['title', 'description', 'podId'].includes(k));
  if (extra) problems.push('Only a title, a description and a project can be given.');
  if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > MAX_TITLE_CHARS || !PLAIN_LINE.test(input.title.trim())) problems.push('The title is not valid.');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_CHARS || (input.description !== '' && !PLAIN_TEXT.test(input.description)))) problems.push('The description is not valid.');
  if (input.podId !== undefined && (typeof input.podId !== 'string' || !UUID.test(input.podId))) problems.push('The project (pod) id is not valid.');
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  return {
    ok: true,
    task: {
      title: input.title.trim(),
      description: typeof input.description === 'string' ? input.description.trim() : '',
      ...(input.podId === undefined ? {} : { podId: input.podId.toLowerCase() }),
    },
    problems,
  };
}

/** The task the team is given. The founder's words are the task; the steps are fixed. */
function financeTask(task) {
  return {
    ...(task.podId === undefined ? {} : { podId: task.podId }),
    title: task.title,
    description: [
      task.description || 'No further details were given.',
      '',
      'Pick the part that fits the task, using the skills you were given:',
      '- An invoice: Arjun follows invoice-with-gst and calls invoice.draft. The tool works the tax out; nobody types a tax amount.',
      '- An expense: Arjun follows expense-recording and writes the record with docs.create_draft.',
      '- A contract or an agreement: Leela follows contract-review and reports what it says and what to watch for.',
      '- Personal data or privacy: Leela follows data-privacy-check and reports what is collected and the risks.',
      'Then report using the handoff-notes headings: what was made, what is still for the founder to add or decide, and what was not checked.',
      '',
      'Nobody on this team pays, signs, sends for signature, issues a legal document or sends an invoice: those are the founder\'s decisions, and reaching for one stops you.',
    ].join('\n'),
  };
}

function createFinanceTeam({ factory, decisions, writeCard, onError = () => {} } = {}) {
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

  /** Make the founder's card for a request an agent was stopped on, tied to the pod when there is one. Returns the decision id, or null. */
  async function fileCard(task, taskId, request) {
    try {
      const action = { tool: request.tool, access: request.access, args: request.args ?? {} };
      const card = await writeCard({ task: { id: taskId, title: task.title }, category: request.category, action });
      const filed = await decisions.create({ action, card, ...(task.podId === undefined ? {} : { podId: task.podId }) });
      return filed.id;
    } catch (err) {
      onError(err);
      return null;
    }
  }

  async function workTask(input) {
    const checked = checkTask(input);
    if (!checked.ok) return { status: 'failed', reason: 'bad_task', problems: checked.problems };
    const task = financeTask(checked.task);

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
      const decisionId = await fileCard(task, result.taskId, result.request ?? {});
      if (decisionId === null) return { status: 'failed', reason: 'card_failed', taskId: result.taskId };
      return { status: 'needs_founder', taskId: result.taskId, decisionId };
    }
    if (result.status === 'failed' && result.reason === 'bad_pod') return { status: 'failed', reason: 'bad_pod' };
    return result;
  }

  /**
   * After the founder answers a card this team filed (a payout, a signature, a legal document or a legal question), say plainly what that did: nothing,
   * because the team has no tool for any of them. Null for any other card or answer, and for a support card (those name a ticket).
   */
  async function describeAnswer(decision) {
    if (!isObject(decision) || !isObject(decision.action) || !Object.hasOwn(ASKED_ABOUT, decision.action.tool)) return null;
    if (isObject(decision.action.args) && decision.action.args.ticketId !== undefined) return null;
    const { about, nothing } = ASKED_ABOUT[decision.action.tool];
    if (decision.status === 'approved') return `You approved the card about ${about}. ${nothing}`;
    if (decision.status === 'rejected') return `You said no to the card about ${about}. Nothing was done, and nothing will be unless you ask again.`;
    return null;
  }

  return { workTask, describeAnswer };
}

module.exports = { createFinanceTeam, checkTask, financeTask, TEAM, LEAD, WORKERS };
