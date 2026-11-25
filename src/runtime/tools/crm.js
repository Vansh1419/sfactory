'use strict';

// The CRM tools (PLAN.md step 2.3: "store it in the CRM"). The CRM is our own `clients` table, with status `lead`; HubSpot
// can replace it later behind the same tool names. Graded by the `crm-tools` eval.
//
//   crm.find_lead  { name?, email? }                                  read    leads matching, one per line
//   crm.save_lead  { name, email?, country?, notes? }                 write   adds a lead, or updates the lead with that email
//
// The store uses the SERVICE key, which bypasses row-level security, so these tools are the protection:
//   - they only ever see and change rows whose status is `lead`. A client who is active or past is never shown, changed or
//     promoted, and a lead is never given any other status from here: that is the founder's decision
//   - nothing is ever deleted
//   - an email is stored in lower case and is the lead's identity: saving the same email again updates that lead, so a
//     lead is never twice in the list. A lead with no email is matched by its exact name
//   - text is plain: control characters are removed, fields are cut to a limit, and a secret in the notes is removed
//   - an error is one plain sentence: never the database's own message

const { redactDetail } = require('../audit');

const MAX_NAME_CHARS = 200;
const MAX_NOTES_CHARS = 4_000;
const MAX_COUNTRY_CHARS = 60;
const MAX_LEADS_SHOWN = 20;
const MAX_LEADS_READ = 200;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000
const FAILED = 'The lead list could not be used.';
const EMAIL = /^[^\s@,;<>()[\]\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (args, keys) => Object.keys(args).find((k) => !keys.includes(k));
// eslint-disable-next-line no-control-regex
const plain = (v, max) => String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

function createCrmTools({ store } = {}) {
  if (!store || typeof store.select !== 'function' || typeof store.insert !== 'function' || typeof store.update !== 'function') return [];

  const leads = async (where = {}) => {
    const rows = await store.select('clients', { where: { ...where, status: 'lead' }, order: 'created_at.desc', limit: MAX_LEADS_READ });
    if (!Array.isArray(rows)) throw new Error(FAILED);
    return rows.filter((r) => r.status === 'lead');
  };

  const show = (r) => JSON.stringify({ id: r.id, name: r.name, email: r.email ?? null, country: r.country ?? null, notes: r.notes ?? null });

  return [
    Object.freeze({
      name: 'crm.find_lead',
      access: 'read',
      summary: 'Looks up leads in the company\'s lead list by email or by part of the name, and gives them back one per line. Only leads are shown, never clients.',
      args: '{ "email": optional, one email address, "name": optional, part of the name }  (give at least one)',
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        if (onlyKeys(args, ['name', 'email'])) return 'unknown argument';
        if (args.name === undefined && args.email === undefined) return 'give an email or a name';
        if (args.email !== undefined && !(typeof args.email === 'string' && EMAIL.test(args.email.trim()))) return 'email must be one email address';
        if (args.name !== undefined && !isText(args.name, MAX_NAME_CHARS)) return 'name must be plain text';
        return null;
      },
      async run({ args }) {
        let rows;
        try {
          rows = await leads(args.email === undefined ? {} : { email: args.email.trim().toLowerCase() });
        } catch {
          throw new Error(FAILED);
        }
        if (args.name !== undefined) {
          const wanted = args.name.trim().toLowerCase();
          rows = rows.filter((r) => typeof r.name === 'string' && r.name.toLowerCase().includes(wanted));
        }
        rows = rows.slice(0, MAX_LEADS_SHOWN);
        if (rows.length === 0) return { text: 'No leads found.' };
        const text = rows.map(show).join('\n');
        return { text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text };
      },
    }),
    Object.freeze({
      name: 'crm.save_lead',
      access: 'write',
      summary: 'Saves a lead in the company\'s lead list. If a lead with the same email is already there, its details are updated instead. It never changes a client and never deletes anything.',
      args: `{ "name": the company or person, "email": optional, one email address, "country": optional, "notes": optional, what we learned about them (at most ${MAX_NOTES_CHARS} characters) }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        if (onlyKeys(args, ['name', 'email', 'country', 'notes'])) return 'unknown argument';
        if (!isText(args.name, MAX_NAME_CHARS)) return 'name is needed, as plain text';
        if (args.email !== undefined && !(typeof args.email === 'string' && EMAIL.test(args.email.trim()))) return 'email must be one email address';
        if (args.country !== undefined && !isText(args.country, MAX_COUNTRY_CHARS)) return 'country must be plain text';
        if (args.notes !== undefined && !(typeof args.notes === 'string' && args.notes.length <= MAX_NOTES_CHARS)) return `notes must be text of at most ${MAX_NOTES_CHARS} characters`;
        return null;
      },
      async run({ args }) {
        const email = args.email === undefined ? undefined : args.email.trim().toLowerCase();
        const fields = {
          name: plain(args.name, MAX_NAME_CHARS),
          ...(email === undefined ? {} : { email }),
          ...(args.country === undefined ? {} : { country: plain(args.country, MAX_COUNTRY_CHARS) }),
          ...(args.notes === undefined ? {} : { notes: plain(redactDetail(args.notes), MAX_NOTES_CHARS) }),
        };
        try {
          const existing = email === undefined
            ? (await leads()).find((r) => r.email == null && typeof r.name === 'string' && r.name.toLowerCase() === fields.name.toLowerCase())
            : (await leads({ email }))[0];
          if (existing) {
            // Only a row that is STILL a lead is changed, in one step.
            const changed = await store.update('clients', { id: existing.id, status: 'lead' }, { ...fields, updated_at: new Date().toISOString() });
            if (!Array.isArray(changed) || changed.length === 0) throw new Error(FAILED);
            return { text: `Updated the lead. Lead id: ${existing.id}.` };
          }
          // An email that already belongs to a client (not a lead) is never overwritten or duplicated.
          if (email !== undefined) {
            const taken = await store.select('clients', { where: { email }, limit: 1 });
            if (Array.isArray(taken) && taken.length > 0) return { text: 'Not saved: that email already belongs to someone who is not a lead. Ask the founder.' };
          }
          const row = await store.insert('clients', { ...fields, status: 'lead' });
          return { text: `Saved the lead. Lead id: ${row?.id}.` };
        } catch {
          throw new Error(FAILED);
        }
      },
    }),
  ];
}

module.exports = { createCrmTools };
