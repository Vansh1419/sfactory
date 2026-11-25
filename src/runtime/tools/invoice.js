'use strict';

// The invoice tool of the Finance, Legal and Ops team (PLAN.md step 3.4). Graded by the `finance-tools` eval.
//
//   invoice.draft { buyer_name, buyer_state, seller_state, items: [{ description, quantity, unit_price }], gst_rate,
//                   buyer_gstin?, invoice_date?, due_in_days?, notes? }                                     write
//     -> { text, file: { name, content } }
//
// It writes a DRAFT invoice. The tax sum is done HERE, in whole paise, never by the model and never in floating point:
//   - the buyer in the seller's state pays CGST and SGST (each half of the rate); in another state, one IGST
//   - a half is rounded to the nearest paise (half up), so the two halves are always equal and the parts always add up to the total
// An invoice number is a legal sequence, so the draft carries none: the founder assigns it when the invoice is issued. Nothing is sent
// and nothing is saved outside the file the tool hands back; it reads nothing of ours, so it works inside a pod run as well as outside one.
// Seller details that only the founder knows (name, address, GSTIN) are left for the founder to add.

const { sanitizeFileName } = require('./files');

const MAX_ITEMS = 50;
const MAX_TEXT_CHARS = 200;
const MAX_NOTES_CHARS = 1_000;
const MAX_QUANTITY = 100_000;
const MAX_UNIT_PRICE = 100_000_000;
const MAX_DUE_DAYS = 90;
const RATES = Object.freeze([0, 5, 12, 18, 28]);
const ALLOWED_KEYS = ['buyer_name', 'buyer_state', 'seller_state', 'items', 'gst_rate', 'buyer_gstin', 'invoice_date', 'due_in_days', 'notes'];
const ITEM_KEYS = ['description', 'quantity', 'unit_price'];
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const STATE_CODE = /^(0[1-9]|[12]\d|3[0-8]|97|99)$/; // the GST state and territory codes
const GSTIN = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (value, keys) => Object.keys(value).find((k) => !keys.includes(k));
const plainLine = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !CONTROL.test(v);

/** True for a real calendar day written YYYY-MM-DD. */
function isRealDay(text) {
  const m = DATE.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const toIsoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Rupees written with at most two decimals, as whole paise. Null when it is not that. */
function toPaise(rupeesValue) {
  if (typeof rupeesValue !== 'number' || !Number.isFinite(rupeesValue)) return null;
  const p = Math.round(rupeesValue * 100);
  return Math.abs(rupeesValue * 100 - p) < 1e-6 ? p : null;
}

/** `numerator / denominator` rounded to the nearest whole number, half up, for non-negative integers. */
const halfUp = (numerator, denominator) => Math.floor((2 * numerator + denominator) / (2 * denominator));

/** Whole paise as Indian-grouped rupees: ₹1,18,000.00 */
function rupees(p) {
  const whole = String(Math.floor(p / 100));
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `₹${grouped}.${String(p % 100).padStart(2, '0')}`;
}

/** The sums of a draft, in whole paise. */
function work({ items, gstRate, sameState }) {
  const lines = items.map((i) => {
    const unitPaise = toPaise(i.unit_price);
    return { description: i.description.trim(), quantity: i.quantity, unitPaise, amount: i.quantity * unitPaise };
  });
  const taxable = lines.reduce((sum, l) => sum + l.amount, 0);
  const half = sameState ? halfUp(taxable * gstRate, 200) : 0;
  const igst = sameState ? 0 : halfUp(taxable * gstRate, 100);
  const tax = sameState ? 2 * half : igst;
  return { lines, taxable, cgst: half, sgst: half, igst, tax, total: taxable + tax };
}

function taxLines({ rate, sameState, sums }) {
  if (rate === 0) return ['GST: 0% (no tax on this invoice)'];
  if (sameState) return [`CGST @ ${rate / 2}%: ${rupees(sums.cgst)}`, `SGST @ ${rate / 2}%: ${rupees(sums.sgst)}`];
  return [`IGST @ ${rate}%: ${rupees(sums.igst)}`];
}

function render({ args, sums, sameState, invoiceDate, dueDate }) {
  return [
    'TAX INVOICE - DRAFT (not issued)',
    '',
    'Invoice number: to be assigned by the founder when the invoice is issued',
    `Invoice date: ${invoiceDate}`,
    ...(dueDate ? [`Due date: ${dueDate}`] : []),
    '',
    `Seller state code: ${args.seller_state}   (seller name, address and GSTIN: the founder adds these)`,
    `Bill to: ${args.buyer_name.trim()}`,
    `Buyer state code: ${args.buyer_state}${args.buyer_gstin ? `   GSTIN: ${args.buyer_gstin}` : ''}`,
    `Place of supply: ${sameState ? 'same state (CGST and SGST)' : 'another state (IGST)'}`,
    '',
    'Items',
    ...sums.lines.map((l, i) => `${i + 1}. ${l.description} - ${l.quantity} x ${rupees(l.unitPaise)} = ${rupees(l.amount)}`),
    '',
    `Taxable value: ${rupees(sums.taxable)}`,
    ...taxLines({ rate: args.gst_rate, sameState, sums }),
    `Total: ${rupees(sums.total)}`,
    ...(args.notes ? ['', 'Notes', args.notes.trim()] : []),
    '',
    'This is a draft for the founder to check. The tax was worked out by the system; the rate, the states and the items were given by the team and are not verified.',
  ].join('\n');
}

/** A plain reason the arguments are not valid, or null. */
function checkInvoiceArgs(args) {
  if (!isObject(args)) return 'the arguments must be an object';
  if (onlyKeys(args, ALLOWED_KEYS)) return 'unknown argument: the invoice number is not set by the team';
  if (!plainLine(args.buyer_name, MAX_TEXT_CHARS)) return `buyer_name must be one line of plain text, up to ${MAX_TEXT_CHARS} characters`;
  for (const key of ['buyer_state', 'seller_state']) {
    if (typeof args[key] !== 'string' || !STATE_CODE.test(args[key])) return `${key} must be a two-digit GST state code, such as 27`;
  }
  if (typeof args.gst_rate !== 'number' || !RATES.includes(args.gst_rate)) return `gst_rate must be one of ${RATES.join(', ')}`;
  if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > MAX_ITEMS) return `items must be a list of 1 to ${MAX_ITEMS} items`;
  for (const item of args.items) {
    if (!isObject(item) || onlyKeys(item, ITEM_KEYS)) return 'each item has only a description, a quantity and a unit_price';
    if (!plainLine(item.description, MAX_TEXT_CHARS)) return `each description must be one line of plain text, up to ${MAX_TEXT_CHARS} characters`;
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) return `each quantity must be a whole number from 1 to ${MAX_QUANTITY}`;
    const p = toPaise(item.unit_price);
    if (p === null || p < 1 || item.unit_price > MAX_UNIT_PRICE) return `each unit_price must be rupees with at most 2 decimals, from 0.01 to ${MAX_UNIT_PRICE}`;
  }
  if (args.buyer_gstin !== undefined) {
    const m = typeof args.buyer_gstin === 'string' ? GSTIN.exec(args.buyer_gstin) : null;
    if (!m) return 'buyer_gstin must be a 15-character GSTIN';
    if (m[1] !== args.buyer_state) return 'buyer_gstin starts with a different state code than buyer_state';
  }
  if (args.invoice_date !== undefined && !(typeof args.invoice_date === 'string' && isRealDay(args.invoice_date))) return 'invoice_date must be a real day written YYYY-MM-DD';
  if (args.due_in_days !== undefined && !(Number.isInteger(args.due_in_days) && args.due_in_days >= 0 && args.due_in_days <= MAX_DUE_DAYS)) return `due_in_days must be a whole number from 0 to ${MAX_DUE_DAYS}`;
  if (args.notes !== undefined && !(typeof args.notes === 'string' && args.notes.length <= MAX_NOTES_CHARS && !CONTROL_EXCEPT_BREAKS.test(args.notes))) return `notes must be plain text of at most ${MAX_NOTES_CHARS} characters`;
  return null;
}

function createInvoiceTools({ now = () => new Date() } = {}) {
  return [
    Object.freeze({
      name: 'invoice.draft',
      access: 'write',
      podAccess: 'neutral', // it reads nothing of ours: it only works out and writes what it is given
      summary: 'Writes a DRAFT tax invoice with the GST worked out in code (CGST and SGST in one state, IGST across states) and gives it back as text and a file. It has no invoice number and is never sent: the founder checks and issues it.',
      args: `{ "buyer_name": who is billed, "buyer_state": the buyer's two-digit GST state code, "seller_state": our two-digit GST state code, "items": [ { "description": text, "quantity": whole number, "unit_price": rupees with at most 2 decimals } ] (1 to ${MAX_ITEMS}), "gst_rate": one of ${RATES.join(', ')}, "buyer_gstin": optional, "invoice_date": optional, YYYY-MM-DD (today in India when left out), "due_in_days": optional, 0 to ${MAX_DUE_DAYS}, "notes": optional, at most ${MAX_NOTES_CHARS} characters }`,
      checkArgs: checkInvoiceArgs,

      async run({ args }) {
        const sameState = args.buyer_state === args.seller_state;
        const invoiceDate = args.invoice_date ?? toIsoDay(now().getTime() + IST_OFFSET_MS);
        const dueDate = args.due_in_days === undefined ? null : toIsoDay(Date.parse(`${invoiceDate}T00:00:00Z`) + args.due_in_days * DAY_MS);
        const sums = work({ items: args.items, gstRate: args.gst_rate, sameState });
        const content = render({ args, sums, sameState, invoiceDate, dueDate });
        const slug = args.buyer_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
        return { text: content, file: { name: sanitizeFileName(`invoice-draft-${slug}-${invoiceDate}.txt`), content } };
      },
    }),
  ];
}

module.exports = { createInvoiceTools, rupees, toPaise };
