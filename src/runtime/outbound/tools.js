'use strict';

// The two tools an agent uses to send a client email (PLAN.md step 2.2). Graded by the `outbound-gate` eval.
//
//   email.submit { to, subject, body }  write   puts the message through the gate: checked, saved, reviewed, and either ready
//                                               or waiting for the founder's card
//   email.send   { messageId }          write   sends a message that is READY; anything else is "not sent" with the reason
//
// Both are routine for the policy because the gate is inside the tools. The team comes from the RUN (the context the agent
// passes), never from the model, so an agent cannot file a message under another team. Agents send only a message id, never
// text: what goes out is the stored text that was reviewed. A refusal comes back as plain text the agent can read.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_CHARS = 21_000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (args, keys) => Object.keys(args).find((k) => !keys.includes(k));

const WHY_NOT_SENT = Object.freeze({
  not_reviewed: 'Not sent: it has not been reviewed.',
  review_failed: 'Not sent: the review did not approve it. Write a new message that fixes the problems.',
  waiting_for_founder: 'Not sent yet: it is waiting for the founder to approve it. Do not try to send it another way.',
  rejected: 'Not sent: the founder said no.',
  cancelled: 'Not sent: it was cancelled.',
  already_sent: 'Not sent again: it was already sent.',
  already_sending: 'Not sent again: it is already being sent.',
  send_failed_earlier: 'Not sent: sending it failed earlier and it is not tried again.',
  no_mail_account: 'Not sent: no mail account is connected yet.',
  content_changed: 'Not sent: the stored message does not match what was reviewed.',
  not_found: 'Not sent: there is no such message.',
  send_failed: 'Not sent: the mail could not be delivered.',
});

function createOutboundTools({ outbound } = {}) {
  if (!outbound || typeof outbound.submit !== 'function' || typeof outbound.send !== 'function') return [];

  return [
    Object.freeze({
      name: 'email.submit',
      access: 'write',
      summary: 'Writes an email to ONE client and puts it through review. It is NOT sent. If the review passes it is either ready or waits for the founder to approve it; you get a message id.',
      args: '{ "to": one email address, "subject": one line, "body": the full text, finished (no [placeholders]) }',
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = onlyKeys(args, ['to', 'subject', 'body']);
        if (extra) return `unknown argument: ${extra}`;
        if (typeof args.to !== 'string' || typeof args.subject !== 'string' || typeof args.body !== 'string') return 'to, subject and body must be text';
        if (args.to.length + args.subject.length + args.body.length > MAX_TEXT_CHARS) return 'the message is too long';
        return null;
      },
      async run({ args, context }) {
        const team = context?.team;
        if (typeof team !== 'string') throw new Error('no team');
        const result = await outbound.submit({ team, agentId: context?.agentId, to: args.to, subject: args.subject, body: args.body });
        if (result.status === 'ready') return { text: `Reviewed and ready to send. Message id: ${result.messageId}. Use email.send with this id.` };
        if (result.status === 'awaiting_founder') {
          return { text: `Reviewed. The founder must approve it first: a card was sent to them. Message id: ${result.messageId}. It will not send until they approve; try email.send with this id later.` };
        }
        return { text: `Not accepted (${result.status}): ${(result.problems ?? []).join(' ')}`.trim() };
      },
    }),
    Object.freeze({
      name: 'email.send',
      access: 'write',
      summary: 'Sends a message that has passed review (and, while required, the founder\'s approval). You give only its message id; what goes out is the stored, reviewed text.',
      args: '{ "messageId": the id email.submit gave you }',
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = onlyKeys(args, ['messageId']);
        if (extra) return `unknown argument: ${extra}`;
        return typeof args.messageId === 'string' && UUID.test(args.messageId) ? null : 'messageId must be the id email.submit gave you';
      },
      async run({ args }) {
        const result = await outbound.send({ messageId: args.messageId });
        if (result.ok) return { text: 'Sent.' };
        return { text: WHY_NOT_SENT[result.reason] ?? 'Not sent.' };
      },
    }),
  ];
}

module.exports = { createOutboundTools };
