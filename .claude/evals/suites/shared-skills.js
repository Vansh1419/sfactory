'use strict';

// Grades the shared agent skills (PLAN.md step 1.10: "Write the shared skills: plain-language-approval,
// escalation-rules, handoff-notes"), in .claude/skills/shared/<name>/SKILL.md.
//
// A skill is prose, so the risk is that it drifts from the code it describes. These cases tie it down:
//   - each skill has a name that matches its folder, a description, and points back to the company charter
//   - plain-language-approval holds a worked example card, and that card must PASS the real card checker
//   - escalation-rules names every tool the policy always asks about, and says the policy check decides
//   - handoff-notes has the headings a note must carry, and forbids secrets
//   - none of them contains anything that looks like a key

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../lib');

const DIR = path.join(ROOT, '.claude/skills/shared');
const SKILLS = ['plain-language-approval', 'escalation-rules', 'handoff-notes'];
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

const readSkill = (name) => {
  try {
    return fs.readFileSync(path.join(DIR, name, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
};
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text ?? '');
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

const cases = [
  {
    id: 'every-shared-skill-exists-with-a-matching-name-a-description-and-a-link-to-the-charter',
    check() {
      const problems = [];
      for (const name of SKILLS) {
        const text = readSkill(name);
        if (text === null) { problems.push(`${name}: missing`); continue; }
        const fm = frontmatter(text);
        if (!fm || fm.name !== name) problems.push(`${name}: name does not match`);
        if (!fm || !fm.description || fm.description.length < 40 || fm.description.length > 400) problems.push(`${name}: description missing or the wrong length`);
        if (!/company-charter/.test(text)) problems.push(`${name}: does not point to the company charter`);
        if (text.split('\n').length > 110) problems.push(`${name}: too long to be read every time`);
      }
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'no-shared-skill-contains-anything-that-looks-like-a-key',
    check() {
      const { redactDetail } = require(path.join(ROOT, 'src/runtime/audit'));
      const bad = SKILLS.filter((name) => {
        const text = readSkill(name) ?? '';
        return redactDetail(text) !== text;
      });
      return verdict(bad.length === 0, bad.join());
    },
  },
  {
    id: 'the-approval-skill-lists-the-seven-parts-in-order-and-the-rules-for-money-time-and-details',
    check() {
      const text = readSkill('plain-language-approval') ?? '';
      const parts = ['What do you need to decide', 'Why now', 'If you say yes', 'If you say no', 'Cost', 'Risk', 'Our recommendation'];
      const at = parts.map((p) => text.indexOf(p));
      const inOrder = at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1]));
      const { RISK_LEVELS } = require(path.join(ROOT, 'src/runtime/cards'));
      const levels = RISK_LEVELS.every((l) => text.includes(l));
      return verdict(inOrder && levels && text.includes('₹') && text.includes('$') && /IST/.test(text) && /Show details/.test(text) && /Price not known yet/.test(text), json({ at, levels }));
    },
  },
  {
    id: 'the-approval-skills-worked-example-passes-the-real-card-checker',
    check() {
      const text = readSkill('plain-language-approval') ?? '';
      const m = /```json\n([\s\S]*?)\n```/.exec(text);
      if (!m) return verdict(false, 'no json example');
      let card;
      try {
        card = JSON.parse(m[1]);
      } catch {
        return verdict(false, 'the example is not valid JSON');
      }
      const { checkCard } = require(path.join(ROOT, 'src/runtime/cards'));
      const result = checkCard(card);
      return verdict(result.pass === true, json(result.problems));
    },
  },
  {
    id: 'the-approval-skill-also-shows-a-card-the-checker-would-reject-and-it-really-is-rejected',
    check() {
      const text = readSkill('plain-language-approval') ?? '';
      const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
      if (blocks.length < 2) return verdict(false, `found ${blocks.length} json examples, expected a good one and a bad one`);
      let bad;
      try {
        bad = JSON.parse(blocks[1]);
      } catch {
        return verdict(false, 'the second example is not valid JSON');
      }
      const { checkCard } = require(path.join(ROOT, 'src/runtime/cards'));
      return verdict(checkCard(bad).pass === false, 'the "bad" example passes the checker');
    },
  },
  {
    id: 'the-escalation-skill-names-every-tool-the-policy-always-asks-about',
    check() {
      const text = readSkill('escalation-rules') ?? '';
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const asks = policy.listRules().filter((r) => r.alwaysAsks).map((r) => r.tool);
      const missing = asks.filter((tool) => !text.includes(tool));
      return verdict(asks.length >= 10 && missing.length === 0, `missing: ${missing.join()}`);
    },
  },
  {
    id: 'the-escalation-skill-covers-all-four-kinds-of-decision-and-the-preview-deploy-rule',
    check() {
      const text = readSkill('escalation-rules') ?? '';
      const kinds = [/spending money/i, /hiring, firing or signing/i, /launch|price/i, /legal document|public statement/i];
      const ok = kinds.every((k) => k.test(text)) && /vercel\.deploy/.test(text) && /preview/i.test(text);
      return verdict(ok, 'a kind of decision or the preview-deploy rule is missing');
    },
  },
  {
    id: 'the-escalation-skill-says-the-policy-check-decides-and-to-treat-doubt-as-crucial',
    check() {
      const text = readSkill('escalation-rules') ?? '';
      return verdict(/policy check/i.test(text) && /when (you are )?unsure|if you are unsure|in doubt/i.test(text) && /treat it as crucial|treat (it|the action) as crucial/i.test(text) && /never (say|claim)[^.]*approved/i.test(text), 'a key rule is missing');
    },
  },
  {
    id: 'the-handoff-skill-has-the-headings-a-note-must-carry-and-forbids-secrets',
    check() {
      const text = readSkill('handoff-notes') ?? '';
      const headings = ['What was asked', 'What I did', 'What is left', 'Where things are', 'Risks and open questions'];
      const at = headings.map((h) => text.indexOf(h));
      const inOrder = at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1]));
      return verdict(inOrder && /no (keys|secrets|passwords|tokens)|never (include|write|put)[^.]*(secret|key|password|token)/i.test(text) && /example/i.test(text), json(at));
    },
  },
];

module.exports = {
  name: 'shared-skills',
  description: 'Shared skills: names and descriptions, a worked card that passes the real checker and a bad one that fails, every always-ask tool named, handoff headings, no keys in any of them',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
