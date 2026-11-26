'use strict';

// The production deploy, after the founder says yes (PLAN.md step 4.5). Graded by the `deploy-tools` eval.
//
//   createDeployer({ store, audit, decisions, runtime, api, repoFor, productionBranch?, isBlocked?, emit?, onError? })
//     .deployFor(decisionId)   -> { status: 'started' | 'ignored' | 'blocked' | 'failed' }
//     .start() / .stop()       listens for answers, and on start picks up cards approved while the app was closed
//     .settled()               -> resolves when the deploys it started have ended
//
// A production deploy is never an agent's act. An agent that reaches for `vercel.deploy` with a production target (or none) is stopped by the policy and the
// team files a card (decisions.js). This is the other half: when that card is APPROVED, this trusted code starts the production deploy, once, and tells the
// founder how it went (the runtime event `deploy.finished`, which the phone shows).
//
//   - only an APPROVED card of `vercel.deploy` whose target is not a preview, filed for a project; a no, a preview, a card for no project and any other
//     tool never deploys anything
//   - what is deployed comes from the PROJECT: its GitHub repository (never the card's arguments, which a model wrote) and the production branch (`main`)
//   - once per answer: `deploy.production_started` is written to the audit log BEFORE Vercel is called, and an answer that already has one is never run
//     again, even when the deploy failed (the founder asks again with a new card); announcing the same answer twice does nothing
//   - when the audit entry cannot be written, or the runtime is blocked, nothing is deployed
//   - a project with no repository, no Vercel token, or a Vercel that refuses, is told to the founder in one plain sentence; Vercel's words and the token
//     are never shown or logged

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const RECOVER_LIMIT = 50;

/** A target that is not a preview is a production deploy: the same rule the policy uses. */
const isProduction = (args) => !(isObject(args) && typeof args.target === 'string' && args.target.trim().toLowerCase() === 'preview');

function createDeployer({ store, audit, decisions, runtime, api, repoFor, productionBranch = 'main', isBlocked = () => null, emit = () => {}, onError = () => {} } = {}) {
  let unsubscribe = null;
  let chain = Promise.resolve();
  const inFlight = new Set();
  const handling = new Set();

  const track = (promise) => {
    handling.add(promise);
    promise.then(() => handling.delete(promise), () => handling.delete(promise));
    return promise;
  };

  const tell = (ok, message) => {
    try {
      emit('deploy.finished', { ok, message });
    } catch (err) {
      onError(err);
    }
  };

  async function finish(decisionId, podId, ok, message, reason) {
    try {
      await audit.append({ actorType: 'system', podId, action: 'deploy.production_finished', targetType: 'decision', targetId: decisionId, detail: { decisionId, ok, ...(reason ? { reason } : {}) } });
    } catch (err) {
      onError(err); // the result is still told to the founder
    }
    tell(ok, message);
  }

  async function run(decisionId, podId, repo) {
    if (!api?.configured) return finish(decisionId, podId, false, 'The production deploy was not started: Vercel is not connected (VERCEL_TOKEN is not set), so nothing was deployed.', 'not_connected');
    if (!repo) return finish(decisionId, podId, false, 'The production deploy was not started: this project has no GitHub repository, so there is nothing to deploy.', 'no_repository');
    let made;
    try {
      made = await api.createDeployment({ repo, ref: productionBranch, production: true });
    } catch (err) {
      onError(err);
      made = { ok: false, reason: 'failed' };
    }
    if (!made.ok) return finish(decisionId, podId, false, `The production deploy of ${repo} could not be started. Nothing was changed on the live site. Ask again with a new card when the cause is fixed.`, made.reason);
    return finish(decisionId, podId, true, `The production deploy of ${repo} was started: https://${made.url}. It may take a minute to be ready.`);
  }

  async function deployFor(decisionId) {
    if (typeof decisionId !== 'string' || inFlight.has(decisionId)) return { status: 'ignored' };
    inFlight.add(decisionId);
    try {
      const decision = await decisions.get(decisionId);
      if (!isObject(decision) || decision.status !== 'approved' || !isObject(decision.action) || decision.action.tool !== 'vercel.deploy' || !isProduction(decision.action.args) || !decision.pod_id) return { status: 'ignored' };
      if (isBlocked()) return { status: 'blocked' };
      const done = (await store.select('audit_log', { where: { action: 'deploy.production_started' }, order: 'id.desc', limit: 500 })).some((r) => r.detail?.decisionId === decisionId);
      if (done) return { status: 'ignored' };

      let repo = null;
      try {
        repo = (await repoFor(decision.pod_id)) ?? null;
      } catch (err) {
        onError(err);
      }
      try {
        await audit.append({ actorType: 'system', podId: decision.pod_id, action: 'deploy.production_started', targetType: 'decision', targetId: decisionId, detail: { decisionId, ref: productionBranch, ...(repo ? { repo } : {}) } });
      } catch (err) {
        onError(err);
        return { status: 'failed' };
      }
      chain = chain.then(() => run(decisionId, decision.pod_id, repo)).catch((err) => onError(err));
      return { status: 'started' };
    } catch (err) {
      onError(err);
      return { status: 'failed' };
    } finally {
      inFlight.delete(decisionId);
    }
  }

  async function recover() {
    let rows = [];
    try {
      rows = await decisions.listApproved({ tool: 'vercel.deploy', limit: RECOVER_LIMIT });
    } catch (err) {
      onError(err);
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.id) await deployFor(row.id);
    }
  }

  return {
    deployFor,

    start() {
      unsubscribe?.();
      unsubscribe = runtime.on('decision.resolved', (event) => {
        if (isObject(event) && typeof event.id === 'string' && event.status === 'approved') track(deployFor(event.id)).catch(onError);
      });
      track(recover()).catch(onError);
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },

    async settled() {
      for (;;) {
        await Promise.allSettled([...handling]);
        const seen = chain;
        await seen;
        if (seen === chain && handling.size === 0) return;
      }
    },
  };
}

module.exports = { createDeployer, isProduction };
