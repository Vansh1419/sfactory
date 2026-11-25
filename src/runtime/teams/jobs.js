'use strict';

// Starting a team from the window (PLAN.md Phase 2 follow-up). Graded by the `team-jobs` eval.
//
//   createTeamJobs({ sales, support, engineering?, finance?, emit?, onError?, maxAtOnce? })
//     .startLead({ company, website?, email?, price? }) -> { ok: true, message } | { ok: false, code, message }
//     .startTicket({ ticketId? })                       -> the same: the oldest open ticket, or the one named
//     .startFinance({ title, description?, podId? })    -> the same: a task for the Finance, Legal and Ops team (a project's, or the company's)
//     .startEngineer({ podId, title, description? })    -> the same: a task for the Engineering team inside ONE project
//
// A team takes minutes, so a job is STARTED here and the answer comes back at once ("started", or why not); how it ended is announced later as the
// runtime event `team.job_finished` { kind, status, message }, which the window shows. Whatever the team writes for the founder (a proposal email, a
// reply, a refund request) arrives as its own card, as always. At most two jobs run at once.
//
//   - the lead's details are checked here (plain text, one email address, an https web address) before any team or model sees them
//   - a ticket is named by its id only (a uuid): the team reads its words itself
//   - the message the window shows is made of fixed sentences and the team's own plain reasons; never a model's or a database's text, and an error
//     goes to onError and becomes one generic sentence

const { checkLead } = require('./marketing-sales');
const { checkTask: checkFinanceTask } = require('./finance-legal-ops');
const { checkTask: checkEngineeringTask } = require('./engineering');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AT_ONCE = 2;
const MAX_MESSAGE_CHARS = 400;

const REASONS = Object.freeze({
  team_unavailable: 'The team is not available right now.',
  team_stopped: 'That team is switched off. Switch it on again first.',
  not_available: 'That ticket is not open any more (it may already be taken, answered or closed).',
  bad_ticket: 'That is not a ticket id.',
  card_failed: 'A card for you could not be written, so the ticket was put back to open.',
  not_answered: 'The team finished without answering it, so the ticket was put back to open.',
  store_failed: 'The ticket list could not be read.',
});

const clip = (text) => (text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text);

/** What the founder is told when a job ends. */
function describe(kind, result) {
  switch (result?.status) {
    case 'done':
      if (kind === 'finance') return 'The Finance, Legal and Ops team finished. If it drafted an invoice or a record, the draft is in its task. Nothing was paid, signed or sent.';
      if (kind === 'engineering') return 'The Engineering team finished. If it opened a pull request, it is waiting on GitHub for a person to merge it. Nothing went live.';
      return kind === 'lead'
        ? 'The sales team finished. If it wrote a proposal email, it is waiting for you as a card. If there is no card, it decided not to write one.'
        : 'The support team answered the ticket. The reply is waiting for you as a card. Nothing was sent to the customer.';
    case 'needs_founder':
      if (kind === 'finance') return 'The team needs your decision on something. The card is waiting for you. Nothing was paid, signed or sent.';
      if (kind === 'engineering') return 'The team needs your decision on something. The card is waiting for you. Nothing was merged and nothing went live.';
      return 'The team needs your decision on something. The card is waiting for you. Nothing was sent to anyone.';
    case 'none':
      return 'There are no open tickets.';
    case 'blocked':
      return clip(`The team could not finish. ${typeof result.reason === 'string' ? result.reason : ''}`.trim());
    case 'failed':
      if (result.reason === 'bad_lead') return clip(`The lead could not be used. ${(Array.isArray(result.problems) ? result.problems : []).filter((p) => typeof p === 'string').join(' ')}`.trim());
      return REASONS[result.reason] ?? 'The team could not do that.';
    default:
      return 'The team stopped.';
  }
}

function createTeamJobs({ sales, support, engineering, finance, emit = () => {}, onError = () => {}, maxAtOnce = MAX_AT_ONCE } = {}) {
  let running = 0;

  const announce = (kind, result) => {
    try {
      emit('team.job_finished', { kind, status: typeof result?.status === 'string' ? result.status : 'failed', message: describe(kind, result) });
    } catch (err) {
      onError(err);
    }
  };

  /** Start a job in the background. Never rejects: a failure goes to onError and the founder is told one generic sentence. */
  function launch(kind, run) {
    running += 1;
    let started;
    try {
      started = Promise.resolve(run()); // the team is called at once, not a tick later
    } catch (err) {
      started = Promise.reject(err);
    }
    started
      .then((result) => announce(kind, result), (err) => {
        onError(err);
        announce(kind, { status: 'failed', reason: 'error' });
      })
      .finally(() => {
        running -= 1;
      });
  }

  const busy = () => ({ ok: false, code: 'busy', message: `${maxAtOnce} team jobs are already running. Please wait for one to finish.` });

  return {
    startLead(input) {
      if (!sales || typeof sales.workLead !== 'function') return { ok: false, code: 'not_available', message: 'The sales team is not available right now.' };
      const checked = checkLead(input);
      if (!checked.ok) return { ok: false, code: 'invalid_lead', message: clip(`The lead could not be used. ${checked.problems.join(' ')}`) };
      if (running >= maxAtOnce) return busy();
      launch('lead', () => sales.workLead(checked.lead));
      return { ok: true, message: 'Started. The sales team is working on it. Any email it writes arrives as a card, and the result shows here.' };
    },

    startTicket(input) {
      if (!support || typeof support.workNext !== 'function') return { ok: false, code: 'not_available', message: 'The support team is not available right now.' };
      const ticketId = input !== null && typeof input === 'object' ? input.ticketId : undefined;
      if (ticketId !== undefined && !(typeof ticketId === 'string' && UUID.test(ticketId))) return { ok: false, code: 'invalid_ticket', message: 'That is not a ticket id.' };
      if (running >= maxAtOnce) return busy();
      launch('ticket', () => (ticketId === undefined ? support.workNext() : support.workTicket({ ticketId })));
      return { ok: true, message: 'Started. The support team is working on it. Its reply arrives as a card, and the result shows here.' };
    },

    startFinance(input) {
      if (!finance || typeof finance.workTask !== 'function') return { ok: false, code: 'not_available', message: 'The finance team is not available right now.' };
      const checked = checkFinanceTask(input);
      if (!checked.ok) return { ok: false, code: 'invalid_task', message: clip(`That task could not be used. ${checked.problems.join(' ')}`) };
      if (running >= maxAtOnce) return busy();
      launch('finance', () => finance.workTask(checked.task));
      return { ok: true, message: 'Started. The finance team is working on it. Anything it needs from you arrives as a card, and the result shows here.' };
    },

    startEngineer(input) {
      if (!engineering || typeof engineering.workTask !== 'function') return { ok: false, code: 'not_available', message: 'The engineering team is not available right now.' };
      const checked = checkEngineeringTask(input);
      if (!checked.ok) return { ok: false, code: 'invalid_task', message: clip(`That task could not be used. ${checked.problems.join(' ')}`) };
      if (running >= maxAtOnce) return busy();
      launch('engineering', () => engineering.workTask({ podId: checked.task.podId, title: checked.task.title, ...(checked.task.description === '' ? {} : { description: checked.task.description }) }));
      return { ok: true, message: 'Started. The engineering team is working on it inside that project. A merge or a deploy arrives as a card, and the result shows here.' };
    },

    running: () => running,
  };
}

module.exports = { createTeamJobs, describe };
