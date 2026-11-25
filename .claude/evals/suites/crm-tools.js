'use strict';

// Grades the CRM tools (PLAN.md step 2.3: "store it in the CRM"). The CRM is our own `clients` table, with status `lead`.
//   src/runtime/tools/crm.js   createCrmTools({ store }) -> [crm.find_lead, crm.save_lead]
//
//   crm.find_lead { name?, email? }                    -> { text }   leads, one JSON object per line
//   crm.save_lead { name, email?, country?, notes? }   -> { text }   adds a lead, or updates the one with that email
//
// Runs against a REAL Postgres with the real migrations (scripts/fake-supabase.js). The store uses the service key, which
// bypasses row-level security, so these tools are the protection:
//   - they see and change only rows whose status is `lead`; a client who is active or past is never shown, changed, duplicated
//     or promoted, and no tool argument can set a status
//   - an email is stored in lower case and is the lead's identity: saving it again updates that lead (never a second row); a
//     lead without an email is matched by its exact name
//   - text is plain and cut to a limit, a secret in the notes is removed, and nothing is ever deleted
//   - an error is one plain sentence: never the database's own message

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/tools/crm.js';
const LOADER = 'src/runtime/tools/index.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';
let counter = 0;
const unique = (label) => `${label}-${Date.now().toString(36)}-${counter++}`;

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

async function loaderFor(store) {
  const tools = loadSubject(SUBJECT).createCrmTools({ store });
  const loader = loadSubject(LOADER).createToolLoader({ tools, hasRule: async () => true });
  await loader.load();
  return { tools, loader };
}

async function use(loader, tool, access, args) {
  try {
    const out = await loader.run({ action: { tool, access, args }, key: 'k' });
    return { ok: true, text: out.text };
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return { ok: false, message: err.message };
  }
}
const save = (loader, args) => use(loader, 'crm.save_lead', 'write', args);
const find = (loader, args) => use(loader, 'crm.find_lead', 'read', args);
const rowsWith = async (env, where) => env.store.select('clients', { where });

const cases = [
  {
    id: 'there-are-two-tools-with-the-right-tags-and-policy-rules-and-none-without-a-usable-store',
    async check() {
      const env = await database();
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const tools = loadSubject(SUBJECT).createCrmTools({ store: env.store });
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      const none = [undefined, null, {}, { select: 1 }, { select: async () => [], insert: async () => ({}) }].map((store) => loadSubject(SUBJECT).createCrmTools({ store }).length);
      const ruled = policy.isBuiltIn('crm.find_lead') && policy.isBuiltIn('crm.save_lead') && policy.checkAction({ tool: 'crm.save_lead', access: 'write', args: {} }).allowed === true && policy.checkAction({ tool: 'crm.find_lead', access: 'read', args: {} }).allowed === true;
      return verdict(tools.length === 2 && byName['crm.find_lead']?.access === 'read' && byName['crm.save_lead']?.access === 'write' && tools.every((t) => t.summary.length > 10 && t.args.length > 10) && none.every((n) => n === 0) && ruled, json({ names: tools.map((t) => t.name), none, ruled }));
    },
  },
  {
    id: 'a-new-lead-is-saved-with-status-lead-and-a-lower-case-email-and-found-again',
    async check() {
      const env = await database();
      const { loader } = await loaderFor(env.store);
      const name = unique('Acme Ltd');
      const email = `Ann.${unique('x')}@Acme.Example`;
      const s = await save(loader, { name, email, country: 'IN', notes: 'Runs a small online shop. Source: https://acme.example/about' });
      const rows = await rowsWith(env, { email: email.toLowerCase() });
      const f = await find(loader, { email });
      return verdict(s.ok && /Saved the lead/.test(s.text) && rows.length === 1 && rows[0].status === 'lead' && rows[0].name === name && rows[0].country === 'IN' && f.ok && f.text.includes(name) && f.text.includes(rows[0].id), json({ s, rows, f }));
    },
  },
  {
    id: 'saving-the-same-email-again-updates-that-lead-and-never-adds-a-second-row',
    async check() {
      const env = await database();
      const { loader } = await loaderFor(env.store);
      const email = `${unique('same')}@acme.example`;
      await save(loader, { name: 'Acme', email, notes: 'first' });
      const again = await save(loader, { name: 'Acme Ltd', email: email.toUpperCase(), notes: 'second' });
      const rows = await rowsWith(env, { email });
      return verdict(again.ok && /Updated the lead/.test(again.text) && rows.length === 1 && rows[0].name === 'Acme Ltd' && rows[0].notes === 'second' && rows[0].status === 'lead', json({ again, rows }));
    },
  },
  {
    id: 'a-lead-without-an-email-is-matched-by-its-exact-name-and-not-duplicated',
    async check() {
      const env = await database();
      const { loader } = await loaderFor(env.store);
      const name = unique('No Email Co');
      await save(loader, { name, notes: 'one' });
      const again = await save(loader, { name: name.toUpperCase(), notes: 'two' });
      const rows = (await rowsWith(env, { status: 'lead' })).filter((r) => r.name.toLowerCase() === name.toLowerCase());
      return verdict(again.ok && /Updated/.test(again.text) && rows.length === 1 && rows[0].notes === 'two', json({ again, rows }));
    },
  },
  {
    id: 'a-client-who-is-active-or-past-is-never-shown-changed-or-duplicated',
    async check() {
      const env = await database();
      const { loader } = await loaderFor(env.store);
      const out = [];
      for (const status of ['active', 'past']) {
        const email = `${unique(status)}@client.example`;
        const name = unique(`Client ${status}`);
        const made = await env.store.insert('clients', { name, email, status, notes: 'original' });
        const f = await find(loader, { email });
        const byName = await find(loader, { name });
        const s = await save(loader, { name: 'Hijack', email, notes: 'changed' });
        const after = await rowsWith(env, { email });
        out.push({ status, hidden: f.text === 'No leads found.' && byName.text === 'No leads found.', refused: s.ok && /not a lead/i.test(s.text), unchanged: after.length === 1 && after[0].id === made.id && after[0].status === status && after[0].name === name && after[0].notes === 'original' });
      }
      return verdict(out.every((o) => o.hidden && o.refused && o.unchanged), json(out));
    },
  },
  {
    id: 'no-argument-can-set-a-status-an-id-or-anything-else-and-saved-rows-are-always-leads',
    async check() {
      const env = await database();
      const { loader } = await loaderFor(env.store);
      const before = (await env.store.select('clients', { where: {} })).length;
      for (const extra of [{ status: 'active' }, { id: '00000000-0000-0000-0000-000000000000' }, { created_at: '2020-01-01' }, { updated_at: '2020-01-01' }, { stage: 'won' }]) {
        const r = await save(loader, { name: unique('Sneaky'), ...extra });
        if (r.ok) return verdict(false, `${json(extra)} accepted`);
      }
      const after = (await env.store.select('clients', { where: {} })).length;
      return verdict(before === after, json({ before, after }));
    },
  },
  {
    id: 'bad-arguments-are-refused-and-change-nothing',
    async check() {
      const env = await database();
      const { loader } = await loaderFor(env.store);
      const before = (await env.store.select('clients', { where: {} })).length;
      const badSaves = [{}, { name: '' }, { name: '   ' }, { name: 5 }, { name: 'x'.repeat(201) }, { name: 'A', email: 'not-an-email' }, { name: 'A', email: 'a@x.co, b@x.co' }, { name: 'A', email: 'a@x.co\nBcc: b@x.co' }, { name: 'A', notes: 'n'.repeat(4001) }, { name: 'A', country: 'c'.repeat(61) }, { name: 'A', notes: 5 }, 'name', null];
      for (const args of badSaves) {
        const r = await save(loader, args);
        if (r.ok) return verdict(false, `save accepted ${json(args)}`);
      }
      const badFinds = [{}, { email: 'nope' }, { name: '' }, { name: 5 }, { name: 'a', extra: 1 }, 'a', null];
      for (const args of badFinds) {
        const r = await find(loader, args);
        if (r.ok) return verdict(false, `find accepted ${json(args)}`);
      }
      const after = (await env.store.select('clients', { where: {} })).length;
      return verdict(before === after, json({ before, after }));
    },
  },
  {
    id: 'a-secret-in-the-notes-is-removed-and-control-characters-are-dropped',
    async check() {
      const env = await database();
      const { loader } = await loaderFor(env.store);
      const email = `${unique('secret')}@acme.example`;
      await save(loader, { name: 'Secret Co', email, notes: `Contact page found. key ${SECRET} \u0007 done` });
      const [row] = await rowsWith(env, { email });
      return verdict(row && !row.notes.includes(SECRET) && !row.notes.includes('\u0007') && row.notes.includes('Contact page found'), json(row));
    },
  },
  {
    id: 'find-by-part-of-a-name-ignores-case-and-shows-at-most-twenty',
    async check() {
      const env = await database();
      const { loader } = await loaderFor(env.store);
      const tag = unique('Bulk');
      for (let i = 0; i < 25; i += 1) await env.store.insert('clients', { name: `${tag} Number ${i}`, status: 'lead' });
      const f = await find(loader, { name: tag.toUpperCase() });
      const lines = f.text.split('\n');
      const none = await find(loader, { name: unique('Nothing Like This') });
      return verdict(f.ok && lines.length === 20 && lines.every((l) => JSON.parse(l).name.includes(tag)) && none.text === 'No leads found.', json({ n: lines.length, none }));
    },
  },
  {
    id: 'a-database-failure-is-one-plain-sentence-that-never-shows-the-databases-text',
    async check() {
      const broken = {
        async select() { throw new Error(`database said ${SECRET} postgres://user:pw@host/db`); },
        async insert() { throw new Error('INSERT said postgres://user:pw@host/db'); },
        async update() { throw new Error('UPDATE said postgres://user:pw@host/db'); },
      };
      const tools = loadSubject(SUBJECT).createCrmTools({ store: broken });
      const out = [];
      for (const [tool, args] of [['crm.find_lead', { email: 'a@x.co' }], ['crm.save_lead', { name: 'A', email: 'a@x.co' }]]) {
        out.push(await tools.find((t) => t.name === tool).run({ args }).then(() => 'no error', (err) => err.message));
      }
      const { loader } = await loaderFor(broken);
      const through = await save(loader, { name: 'A' });
      return verdict(out.every((m) => m === 'The lead list could not be used.') && !through.ok && !String(through.message).includes('postgres'), json({ out, through }));
    },
  },
];

module.exports = {
  name: 'crm-tools',
  description: 'CRM tools over the clients table: leads only, never a client; email as identity; no status can be set; plain text, secrets removed; no database error text',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
