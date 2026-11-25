'use strict';

// Grades the support ticket tools (PLAN.md step 2.4):
//   src/runtime/tools/tickets.js   createTicketTools({ store, outbound }) -> [tickets.get, tickets.mark_answered]
//
//   tickets.get            { ticketId }             -> { text }   the customer's message, for a ticket a team has taken (in_progress)
//   tickets.mark_answered  { ticketId, messageId }  -> { text }   records the answer, with the reply that went through the outbound gate
//
// Runs against a REAL Postgres with the real migrations (the `tickets` table and its rules). The store uses the service key, which
// bypasses row-level security, so these tools are the protection:
//   - only a ticket that is in progress can be read: an agent cannot go through other customers' tickets
//   - a ticket is `answered` only with a real reply: a SUPPORT message, addressed to THIS ticket's customer, that passed review; the reply
//     is checked through the outbound service's `get`, never by reading its table; answering is one step, so it happens once
//   - an error is one plain sentence: never the database's own message
//
// The outbound service is a stand-in whose `get` answers with the view each case gives it (status, team, address); the message ROWS
// are real, because a ticket's reply is a foreign key to the outbound messages table.

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/tools/tickets.js';
const LOADER = 'src/runtime/tools/index.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';
const uuid = () => require('node:crypto').randomUUID();
let counter = 0;
const unique = (label) => `${label}${Date.now().toString(36)}${counter++}`;

let environment = null;
async function database() {
  if (!environment) {
    const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
    const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
    const fake = await startFakeSupabase();
    environment = { fake, store: createRestStore({ url: fake.url, serviceKey: fake.serviceKey }) };
  }
  return environment;
}

/** A stand-in for the outbound service's `get`: it knows the views the case gives it, and records every id it is asked about. */
function fakeOutbound(views = []) {
  const byId = new Map(views.map((m) => [m.id, m]));
  return { calls: [], async get(id) { this.calls.push(id); return byId.get(id) ?? null; } };
}

/** A real outbound message row (the foreign key needs it) and the view the outbound service would give for it. */
async function reply(env, over = {}) {
  const row = await env.store.insert('outbound_messages', { team: 'support', to_address: 'ann@example.com', subject: unique('Re: help '), body: 'Hello Ann, thanks for writing to us.', founder_approval_required: false });
  return { id: row.id, team: 'support', to_address: 'ann@example.com', status: 'awaiting_founder', ...over };
}

async function ticket(env, over = {}) {
  return env.store.insert('tickets', { customer_email: 'ann@example.com', customer_name: 'Ann', subject: unique('Where is my order '), body: 'It has not arrived yet.', ...over });
}
const take = (env, id) => env.store.update('tickets', { id, status: 'open' }, { status: 'in_progress' });
const row = async (env, id) => (await env.store.select('tickets', { where: { id } }))[0];

async function setup(outbound, store) {
  const env = await database();
  const tools = loadSubject(SUBJECT).createTicketTools({ store: store ?? env.store, outbound });
  const loader = loadSubject(LOADER).createToolLoader({ tools, hasRule: async () => true });
  await loader.load();
  const use = async (tool, access, args) => {
    try {
      const out = await loader.run({ action: { tool, access, args }, key: 'k' });
      return { ok: true, text: out.text };
    } catch (err) {
      if (err.constructor.name === 'PendingError') throw err;
      return { ok: false, message: err.message };
    }
  };
  return { env, tools, get: (args) => use('tickets.get', 'read', args), mark: (args) => use('tickets.mark_answered', 'write', args) };
}

const cases = [
  {
    id: 'there-are-two-tools-with-the-right-tags-and-policy-rules-and-none-without-a-store-and-the-outbound-service',
    async check() {
      const env = await database();
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const tools = loadSubject(SUBJECT).createTicketTools({ store: env.store, outbound: fakeOutbound() });
      const tags = Object.fromEntries(tools.map((t) => [t.name, t.access]));
      const none = [{}, { store: env.store }, { outbound: fakeOutbound() }, { store: { select: 1 }, outbound: fakeOutbound() }, { store: env.store, outbound: {} }].map((a) => loadSubject(SUBJECT).createTicketTools(a).length);
      const ruled = policy.checkAction({ tool: 'tickets.get', access: 'read', args: {} }).allowed === true && policy.checkAction({ tool: 'tickets.mark_answered', access: 'write', args: {} }).allowed === true;
      return verdict(json(tags) === json({ 'tickets.get': 'read', 'tickets.mark_answered': 'write' }) && none.every((n) => n === 0) && ruled && tools.every((t) => t.summary.length > 10 && t.args.length > 10), json({ tags, none, ruled }));
    },
  },
  {
    id: 'a-ticket-can-be-read-only-while-a-team-has-it-in-progress',
    async check() {
      const h = await setup(fakeOutbound());
      const t = await ticket(h.env, { body: 'Please help with my invoice.' });
      const before = await h.get({ ticketId: t.id });
      await take(h.env, t.id);
      const during = await h.get({ ticketId: t.id });
      const missing = await h.get({ ticketId: uuid() });
      return verdict(/no such ticket/i.test(before.text) && !before.text.includes('invoice') && during.ok && during.text.includes('From: Ann <ann@example.com>') && during.text.includes(`Subject: ${t.subject}`) && during.text.includes('Please help with my invoice.') && /no such ticket/i.test(missing.text), json({ before, during, missing }));
    },
  },
  {
    id: 'once-a-ticket-is-answered-it-can-no-longer-be-read-through-the-tool',
    async check() {
      const env = await database();
      const m = await reply(env);
      const h = await setup(fakeOutbound([m]));
      const t = await ticket(env, { body: 'Private details from the customer.' });
      await take(env, t.id);
      await h.mark({ ticketId: t.id, messageId: m.id });
      const r = await h.get({ ticketId: t.id });
      return verdict((await row(env, t.id)).status === 'answered' && /no such ticket/i.test(r.text) && !r.text.includes('Private details'), json(r));
    },
  },
  {
    id: 'a-long-customer-message-is-cut-and-bad-ids-never-reach-the-database',
    async check() {
      const env = await database();
      const calls = [];
      const spy = { select: async (...a) => { calls.push(a); return env.store.select(...a); }, update: async (...a) => { calls.push(a); return env.store.update(...a); } };
      const h = await setup(fakeOutbound(), spy);
      const t = await ticket(env, { body: 'x'.repeat(19_900) });
      await take(env, t.id);
      const long = await h.get({ ticketId: t.id });
      calls.length = 0;
      for (const args of [{}, { ticketId: '' }, { ticketId: 5 }, { ticketId: 'not-an-id' }, { ticketId: `${t.id}'; drop table tickets` }, { ticketId: t.id, extra: 1 }, 'x', null]) {
        const r = await h.get(args);
        if (r.ok) return verdict(false, `get accepted ${json(args)}`);
      }
      for (const args of [{ ticketId: t.id }, { messageId: uuid() }, { ticketId: t.id, messageId: 'nope' }, { ticketId: 'nope', messageId: uuid() }, { ticketId: t.id, messageId: uuid(), status: 'answered' }]) {
        const r = await h.mark(args);
        if (r.ok) return verdict(false, `mark accepted ${json(args)}`);
      }
      return verdict(long.ok && long.text.length <= 20_000 && /Shortened/.test(long.text) && calls.length === 0, json({ len: long.text?.length, calls: calls.length }));
    },
  },
  {
    id: 'a-ticket-is-answered-with-a-reviewed-support-reply-to-its-customer-and-the-link-is-recorded',
    async check() {
      for (const status of ['awaiting_founder', 'ready', 'sent']) {
        const env = await database();
        const m = await reply(env, { status, to_address: 'ANN@Example.com' }); // the address is matched without regard to case
        const h = await setup(fakeOutbound([m]));
        const t = await ticket(env);
        await take(env, t.id);
        const r = await h.mark({ ticketId: t.id, messageId: m.id });
        const after = await row(env, t.id);
        if (!r.ok || !/recorded as answered/.test(r.text) || after.status !== 'answered' || after.reply_message_id !== m.id) return verdict(false, json({ status, r, after: [after.status, after.reply_message_id] }));
      }
      return verdict(true);
    },
  },
  {
    id: 'a-ticket-is-not-answered-by-a-reply-that-is-for-someone-else-from-another-team-unreviewed-or-missing',
    async check() {
      const env = await database();
      const problems = [];
      const scenarios = [
        ['another customer', { to_address: 'bob@example.com' }],
        ['the sales team', { team: 'marketing_sales' }],
        ['a draft', { status: 'drafted' }],
        ['a failed review', { status: 'review_failed' }],
        ['a rejected message', { status: 'rejected' }],
        ['a cancelled message', { status: 'cancelled' }],
        ['a send that failed', { status: 'send_failed' }],
        ['no such message', null],
      ];
      for (const [label, over] of scenarios) {
        const m = over ? await reply(env, over) : null;
        const h = await setup(fakeOutbound(m ? [m] : []));
        const t = await ticket(env);
        await take(env, t.id);
        const r = await h.mark({ ticketId: t.id, messageId: m?.id ?? uuid() });
        const after = await row(env, t.id);
        if (!r.ok || !/^Not recorded/.test(r.text) || after.status !== 'in_progress' || after.reply_message_id) problems.push(`${label}: ${json({ r, status: after.status })}`);
      }
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'a-ticket-that-is-not-in-progress-cannot-be-answered-and-an-answered-one-is-not-answered-twice',
    async check() {
      const env = await database();
      const m = await reply(env);
      const h = await setup(fakeOutbound([m]));
      const open = await ticket(env);
      const refusedOpen = await h.mark({ ticketId: open.id, messageId: m.id });
      const t = await ticket(env);
      await take(env, t.id);
      const first = await h.mark({ ticketId: t.id, messageId: m.id });
      const second = await h.mark({ ticketId: t.id, messageId: uuid() });
      const after = await row(env, t.id);
      const stillOpen = await row(env, open.id);
      return verdict(/^Not recorded/.test(refusedOpen.text) && stillOpen.status === 'open' && /recorded as answered/.test(first.text) && /^Not recorded/.test(second.text) && after.status === 'answered' && after.reply_message_id === m.id, json({ refusedOpen, first, second, after: [after.status, after.reply_message_id] }));
    },
  },
  {
    id: 'the-reply-is-checked-through-the-outbound-service-and-the-tool-never-reads-the-messages-table',
    async check() {
      const env = await database();
      const tables = [];
      const spy = { select: async (table, o) => { tables.push(table); return env.store.select(table, o); }, update: async (table, w, p) => { tables.push(table); return env.store.update(table, w, p); }, insert: async () => { throw new Error('INSERT REACHED'); } };
      const m = await reply(env);
      const outbound = fakeOutbound([m]);
      const h = await setup(outbound, spy);
      const t = await ticket(env);
      await take(env, t.id);
      await h.mark({ ticketId: t.id, messageId: m.id });
      return verdict(outbound.calls.length === 1 && outbound.calls[0] === m.id && tables.length > 0 && tables.every((x) => x === 'tickets'), json({ outboundCalls: outbound.calls.length, tables }));
    },
  },
  {
    id: 'a-database-failure-is-one-plain-sentence-that-never-shows-the-databases-text',
    async check() {
      const broken = {
        async select() { throw new Error(`database said ${SECRET} postgres://user:pw@host/db`); },
        async update() { throw new Error('UPDATE said postgres://user:pw@host/db'); },
      };
      const tools = loadSubject(SUBJECT).createTicketTools({ store: broken, outbound: fakeOutbound() });
      const direct = [];
      for (const [name, args] of [['tickets.get', { ticketId: uuid() }], ['tickets.mark_answered', { ticketId: uuid(), messageId: uuid() }]]) {
        direct.push(await tools.find((t) => t.name === name).run({ args }).then(() => 'no error', (err) => err.message));
      }
      const h = await setup(fakeOutbound(), broken);
      const through = await h.get({ ticketId: uuid() });
      return verdict(direct.every((m) => m === 'The ticket could not be used.') && !through.ok && !String(through.message).includes('postgres'), json({ direct, through }));
    },
  },
];

module.exports = {
  name: 'ticket-tools',
  description: 'Support ticket tools: read only a ticket a team has taken; answer only with a reviewed support reply to that customer, once; checked through the outbound service; plain errors',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
