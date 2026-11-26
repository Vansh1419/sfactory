'use strict';

// The Engineering team (PLAN.md step 3.3). Graded by the `engineering-team` eval.
//
//   createEngineeringTeam({ factory, decisions, writeCard, onError? })
//     .workTask({ podId, title, description? })
//       -> { status: 'done', taskId, outputs }
//        | { status: 'blocked', taskId, reason }
//        | { status: 'needs_founder', taskId, decisionId }
//        | { status: 'failed', reason: 'bad_task' | 'bad_pod' | 'team_unavailable' | 'card_failed' | 'error', problems? }
//     .resume({ taskId, podId, title, description?, approvedTool }) -> the same results: carries on with a task blocked on a card the founder approved
//     .describeAnswer(decision) -> a plain follow-up for the founder after they answer one of this team's cards, or null
//
// One piece of work goes through the team inside ONE pod (a project's own space): Dev makes the change on a branch, saves it, sends it to the project's GitHub
// repository and opens a pull request; Tess reviews the branch and checks what can be checked; Kavya, the lead, plans that and accepts each piece of work
// (the framework of step 2.1). Every tool run belongs to the pod, so nothing of another project is reachable (step 3.2).
//
// Nothing here can change what is live. There is no tool that merges or deploys: an agent that reaches for `github.merge_pull_request` or a production
// `vercel.deploy` is stopped by the policy, and THIS code turns the request into a plain-language card for the founder (tied to the pod) and leaves the
// task blocked. The card records the answer; it does not run anything, and the follow-up says so.

const TEAM = 'product_engineering';
const LEAD = Object.freeze({ name: 'Kavya' });
const WORKERS = Object.freeze([
  Object.freeze({ name: 'Dev', summary: "builds a change on a branch in the project, saves it, sends it to the project's GitHub repository and opens a pull request" }),
  Object.freeze({ name: 'Tess', summary: 'reviews the branch the builder made, checks what can be checked (including a preview page in a browser), and reports what was and was not checked' }),
]);

// What one worker of this team may use in one run. The shared allowance (10 steps, 60,000 tokens) is too small for the git workflow: on the first real
// run (Nov 26, 2026) Dev pushed the branch and then ran out one step before opening the pull request. About eleven model calls are needed, each carrying
// the skills. These are still held to the absolute caps in agents/agent.js (20 steps, 100,000 tokens).
const LIMITS = Object.freeze({ maxSteps: 16, maxTokens: 100_000 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4000;
const PLAIN_LINE = /^[^\u0000-\u001f\u007f]+$/;
const PLAIN_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/; // line breaks allowed
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// What each card this team can file is about, in words the founder uses. Anything else is "something that could change what is live".
const ASKED_ABOUT = Object.freeze({
  'github.merge_pull_request': 'merging a pull request',
  'vercel.deploy': 'putting a version live',
});

/** The task's details, checked. Returns { ok, task?, problems }. */
function checkTask(input) {
  if (!isObject(input)) return { ok: false, problems: ['The task is not valid.'] };
  const problems = [];
  const extra = Object.keys(input).find((k) => !['podId', 'title', 'description'].includes(k));
  if (extra) problems.push('Only the project, a title and a description can be given.');
  if (typeof input.podId !== 'string' || !UUID.test(input.podId)) problems.push('The project (pod) id is not valid.');
  if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > MAX_TITLE_CHARS || !PLAIN_LINE.test(input.title.trim())) problems.push('The title is not valid.');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_CHARS || (input.description !== '' && !PLAIN_TEXT.test(input.description)))) problems.push('The description is not valid.');
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  return { ok: true, task: { podId: input.podId.toLowerCase(), title: input.title.trim(), description: typeof input.description === 'string' ? input.description.trim() : '' }, problems };
}

/** The task the team is given. The founder's words are the task; the steps are fixed. */
function engineeringTask(task) {
  return {
    podId: task.podId,
    title: task.title,
    description: [
      task.description || 'No further details were given.',
      '',
      'You work inside this one project. Steps, in this order:',
      '1. Dev: look at the project (pod.info, git.status, the files), then follow the git-workflow skill: make the change on a new branch, save it, send the branch and open a pull request. If the project has no GitHub repository, stop after saving and say so.',
      '2. Tess: review the branch with the code-review and testing skills, using git.diff and the files. Report what you checked, what you could not run and what is still untested. Do not change files.',
      '3. Report: the branch, the pull request address if one was opened, the review verdict and what is left. Use the handoff-notes headings.',
      '',
      'Nobody merges a pull request or puts anything live: that is the founder\'s decision, and trying stops you.',
    ].join('\n'),
  };
}

function createEngineeringTeam({ factory, decisions, writeCard, onError = () => {} } = {}) {
  let building = null;

  function ensureTeam() {
    building ??= factory.buildTeam({ team: TEAM, lead: { ...LEAD }, workers: WORKERS.map((w) => ({ ...w })), limits: { ...LIMITS } }).then((built) => {
      if (!built.ok) building = null; // try again next time
      return built;
    }, (err) => {
      building = null;
      throw err;
    });
    return building;
  }

  /** Make the founder's card for a request an agent was stopped on, tied to the pod. Returns the decision id, or null. */
  async function fileCard(podId, taskId, title, request) {
    try {
      const action = { tool: request.tool, access: request.access, args: request.args ?? {} };
      const card = await writeCard({ task: { id: taskId, title }, category: request.category, action });
      const filed = await decisions.create({ action, card, podId, taskId });
      return filed.id;
    } catch (err) {
      onError(err);
      return null;
    }
  }

  /** Run one prepared task through the team (a new task, or `resumeTaskId`'s own row carrying on). */
  async function run(task, resumeTaskId, resumeNote) {
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
      result = await built.team.runTask(resumeTaskId ? { ...task, resumeTaskId, ...(resumeNote ? { resumeNote } : {}) } : task);
    } catch (err) {
      onError(err);
      return { status: 'failed', reason: 'error' };
    }
    if (result.status === 'needs_founder') {
      const decisionId = await fileCard(task.podId, result.taskId, task.title, result.request ?? {});
      if (decisionId === null) return { status: 'failed', reason: 'card_failed', taskId: result.taskId };
      return { status: 'needs_founder', taskId: result.taskId, decisionId };
    }
    if (result.status === 'failed' && result.reason === 'bad_pod') return { status: 'failed', reason: 'bad_pod' };
    return result;
  }

  async function workTask(input) {
    const checked = checkTask(input);
    if (!checked.ok) return { status: 'failed', reason: 'bad_task', problems: checked.problems };
    return run(engineeringTask(checked.task));
  }

  /**
   * Carry on with a task that was blocked on a card the founder has now APPROVED (it keeps its own row). The approval is only the founder's answer: the team is
   * told so, that nothing was merged or put live by it, and to finish the rest and say what is left for a person. Called by the task resumer, never by an agent.
   */
  async function resume(input) {
    const known = isObject(input) && typeof input.taskId === 'string' && UUID.test(input.taskId) && typeof input.podId === 'string' && UUID.test(input.podId) && typeof input.title === 'string' && input.title.trim() !== '' && Object.hasOwn(ASKED_ABOUT, input.approvedTool);
    if (!known) return { status: 'failed', reason: 'bad_task' };
    const original = typeof input.description === 'string' ? input.description.trim().slice(0, 9000) : '';
    const done = input.approvedTool === 'vercel.deploy'
      ? 'The system starts the production deploy itself now that it is approved, so do not try to deploy again, and you have no tool that does it. Do not say it is live: you cannot see the result.'
      : 'Nothing was merged or put live by it, and you have no tool that does either.';
    const note = `The founder approved this on their card (${ASKED_ABOUT[input.approvedTool]}). That approval is only their answer. ${done} Carry on with the rest of the task, and in your report say what is still left for a person to do.`;
    return run({ podId: input.podId.toLowerCase(), title: input.title.trim(), description: original || 'No further details were given.' }, input.taskId.toLowerCase(), note);
  }

  /**
   * After the founder answers a card this team filed (a merge or a deploy), say plainly what that did: a merge does nothing (the team has no tool for it); a production deploy
   * is started by the SYSTEM (deployer.js), which reports how it went separately.
   * Null for any other card or answer.
   */
  async function describeAnswer(decision) {
    if (!isObject(decision) || !isObject(decision.action) || !Object.hasOwn(ASKED_ABOUT, decision.action.tool) || !decision.pod_id) return null;
    const about = ASKED_ABOUT[decision.action.tool];
    const deploy = decision.action.tool === 'vercel.deploy';
    if (decision.status === 'approved' && decision.task_id) {
      return deploy
        ? `You approved the card about ${about}. The system starts the production deploy now (the Engineering team cannot do it by itself) and will tell you how it went. The team is picking the task up again to finish the rest, and will tell you if it needs you.`
        : `You approved the card about ${about}. Nothing was merged or put live by that: the Engineering team cannot do it by itself. The team is picking the task up again to finish the rest, and will tell you if it needs you.`;
    }
    if (decision.status === 'approved') {
      return deploy
        ? `You approved the card about ${about}. The system starts the production deploy now (the Engineering team cannot do it by itself) and will tell you how it went.`
        : `You approved the card about ${about}. Nothing was done: the Engineering team cannot do it by itself. The pull request is waiting on GitHub, and merging it is for you to do.`;
    }
    if (decision.status === 'rejected') return `You said no to the card about ${about}. Nothing was done, and nothing will be unless you ask again.`;
    return null;
  }

  return { workTask, resume, describeAnswer };
}

module.exports = { createEngineeringTeam, checkTask, engineeringTask, TEAM, LEAD, WORKERS, LIMITS };
