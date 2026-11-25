'use strict';

// Pods (PLAN.md step 3.1). A pod is one project's own space: a folder, a git history, a memory space and its agents. Opening one is a
// commitment, so the founder approves a card first:
//
//   setPriority({ podId, priority })  -> { podId, priority, previous }   (step 3.5)
//   propose({ name, template, clientId?, service?, priority?, deadline?, note? })
//        files a founder card (the action is `pod.create`, an always-ask rule with no tool behind it) and writes nothing else:
//        no project, no folder, no pod. Returns { ok, decisionId, projectId }.
//   open(decisionId)
//        applies an APPROVED card: the project row, the folder with the template's files, a git history with one first commit, the pod
//        row, the first memory note and the pod's agents. Every step is safe to run again, so a run that stopped half way is finished
//        by running it again (on start, the app does that for every approved card that has no pod yet). Returns { ok, podId, folder }.
//   start() / stop()
//        listen for the founder's answers, then open any approved card that was answered while the app was closed.
//
// The database holds the same rules (see the migration): a pod that names a decision needs an approved `pod.create` decision, and one
// decision opens one pod. The folder is named from the project and the first part of the decision's id, so a second run lands on the
// same folder. Nothing is ever overwritten: a file that exists stays as it is. Every step is audited BEFORE it is made, and the audit log
// holds names and ids, never the founder's note. Agents never get this service: it is for trusted code only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { loadPodTemplates, render, plain, TEMPLATE_IDS } = require('./templates');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICES = Object.freeze(['web_development', 'ai_automation', 'marketing', 'content']);
const SERVICE_WORDS = Object.freeze({ web_development: 'Web development', ai_automation: 'AI automation', marketing: 'Marketing', content: 'Content' });
const PRIORITIES = Object.freeze(['P1', 'P2', 'P3']);
const POD_TOOL = 'pod.create';
const MAX_NAME = 80;
const MAX_NOTE = 1500;
const MAX_RECOVERED = 50;
const GIT_TIMEOUT_MS = 30_000;
const REPO_SHAPE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

class PodError extends Error {
  constructor(code, message, problems) {
    super(message);
    this.name = 'PodError';
    this.code = code;
    if (problems) this.problems = problems;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code, message, problems) => new PodError(code, message, problems);

/** A folder name from a project name: lowercase letters, digits and dashes only, never empty. */
function slugOf(name) {
  const slug = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return slug === '' ? 'project' : slug;
}

/** Run git with no shell, no hooks, and none of the machine's own git settings. */
function runGit(args, cwd) {
  const { PATH } = process.env;
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

function createPods({ store, audit, decisions, runtime, templatesDir, root, allowedRepos = [], isBlocked = () => null, newId = () => crypto.randomUUID(), now = () => new Date(), git = runGit, emit, onError = () => {} } = {}) {
  const loaded = loadPodTemplates({ dir: templatesDir });
  const templates = loaded.templates;
  const rootDir = typeof root === 'string' && path.isAbsolute(root) ? path.resolve(root) : null;
  let unsubscribe = null;
  const opening = new Map(); // decision id -> the run in progress, so two answers at once open one pod
  // The repositories the founder named (GITHUB_REPOS). A pod can be tied to one of these and to nothing else; the spelling of the list is kept.
  const repos = new Map((Array.isArray(allowedRepos) ? allowedRepos : []).filter((r) => typeof r === 'string' && REPO_SHAPE.test(r)).map((r) => [r.toLowerCase(), r]));

  const announce = (type, data) => {
    try {
      (emit ?? ((t, d) => runtime?.emit?.(t, d)))(type, data);
    } catch {
      // A broken listener must not undo a pod.
    }
  };

  function ensureRunning() {
    const reason = isBlocked();
    if (reason) throw fail('blocked', reason);
    if (rootDir === null) throw fail('not_available', 'Projects cannot be opened here: no folder is set for them. Nothing was changed.');
    if (Object.keys(templates).length === 0) throw fail('not_available', 'Projects cannot be opened here: no project templates are available. Nothing was changed.');
  }

  async function record(action, targetId, detail = {}, podId) {
    try {
      await audit.append({ actorType: 'system', ...(podId ? { podId } : {}), action, targetType: 'pod', targetId, detail });
    } catch {
      throw fail('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
    }
  }

  function describeTemplates() {
    return TEMPLATE_IDS.filter((id) => templates[id]).map((id) => ({ id, description: templates[id].description, teams: [...templates[id].teams] }));
  }

  function readProposal(input) {
    if (!isObject(input)) throw fail('invalid', 'A project needs a name and a kind.');
    const extra = Object.keys(input).find((k) => !['name', 'template', 'clientId', 'service', 'priority', 'deadline', 'note', 'githubRepo'].includes(k));
    if (extra) throw fail('invalid', `Unknown field: ${extra}.`);
    const name = plain(input.name, MAX_NAME + 1);
    if (name === '' || name.length > MAX_NAME) throw fail('invalid', `The project needs a name of 1 to ${MAX_NAME} characters.`);
    if (!TEMPLATE_IDS.includes(input.template) || !templates[input.template]) throw fail('invalid', `The kind of project must be one of: ${describeTemplates().map((t) => t.id).join(', ') || 'none are available'}.`);
    const out = { name, template: input.template };
    if (input.clientId !== undefined) {
      if (typeof input.clientId !== 'string' || !UUID.test(input.clientId)) throw fail('invalid', 'clientId must be a client id.');
      out.clientId = input.clientId.toLowerCase();
    }
    if (input.service !== undefined) {
      if (input.template !== 'agency_client') throw fail('invalid', 'Only a client project has a service.');
      if (!SERVICES.includes(input.service)) throw fail('invalid', `service must be one of: ${SERVICES.join(', ')}.`);
      out.service = input.service;
    }
    if (input.template === 'saas_product' && out.clientId) throw fail('invalid', 'A product the company sells itself has no client.');
    if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) throw fail('invalid', `priority must be one of: ${PRIORITIES.join(', ')}.`);
    out.priority = input.priority ?? 'P2';
    if (input.deadline !== undefined) {
      const when = typeof input.deadline === 'string' && input.deadline.trim() !== '' ? new Date(input.deadline) : null;
      if (!when || Number.isNaN(when.getTime())) throw fail('invalid', 'deadline must be a date, like 2026-12-31.');
      out.deadline = when.toISOString();
    }
    if (input.note !== undefined) {
      if (typeof input.note !== 'string') throw fail('invalid', 'note must be text.');
      out.note = plain(input.note, MAX_NOTE);
    }
    if (input.githubRepo !== undefined) {
      const named = typeof input.githubRepo === 'string' ? repos.get(input.githubRepo.toLowerCase()) : undefined;
      if (!named) throw fail('invalid', 'That GitHub repository is not on your list (GITHUB_REPOS), so a project cannot use it.');
      out.githubRepo = named;
    }
    return out;
  }

  function buildCard(p, clientName) {
    const isClient = p.template === 'agency_client';
    const lines = [
      `Name: ${p.name}`,
      `Kind: ${isClient ? 'A project for a client' : 'A product the company builds and sells itself'}`,
      ...(isClient ? [`Client: ${clientName ?? 'not set'}`, `Service: ${p.service ? SERVICE_WORDS[p.service] : 'not set'}`] : []),
      `Priority: ${p.priority}`,
      `Deadline: ${p.deadline ? p.deadline.slice(0, 10) : 'not set'}`,
      `Teams that join it: ${templates[p.template].teams.map((t) => t.replace(/_/g, ' ')).join(', ')}`,
      `GitHub repository: ${p.githubRepo ?? 'none'}`,
      `What it is for: ${p.note || 'not set'}`,
    ];
    return {
      decide: `Open a new project space for "${p.name}"?`,
      why_now: isClient ? 'A new client project needs its own space before anyone can start work on it.' : 'A new product needs its own space before anyone can start work on it.',
      if_yes: `A private space is made for this project, with its own files, its own history of changes and its own notes. The right teams are added to it.${p.githubRepo ? ' The team can suggest changes on its GitHub page, but nothing goes live without your approval.' : ''} Nothing is sent to anyone.`,
      if_no: 'No space is made and nothing changes. You can ask again later.',
      cost: '₹0 ($0)',
      risk: { level: 'Low', reason: 'It only makes a folder on this computer, and it can be closed later.' },
      recommendation: 'Approve it if the name and the details are right.',
      details: lines.join('\n'),
    };
  }

  async function propose(input) {
    ensureRunning();
    const p = readProposal(input);
    let clientName;
    if (p.clientId) {
      const [client] = await store.select('clients', { where: { id: p.clientId }, limit: 1 });
      if (!client) throw fail('invalid', 'There is no client with that id.');
      clientName = plain(client.name, MAX_NAME);
    }
    const projectId = newId();
    const args = { projectId, ...p };
    let decision;
    try {
      decision = await decisions.create({ action: { tool: POD_TOOL, access: 'write', args }, card: buildCard(p, clientName) });
    } catch (err) {
      // The decisions service's own errors are written for the founder; a card that was not fit is said so.
      if (err && typeof err.code === 'string' && err.name === 'DecisionError') throw fail(err.code, err.message, err.problems);
      throw err;
    }
    return { ok: true, decisionId: decision.id, projectId };
  }

  // ---- opening an approved pod ------------------------------------------------

  const folderOf = (args, decisionId) => `${slugOf(args.name)}-${decisionId.slice(0, 8)}`;

  /** The folder inside the root and never anywhere else, even for an odd name. */
  function folderPath(folder) {
    const full = path.resolve(rootDir, folder);
    if (path.dirname(full) !== rootDir) throw fail('invalid', 'The project folder would be outside the projects folder.');
    return full;
  }

  async function writeFiles(full, args, clientName, decisionId) {
    const values = {
      name: args.name,
      client: clientName ?? 'not set',
      service: args.service ? SERVICE_WORDS[args.service] : 'not set',
      deadline: args.deadline ? args.deadline.slice(0, 10) : 'not set',
      priority: args.priority,
      note: args.note ?? '',
    };
    await fs.promises.mkdir(full, { recursive: true });
    for (const file of templates[args.template].files) {
      try {
        await fs.promises.writeFile(path.join(full, file.name), render(file.content, values), { flag: 'wx' });
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err; // a file that is already there stays as it is
      }
    }
  }

  async function startHistory(full, name) {
    if (fs.existsSync(path.join(full, '.git'))) return;
    await git(['init', '-q', '-b', 'main'], full);
    await git(['add', '-A'], full);
    await git(['-c', 'user.name=sfactory', '-c', 'user.email=sfactory@localhost', 'commit', '-q', '-m', `Open the project: ${name}`], full);
  }

  async function ensureProject(args, decisionId, folder) {
    const [existing] = await store.select('projects', { where: { id: args.projectId }, limit: 1 });
    if (existing) return existing;
    if (args.githubRepo !== undefined && !repos.has(String(args.githubRepo).toLowerCase())) throw fail('invalid', 'The repository on this card is no longer on your list (GITHUB_REPOS), so the project was not opened.');
    const row = { id: args.projectId, name: args.name, kind: args.template, priority: args.priority, status: 'active', repo_path: folder };
    if (args.githubRepo) row.github_repo = repos.get(String(args.githubRepo).toLowerCase());
    if (args.clientId) row.client_id = args.clientId;
    if (args.service) row.service = args.service;
    if (args.deadline) row.deadline = args.deadline;
    return store.insert('projects', row);
  }

  async function joinAgents(podId, template) {
    const agents = await store.select('agents', { where: {}, limit: 200 });
    const members = await store.select('pod_members', { where: { pod_id: podId }, limit: 200 });
    const joined = new Set(members.map((m) => m.agent_id));
    let added = 0;
    for (const agent of agents) {
      if (!templates[template].teams.includes(agent.team) || agent.status === 'removed' || agent.is_shared || joined.has(agent.id)) continue;
      if (!['team_lead', 'worker'].includes(agent.role)) continue;
      await store.insert('pod_members', { pod_id: podId, agent_id: agent.id });
      added += 1;
    }
    return added;
  }

  async function firstMemory(podId, args) {
    const rows = await store.select('memory', { where: { pod_id: podId }, limit: 50 });
    if (rows.some((m) => m.metadata?.event === 'pod_opened')) return false;
    await store.insert('memory', {
      pod_id: podId,
      kind: 'note',
      content: `This project space was opened for "${args.name}" (${args.template === 'agency_client' ? 'a client project' : 'a product of our own'}), priority ${args.priority}.${args.note ? ` What it is for: ${args.note}` : ''}`,
      metadata: { event: 'pod_opened' },
    });
    return true;
  }

  async function openNow(decisionId) {
    ensureRunning();
    if (typeof decisionId !== 'string' || !UUID.test(decisionId)) throw fail('invalid', 'decisionId must be a decision id.');
    const decision = await decisions.get(decisionId);
    if (!decision || decision.action?.tool !== POD_TOOL) throw fail('not_a_pod_decision', 'That is not a card about opening a project.');
    if (decision.status !== 'approved') throw fail('not_approved', 'A project is opened only after you approve it.');
    const args = decision.action.args;
    if (!isObject(args) || !UUID.test(args.projectId ?? '') || !templates[args.template]) throw fail('invalid', 'The card does not say what to open, so nothing was opened.');

    const folder = folderOf(args, decisionId);
    const full = folderPath(folder);
    let clientName;
    if (args.clientId) {
      const [client] = await store.select('clients', { where: { id: args.clientId }, limit: 1 });
      clientName = client ? plain(client.name, MAX_NAME) : undefined;
    }

    const [already] = await store.select('pods', { where: { decision_id: decisionId }, limit: 1 });
    await record(already ? 'pod.open_resumed' : 'pod.opening', decisionId, { name: args.name, template: args.template, folder }, already?.id);

    await ensureProject(args, decisionId, folder);
    await writeFiles(full, args, clientName, decisionId);
    await startHistory(full, args.name);

    let pod = already;
    if (!pod) {
      try {
        pod = await store.insert('pods', { id: newId(), project_id: args.projectId, template: args.template, decision_id: decisionId });
      } catch (err) {
        // Two runs at once: the other one made the pod. Use it.
        [pod] = await store.select('pods', { where: { decision_id: decisionId }, limit: 1 });
        if (!pod) throw err;
      }
    }
    const remembered = await firstMemory(pod.id, args);
    const joined = await joinAgents(pod.id, args.template);
    await record('pod.opened', pod.id, { name: args.name, template: args.template, folder, remembered, agentsJoined: joined }, pod.id);
    if (!already) announce('pod.opened', { id: pod.id, name: args.name });
    return { ok: true, podId: pod.id, projectId: args.projectId, folder: full, resumed: Boolean(already) };
  }

  function open(decisionId) {
    const key = String(decisionId);
    if (opening.has(key)) return opening.get(key);
    const run = openNow(decisionId).finally(() => opening.delete(key));
    opening.set(key, run);
    return run;
  }

  async function applyAnswer(decisionId) {
    if (typeof decisionId !== 'string' || !UUID.test(decisionId)) return;
    const decision = await decisions.get(decisionId);
    if (!decision || decision.action?.tool !== POD_TOOL || decision.status !== 'approved') return;
    try {
      await open(decisionId);
    } catch (err) {
      onError(err);
    }
  }

  async function start() {
    if (unsubscribe || !runtime?.on) return;
    unsubscribe = runtime.on('decision.resolved', (event) => {
      applyAnswer(event?.id).catch(onError);
    });
    // An approved card with no pod yet (answered while the app was closed, or a run that stopped half way) is opened now.
    try {
      // Only a card with no pod: an approved card that already has one was opened before, and is left alone.
      const approved = await decisions.listApproved({ tool: POD_TOOL, limit: 200 });
      const opened = new Set((await store.select('pods', { where: {}, limit: 1000 })).map((p) => p.decision_id));
      let count = 0;
      for (const d of approved) {
        if (opened.has(d.id) || count >= MAX_RECOVERED) continue;
        count += 1;
        await applyAnswer(d.id);
      }
    } catch (err) {
      onError(err);
    }
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
  }

  /** Open pods with their project and folder, for the window and the scripts. Plain fields only. */
  async function list({ limit = 50 } = {}) {
    const pods = await store.select('pods', { where: {}, order: 'opened_at.desc', limit });
    const projects = await store.select('projects', { where: {}, limit: 200 });
    const byId = new Map(projects.map((p) => [p.id, p]));
    return pods.map((pod) => {
      const project = byId.get(pod.project_id);
      return { id: pod.id, status: pod.status, template: pod.template, name: project?.name ?? '', priority: project?.priority ?? 'P2', folder: project?.repo_path ?? '', openedAt: pod.opened_at };
    });
  }

  /** Where a pod's folder is on disk, for tools that must stay inside it (step 3.2). */
  async function folderFor(podId) {
    if (rootDir === null || typeof podId !== 'string' || !UUID.test(podId)) return null;
    const [pod] = await store.select('pods', { where: { id: podId }, limit: 1 });
    if (!pod) return null;
    const [project] = await store.select('projects', { where: { id: pod.project_id }, limit: 1 });
    return project?.repo_path ? folderPath(project.repo_path) : null;
  }

  /** The GitHub repository a pod's project is tied to, or null. The pull-request tools take the repository from here and never from a model. */
  async function repoFor(podId) {
    if (typeof podId !== 'string' || !UUID.test(podId)) return null;
    const [pod] = await store.select('pods', { where: { id: podId.toLowerCase() }, limit: 1 });
    if (!pod) return null;
    const [project] = await store.select('projects', { where: { id: pod.project_id }, limit: 1 });
    return typeof project?.github_repo === 'string' ? project.github_repo : null;
  }

  /**
   * Change a project's priority (P1, P2 or P3). It is audited first, and nothing changes if the runtime is blocked or the audit entry cannot be written.
   * Shared specialists serve the highest priority first, using the priority as it is at that moment (step 3.5). The note in the project's own folder
   * is not rewritten: the database is the source of truth for the priority.
   */
  async function setPriority(input) {
    const reason = isBlocked();
    if (reason) throw fail('blocked', reason);
    if (!isObject(input) || Object.keys(input).some((k) => !['podId', 'priority'].includes(k))) throw fail('invalid', 'Only a project and a priority can be given.');
    if (typeof input.podId !== 'string' || !UUID.test(input.podId)) throw fail('invalid', 'The project (pod) id is not valid.');
    if (!PRIORITIES.includes(input.priority)) throw fail('invalid', `priority must be one of: ${PRIORITIES.join(', ')}.`);
    const podId = input.podId.toLowerCase();
    const [pod] = await store.select('pods', { where: { id: podId }, limit: 1 });
    if (!pod || pod.status !== 'open') throw fail('not_found', 'There is no open project with that id.');
    const [project] = await store.select('projects', { where: { id: pod.project_id }, limit: 1 });
    if (!project) throw fail('not_found', 'There is no open project with that id.');
    await record('pod.priority_changed', podId, { from: project.priority, to: input.priority }, podId);
    const changed = await store.update('projects', { id: project.id }, { priority: input.priority, updated_at: now().toISOString() });
    if (!Array.isArray(changed) || changed.length === 0) throw fail('not_found', 'There is no open project with that id.');
    return { podId, priority: input.priority, previous: project.priority };
  }

  return { propose, open, start, stop, list, folderFor, repoFor, setPriority, templates: describeTemplates, problems: loaded.problems, PodError };
}

module.exports = { createPods, PodError, slugOf, runGit };
