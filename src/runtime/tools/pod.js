'use strict';

// The pod's own client (PLAN.md step 3.2): `pod.get_client` gives the client of the project the run belongs to, and nobody else's. Graded by the
// `pod-isolation` eval.
//
// The pod comes from the RUN (`context.podId`), never from the arguments: the tool takes no client id, no name and no pod, so a run in one pod has no way to
// ask for another pod's client. Outside a pod there is no client to give. The text is checked for secrets before it leaves, and an error is one plain sentence.

const { redactDetail } = require('../audit');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED = 'The client details cannot be read.';
const MAX_NOTES_CHARS = 2000;

function createPodTools({ store } = {}) {
  if (!store || typeof store.select !== 'function') return [];

  return [
    Object.freeze({
      name: 'pod.get_client',
      access: 'read',
      podAccess: 'scoped',
      summary: 'Gives the name, email, country and notes of the client of the project you are working in. It takes no arguments and only ever shows this project\'s own client.',
      args: '{}',
      checkArgs: (args) => (args !== null && typeof args === 'object' && !Array.isArray(args) ? (Object.keys(args)[0] ? `unknown argument: ${Object.keys(args)[0]}` : null) : 'the arguments must be an object'),
      async run({ context }) {
        const podId = context?.podId;
        if (typeof podId !== 'string' || !UUID.test(podId)) throw new Error(FAILED);
        try {
          const [pod] = await store.select('pods', { where: { id: podId.toLowerCase() }, limit: 1 });
          if (!pod) throw new Error(FAILED);
          const [project] = await store.select('projects', { where: { id: pod.project_id }, limit: 1 });
          if (!project?.client_id) return { text: 'This project has no client: it is a product of our own.' };
          const [client] = await store.select('clients', { where: { id: project.client_id }, limit: 1 });
          if (!client) throw new Error(FAILED);
          const lines = [
            `Name: ${client.name}`,
            `Email: ${client.email ?? 'not set'}`,
            `Country: ${client.country ?? 'not set'}`,
            `Status: ${client.status}`,
            `Notes: ${String(client.notes ?? 'none').slice(0, MAX_NOTES_CHARS)}`,
          ];
          return { text: redactDetail(lines.join('\n')) };
        } catch {
          throw new Error(FAILED);
        }
      },
    }),
  ];
}

module.exports = { createPodTools };
