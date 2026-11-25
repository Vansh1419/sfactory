'use strict';

// Grades the Finance, Legal and Ops team's tool (PLAN.md step 3.4: "an invoice draft is produced").
//   src/runtime/tools/invoice.js   createInvoiceTools({ now? }) -> [invoice.draft]
//     invoice.draft { buyer_name, buyer_state, seller_state, items: [{ description, quantity, unit_price }], gst_rate, buyer_gstin?, invoice_date?, due_in_days?, notes? }
//       -> { text, file: { name, content } }   a DRAFT invoice with the GST worked out IN CODE (the model never does the tax sum)
//   config/mcp/finance_legal_ops.yaml, src/runtime/policy.js
//
// Pure code, no database: the tool is checked directly, then through the real tool loader and the real policy.
//
//   - GST: the same state splits the tax in two halves (CGST and SGST), another state is one tax (IGST); money is whole paise, never floating point,
//     and the parts always add up to the total
//   - an invoice is a DRAFT: no invoice number (the founder assigns it, it is a legal sequence), nothing is sent, nothing is saved outside the file
//   - every argument is checked: a bad rate, state, GSTIN, date, quantity, price or an unknown argument is refused in plain words
//   - the tool is routine for the policy (it only writes a draft), works inside a pod run and outside one
//   - no payment credential exists anywhere in the code, and there is no tool that moves money: a payout is only an always-ask rule

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

const BASE = Object.freeze({
  buyer_name: 'Acme Studio Pvt Ltd',
  buyer_state: '29',
  seller_state: '27',
  gst_rate: 18,
  invoice_date: '2026-11-26',
  items: [{ description: 'Website design', quantity: 1, unit_price: 100000 }],
});
const make = (over = {}) => ({ ...BASE, ...over });

function invoiceTool(options) {
  const { createInvoiceTools } = loadSubject('src/runtime/tools/invoice.js');
  return createInvoiceTools(options).find((t) => t.name === 'invoice.draft');
}

const run = async (args) => invoiceTool().run({ args, context: {} });

/** Integer paise, half up: the sum written the long way, independent of the code under test. */
const halfUp = (numerator, denominator) => Math.floor((2 * numerator + denominator) / (2 * denominator));
const paise = (rupees) => Math.round(rupees * 100);

const cases = [
  {
    id: 'the-same-state-splits-the-tax-into-cgst-and-sgst',
    async check() {
      const t = (await run(make({ buyer_state: '27' }))).text;
      const ok = /CGST[^\n]*9%[^\n]*₹9,000\.00/.test(t) && /SGST[^\n]*9%[^\n]*₹9,000\.00/.test(t) && !/IGST/.test(t) && /Total[^\n]*₹1,18,000\.00/.test(t) && /Taxable[^\n]*₹1,00,000\.00/.test(t);
      return verdict(ok, t);
    },
  },
  {
    id: 'another-state-is-one-tax-igst',
    async check() {
      const t = (await run(make())).text;
      const ok = /IGST[^\n]*18%[^\n]*₹18,000\.00/.test(t) && !/CGST|SGST/.test(t) && /Total[^\n]*₹1,18,000\.00/.test(t);
      return verdict(ok, t);
    },
  },
  {
    id: 'a-zero-rate-invoice-has-no-tax-and-the-total-is-the-taxable-amount',
    async check() {
      const t = (await run(make({ gst_rate: 0 }))).text;
      return verdict(/Total[^\n]*₹1,00,000\.00/.test(t) && !/^[CSI]GST @/m.test(t), t);
    },
  },
  {
    id: 'money-is-whole-paise-the-parts-add-up-and-the-halves-match',
    async check() {
      const prices = [0.01, 0.5, 99.99, 333.33, 1499.5, 12345.67, 9999999.99];
      const quantities = [1, 3, 7, 1000];
      const rates = [0, 5, 12, 18, 28];
      const fmt = (p) => `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`;
      for (const price of prices) {
        for (const quantity of quantities) {
          for (const rate of rates) {
            for (const buyer_state of ['27', '29']) {
              const taxable = paise(price) * quantity;
              const half = halfUp(taxable * rate, 200);
              const tax = buyer_state === '27' ? 2 * half : halfUp(taxable * rate, 100);
              const t = (await run(make({ buyer_state, gst_rate: rate, items: [{ description: 'Item', quantity, unit_price: price }] }))).text;
              const total = /^Total[^\n]*₹([\d,]+\.\d\d)/m.exec(t)?.[1]?.replace(/,/g, '');
              if (total !== fmt(taxable + tax)) return verdict(false, `price ${price} x ${quantity} at ${rate}% (${buyer_state}): expected ${fmt(taxable + tax)}, got ${total}\n${t}`);
              if (buyer_state === '27' && rate > 0) {
                const [c, s] = ['CGST', 'SGST'].map((n) => new RegExp(`^${n}[^\\n]*₹([\\d,]+\\.\\d\\d)`, 'm').exec(t)?.[1]);
                if (!c || c !== s) return verdict(false, `the two halves differ: ${c} ${s}\n${t}`);
              }
            }
          }
        }
      }
      return verdict(true);
    },
  },
  {
    id: 'an-invoice-is-a-draft-with-no-number-and-comes-back-as-a-plain-file',
    async check() {
      const r = await run(make({ notes: 'Payment within 15 days.', due_in_days: 15 }));
      const { sanitizeFileName } = loadSubject('src/runtime/tools/files.js');
      const t = r.text;
      const ok = /DRAFT/.test(t) && /not (yet )?issued/i.test(t) && /Invoice number:[^\n]*(to be|not yet)[^\n]*(founder|assigned)/i.test(t) && !/Invoice number:\s*\d/.test(t)
        && /Due date:[^\n]*2026-12-11/.test(t) && /Payment within 15 days\./.test(t) && /Acme Studio Pvt Ltd/.test(t) && /Website design/.test(t)
        && r.file && /^invoice-draft-[a-z0-9-]+\.txt$/.test(r.file.name) && sanitizeFileName(r.file.name) === r.file.name && r.file.content.includes('Website design') && r.file.content.length < 19_000
        && Object.keys(r).sort().join() === 'file,text';
      return verdict(ok, json({ file: r.file?.name, text: t }));
    },
  },
  {
    id: 'every-argument-is-checked-and-a-bad-one-is-refused-in-plain-words',
    async check() {
      const tool = invoiceTool();
      const item = (over) => ({ description: 'Work', quantity: 1, unit_price: 100, ...over });
      const bad = {
        'not an object': 'x',
        'an unknown argument': make({ invoice_number: 'INV-1' }),
        'no buyer': make({ buyer_name: undefined }),
        'a blank buyer': make({ buyer_name: '  ' }),
        'a line break in the buyer': make({ buyer_name: 'A\nB' }),
        'a rate that does not exist': make({ gst_rate: 17 }),
        'a rate as text': make({ gst_rate: '18' }),
        'no items': make({ items: [] }),
        'too many items': make({ items: Array.from({ length: 51 }, () => item()) }),
        'an item that is not an object': make({ items: ['x'] }),
        'an item with an extra field': make({ items: [item({ discount: 5 })] }),
        'a zero quantity': make({ items: [item({ quantity: 0 })] }),
        'a fractional quantity': make({ items: [item({ quantity: 1.5 })] }),
        'a huge quantity': make({ items: [item({ quantity: 100001 })] }),
        'a negative price': make({ items: [item({ unit_price: -5 })] }),
        'a zero price': make({ items: [item({ unit_price: 0 })] }),
        'a price with three decimals': make({ items: [item({ unit_price: 10.005 })] }),
        'a price as text': make({ items: [item({ unit_price: '100' })] }),
        'a price that is not finite': make({ items: [item({ unit_price: Infinity })] }),
        'a price that is too large': make({ items: [item({ unit_price: 100_000_001 })] }),
        'an empty description': make({ items: [item({ description: '' })] }),
        'a long description': make({ items: [item({ description: 'x'.repeat(201) })] }),
        'a state that does not exist': make({ buyer_state: '00' }),
        'a state of one digit': make({ seller_state: '9' }),
        'a state as a number': make({ buyer_state: 29 }),
        'a GSTIN that is not one': make({ buyer_gstin: '29ABCDE1234F1Z' }),
        'a GSTIN of another state': make({ buyer_gstin: '27ABCDE1234F1Z5' }),
        'a date that is not a date': make({ invoice_date: '2026-02-30' }),
        'a date in the wrong form': make({ invoice_date: '26/11/2026' }),
        'a negative due period': make({ due_in_days: -1 }),
        'a due period over 90 days': make({ due_in_days: 91 }),
        'a fractional due period': make({ due_in_days: 1.5 }),
        'notes that are too long': make({ notes: 'n'.repeat(1001) }),
        'a control character in the notes': make({ notes: 'a\u0000b' }),
      };
      const accepted = Object.entries(bad).filter(([, args]) => tool.checkArgs(args) === null).map(([label]) => label);
      const good = [make(), make({ buyer_gstin: '29ABCDE1234F1Z5' }), make({ due_in_days: 0, notes: 'Line one\nline two' }), make({ buyer_state: '97', seller_state: '99' })];
      const refusedGood = good.filter((args) => tool.checkArgs(args) !== null).map((a) => json(a));
      const messages = Object.values(bad).map((args) => tool.checkArgs(args));
      return verdict(accepted.length === 0 && refusedGood.length === 0 && messages.every((m) => typeof m === 'string' && m.length > 0 && m.length < 160), json({ accepted, refusedGood }));
    },
  },
  {
    id: 'a-day-is-checked-as-a-real-calendar-day-and-an-unset-date-is-today-in-india',
    async check() {
      const tool = invoiceTool({ now: () => new Date('2026-11-26T20:00:00Z') }); // 01:30 on the 27th in India
      const withoutDate = { ...BASE };
      delete withoutDate.invoice_date;
      const t = (await tool.run({ args: withoutDate, context: {} })).text;
      const leap = tool.checkArgs(make({ invoice_date: '2028-02-29' })) === null && tool.checkArgs(make({ invoice_date: '2027-02-29' })) !== null;
      return verdict(/Invoice date:[^\n]*2026-11-27/.test(t) && leap, t);
    },
  },
  {
    id: 'the-tool-is-routine-for-the-policy-and-the-loader-runs-it-in-a-pod-run-and-outside-one',
    async check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
      const { createInvoiceTools } = loadSubject('src/runtime/tools/invoice.js');
      const loader = createToolLoader({ tools: createInvoiceTools(), hasRule: async (t) => policy.isBuiltIn(t) });
      const rule = policy.checkAction({ tool: 'invoice.draft', access: 'write' });
      const wrongTag = policy.checkAction({ tool: 'invoice.draft', access: 'read' });
      await loader.load();
      const action = { tool: 'invoice.draft', access: 'write', args: make() };
      const outside = await loader.run({ action, context: {} });
      const inPod = await loader.run({ action, context: { podId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' } });
      const described = loader.describe({ inPod: true }).map((d) => d.tool);
      return verdict(rule.allowed === true && wrongTag.allowed === false && /Total/.test(outside.text ?? '') && /Total/.test(inPod.text ?? '') && described.includes('invoice.draft'), json({ rule, wrongTag, outside, inPod, described }));
    },
  },
  {
    id: 'the-teams-tool-file-lists-the-invoice-tool-and-nothing-that-moves-money',
    async check() {
      const { loadToolConfig } = loadSubject('src/runtime/tools/config.js');
      const config = loadToolConfig({ dir: path.join(ROOT, 'config', 'mcp'), team: 'finance_legal_ops' });
      const names = Object.keys(config.tools ?? {});
      const tool = invoiceTool();
      const ok = config.problems.length === 0 && names.includes('invoice.draft') && config.tools['invoice.draft'] === 'write' && tool.access === 'write' && !names.some((n) => /^(razorpay|stripe|zoho|refund|payment|payout|bank)/.test(n));
      return verdict(ok, json({ problems: config.problems, names }));
    },
  },
  {
    id: 'no-payment-credential-exists-and-a-payout-has-only-an-always-ask-rule-and-no-tool',
    async check() {
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
      const sources = walk(path.join(ROOT, 'src')).filter((f) => /\.(js|jsx|mjs)$/.test(f) && !/\.test\.js$/.test(f));
      const CREDENTIAL = /(RAZORPAY|ZOHO)[A-Z_]*(KEY|SECRET|TOKEN|ID)\b|rzp_(live|test)_/;
      const found = sources.filter((f) => CREDENTIAL.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
      const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
      const payout = policy.checkAction({ tool: 'razorpay.create_payout', access: 'write', args: { amount: 1 } });
      const { BUILTIN_TOOLS } = loadSubject('src/runtime/tools/builtin.js');
      const named = [...BUILTIN_TOOLS, ...(loadSubject('src/runtime/tools/invoice.js').createInvoiceTools())].map((t) => t.name);
      return verdict(found.length === 0 && !CREDENTIAL.test(example) && payout.allowed === false && payout.category === 'spend' && !named.some((n) => /^(razorpay|zoho_books)\./.test(n)), json({ found, payout, named }));
    },
  },
];

module.exports = {
  name: 'finance-tools',
  description: 'Finance team tool (step 3.4): invoice.draft works the GST out in code (CGST and SGST in one state, IGST across states, whole paise), makes a draft with no number, refuses bad input, and no payment credential or payment tool exists',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
