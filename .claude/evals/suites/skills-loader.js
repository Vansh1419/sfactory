'use strict';

// Grades the skills loader (PLAN.md step 2.1: "loads `shared` plus the team's MCP config and skills"):
//   src/runtime/agents/skills.js
//     loadSkills({ dir, team? }) -> { skills: [{ name, description, body }], problems: [string] }
//     skillsText(skills, { maxChars? }) -> string      the text an agent is given
//     CHARTER                                          'company-charter': no agent runs without it
//
// Skills live in <dir>/shared/<name>/SKILL.md and <dir>/<team>/<name>/SKILL.md, each with frontmatter
//     ---
//     name: <the folder name>
//     description: <one or two sentences>
//     ---
// and a body. What the loader promises (each is a case below):
//   - shared skills first, then the team's own; another team's skills are never loaded
//   - the team name cannot be used to reach any other folder
//   - a skill with a wrong name, no description, no body or too much text is skipped with a note; the good ones stay
//   - a folder that is a link (which could point anywhere) is skipped
//   - it never throws, and the text it builds is cut to a limit

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/agents/skills.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const lib = () => loadSubject(SUBJECT);

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const skill = (name, over = {}) => `---\nname: ${over.name ?? name}\ndescription: ${over.description ?? `The ${name} skill, for the eval.`}\n---\n\n${over.body ?? `# ${name}\n\nDo the ${name} thing carefully.\n`}`;

/** A skills folder: { 'shared/company-charter': text, 'support/ticket-triage': text, ... } (folder -> SKILL.md text). */
function dirWith(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  made.push(dir);
  for (const [folder, text] of Object.entries(entries)) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), text);
  }
  return dir;
}

const BASE = { 'shared/company-charter': skill('company-charter'), 'shared/handoff-notes': skill('handoff-notes') };

const cases = [
  {
    id: 'shared-skills-come-first-then-the-teams-own-with-name-description-and-body',
    check() {
      const dir = dirWith({ ...BASE, 'support/ticket-triage': skill('ticket-triage'), 'support/reply-tone': skill('reply-tone') });
      const r = lib().loadSkills({ dir, team: 'support' });
      const names = r.skills.map((s) => s.name).join();
      const first = r.skills[0];
      return verdict(names === 'company-charter,handoff-notes,reply-tone,ticket-triage' && first.description.length > 5 && first.body.includes('company-charter') && r.problems.length === 0, json({ names, problems: r.problems }));
    },
  },
  {
    id: 'another-teams-skills-are-never-loaded',
    check() {
      const dir = dirWith({ ...BASE, 'support/ticket-triage': skill('ticket-triage'), 'marketing_sales/cold-outreach': skill('cold-outreach') });
      const r = lib().loadSkills({ dir, team: 'support' });
      const none = lib().loadSkills({ dir });
      return verdict(!r.skills.some((s) => s.name === 'cold-outreach') && none.skills.map((s) => s.name).join() === 'company-charter,handoff-notes', json({ r: r.skills.map((s) => s.name), none: none.skills.map((s) => s.name) }));
    },
  },
  {
    id: 'a-team-name-that-is-not-a-plain-name-cannot-reach-any-other-folder',
    check() {
      const dir = dirWith({ ...BASE });
      const outside = path.join(path.dirname(dir), 'outside-skills');
      fs.mkdirSync(path.join(outside, 'evil'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'evil', 'SKILL.md'), skill('evil'));
      made.push(outside);
      for (const team of ['../outside-skills', '..', '/etc', 'a/b', 'a\\b', '', ' ', 'Support', 'a.b', 'shared', 'x'.repeat(60), 5, {}, ['support'], 'sup\u0000port']) {
        const r = lib().loadSkills({ dir, team });
        if (r.skills.some((s) => s.name === 'evil')) return verdict(false, `loaded for ${json(team)}`);
        if (r.skills.map((s) => s.name).join() !== 'company-charter,handoff-notes' || r.problems.length === 0) return verdict(false, `${json(team)} -> ${json(r)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'a-wrong-skill-is-skipped-with-a-note-and-the-good-ones-stay',
    check() {
      const dir = dirWith({
        ...BASE,
        'support/good': skill('good'),
        'support/wrong-name': skill('wrong-name', { name: 'another-name' }),
        'support/no-description': `---\nname: no-description\n---\n\nbody\n`,
        'support/empty-description': skill('empty-description', { description: '' }),
        'support/no-body': `---\nname: no-body\ndescription: has no body\n---\n\n`,
        'support/no-frontmatter': '# just text\n',
        'support/huge': skill('huge', { body: 'x'.repeat(25_000) }),
      });
      const r = lib().loadSkills({ dir, team: 'support' });
      return verdict(r.skills.map((s) => s.name).join() === 'company-charter,handoff-notes,good' && r.problems.length === 6, json({ names: r.skills.map((s) => s.name), problems: r.problems }));
    },
  },
  {
    id: 'a-folder-that-is-a-link-is-skipped',
    check() {
      const dir = dirWith({ ...BASE });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-out-'));
      made.push(outside);
      fs.writeFileSync(path.join(outside, 'SKILL.md'), skill('linked'));
      fs.mkdirSync(path.join(dir, 'support'));
      fs.symlinkSync(outside, path.join(dir, 'support', 'linked'));
      const r = lib().loadSkills({ dir, team: 'support' });
      return verdict(!r.skills.some((s) => s.name === 'linked') && r.problems.length >= 1, json({ names: r.skills.map((s) => s.name), problems: r.problems }));
    },
  },
  {
    id: 'a-missing-or-odd-folder-gives-no-skills-and-a-note-and-never-throws',
    check() {
      for (const input of [undefined, null, {}, { dir: '' }, { dir: 5 }, { dir: path.join(os.tmpdir(), 'no-such-skills-folder') }, 'text']) {
        let r;
        try {
          r = lib().loadSkills(input);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(input)}: ${err.message}`);
        }
        if (r.skills.length !== 0 || r.problems.length === 0) return verdict(false, `${json(input)} -> ${json(r)}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'too-many-skills-in-total-are-cut-with-a-note',
    check() {
      const entries = { ...BASE };
      for (let i = 0; i < 12; i += 1) entries[`support/s${String(i).padStart(2, '0')}`] = skill(`s${String(i).padStart(2, '0')}`, { body: 'y'.repeat(9_000) });
      const r = lib().loadSkills({ dir: dirWith(entries), team: 'support' });
      const total = r.skills.reduce((n, s) => n + s.body.length, 0);
      return verdict(total <= 60_000 && r.skills.length < 14 && r.problems.length >= 1 && r.skills.slice(0, 2).map((s) => s.name).join() === 'company-charter,handoff-notes', json({ total, count: r.skills.length, problems: r.problems.length }));
    },
  },
  {
    id: 'the-text-for-an-agent-names-each-skill-keeps-the-order-and-is-cut-to-a-limit',
    check() {
      const dir = dirWith({ ...BASE, 'support/ticket-triage': skill('ticket-triage') });
      const { skills } = lib().loadSkills({ dir, team: 'support' });
      const text = lib().skillsText(skills);
      const order = ['company-charter', 'handoff-notes', 'ticket-triage'].map((n) => text.indexOf(n));
      const cut = lib().skillsText(skills, { maxChars: 120 });
      return verdict(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])) && text.includes('Do the ticket-triage thing') && cut.length <= 200 && lib().skillsText([]) === '' && lib().skillsText(null) === '', json({ order, cut: cut.length }));
    },
  },
  {
    id: 'the-charter-constant-names-the-skill-no-agent-runs-without',
    check() {
      return verdict(lib().CHARTER === 'company-charter', json(lib().CHARTER));
    },
  },
  {
    id: 'the-skills-that-ship-load-clean-and-include-the-charter-and-the-three-shared-skills',
    check() {
      const r = lib().loadSkills({ dir: path.join(ROOT, '.claude/skills') });
      const names = r.skills.map((s) => s.name);
      return verdict(r.problems.length === 0 && ['company-charter', 'plain-language-approval', 'escalation-rules', 'handoff-notes'].every((n) => names.includes(n)), json({ names, problems: r.problems }));
    },
  },
];

module.exports = {
  name: 'skills-loader',
  description: 'Skills loader: shared first then the team own, never another team, team name cannot reach other folders, wrong skills skipped with a note, links skipped, totals capped, the shipped skills load clean',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
