'use strict';

// Pod templates (PLAN.md step 3.1). `config/pods/<template>/template.yaml` says what a new pod of that kind starts with:
//
//   description  one plain sentence for the founder's card
//   teams        whose agents join the pod when it opens
//   files        the files copied into the pod's folder, from `config/pods/<template>/files/`
//
// The template ids are the two the database allows (`pods.template`): agency_client and saas_product. A template that is broken is
// left out and the reason is returned, so one bad file never stops the other kind of pod. Nothing here is ever run: the files are
// plain text with {{name}}-style blanks, filled in by `render`.
//
//   loadPodTemplates({ dir }) -> { templates: { [id]: { id, description, teams, files: [{ name, content }] } }, problems: [text] }
//   render(text, values)      -> the text with every {{blank}} filled (an unknown or empty value becomes "not set")

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const TEMPLATE_IDS = Object.freeze(['agency_client', 'saas_product']);
const TEAMS = Object.freeze(['product_engineering', 'marketing_sales', 'support', 'finance_legal_ops']);
const MAX_FILE_BYTES = 20_000;
const MAX_FILES = 20;
const BLANK = /\{\{\s*([a-z_]+)\s*\}\}/g;
// A file name is one plain name in the template's own folder: no folders, no dots-only, nothing that leaves the folder.
const SAFE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/;

function readTemplate(dir, id) {
  const base = path.join(dir, id);
  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(path.join(base, 'template.yaml'), 'utf8'));
  } catch {
    return { problem: `The ${id} template could not be read, so it is not available.` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { problem: `The ${id} template is not a list of settings, so it is not available.` };
  if (typeof parsed.description !== 'string' || parsed.description.trim() === '') return { problem: `The ${id} template has no description, so it is not available.` };
  const teams = parsed.teams;
  if (!Array.isArray(teams) || teams.length === 0 || !teams.every((t) => TEAMS.includes(t))) return { problem: `The ${id} template must list one or more known teams, so it is not available.` };
  const names = parsed.files;
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_FILES || !names.every((n) => typeof n === 'string' && SAFE_NAME.test(n))) {
    return { problem: `The ${id} template must list up to ${MAX_FILES} plain file names, so it is not available.` };
  }
  const files = [];
  for (const name of names) {
    let content;
    try {
      const file = path.join(base, 'files', name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('not a small plain file');
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return { problem: `The ${id} template lists ${name}, which is missing or not a small plain file, so it is not available.` };
    }
    files.push({ name, content });
  }
  return { template: { id, description: parsed.description.trim(), teams: [...new Set(teams)], files } };
}

function loadPodTemplates({ dir } = {}) {
  const templates = {};
  const problems = [];
  if (typeof dir !== 'string' || dir === '') return { templates, problems: ['No pod templates folder is set, so no pod can be made.'] };
  for (const id of TEMPLATE_IDS) {
    const read = readTemplate(dir, id);
    if (read.template) templates[id] = Object.freeze(read.template);
    else problems.push(read.problem);
  }
  return { templates, problems };
}

/** Plain text only: no control characters, no blanks of its own, one reasonable length. */
function plain(value, max = 2000) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').replace(/\{\{|\}\}/g, '').trim().slice(0, max);
}

function render(text, values = {}) {
  return String(text).replace(BLANK, (_, key) => {
    const value = Object.prototype.hasOwnProperty.call(values, key) ? plain(String(values[key] ?? '')) : '';
    return value === '' ? 'not set' : value;
  });
}

module.exports = { loadPodTemplates, render, plain, TEMPLATE_IDS, TEAMS };
