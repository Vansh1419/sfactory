'use strict';

// The founder-approval setting (PLAN.md step 2.2: "A setting makes the founder approve every outbound message for the first
// 2 weeks"). Graded by the `outbound-review` eval.
//
// OUTBOUND_FOUNDER_APPROVAL_UNTIL is the date the period ends, for example 2026-12-09 (the founder sets it about two weeks
// out when going live). It FAILS SAFE: unset, empty, garbled or in the future all mean "the founder approves every message".
// Only a date that has clearly passed ends the period. A date on its own means the END of that day in India (IST), so the
// period runs through the whole of that day.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WITH_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const END_OF_DAY_IST = 'T23:59:59.999+05:30';
const MIN_YEAR = 2000;
const MAX_YEAR = 2200;

const NOT_A_DATE = 'OUTBOUND_FOUNDER_APPROVAL_UNTIL is not a date (write it like 2026-12-09), so the founder approves every outbound message.';

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** { until: Date | null, problem? }. `null` means "no end date": the founder approves every message. */
function parseApprovalUntil(text) {
  if (text === undefined || text === null) return { until: null };
  if (typeof text !== 'string') return { until: null, problem: NOT_A_DATE };
  const trimmed = text.trim();
  if (trimmed === '') return { until: null };

  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return { until: null, problem: NOT_A_DATE };
    return { until: new Date(`${trimmed}${END_OF_DAY_IST}`) };
  }
  if (WITH_TIME.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return { until: parsed };
  }
  return { until: null, problem: NOT_A_DATE };
}

const isRealDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

/** True when the founder must approve every outbound message. Anything unclear is "yes". */
function approvalRequired(input) {
  try {
    const { until, now } = input ?? {};
    if (!isRealDate(until) || !isRealDate(now)) return true;
    return now.getTime() < until.getTime();
  } catch {
    return true;
  }
}

module.exports = { parseApprovalUntil, approvalRequired };
