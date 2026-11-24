'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemorySaver } = require('@langchain/langgraph');

const { checkAction } = require('../policy');
const { createOrchestrator } = require('./graph');

const routine = (title) => ({ title, action: { tool: 'docs.create_draft', access: 'write', args: {} } });
const spend = (title) => ({ title, action: { tool: 'namecheap.purchase_domain', access: 'write', args: {} } });

function setup({ tasks, getFails = false } = {}) {
  const ran = [];
  const rows = new Map();
  const decisions = {
    async create({ action }) {
      const id = `dec-${rows.size + 1}`;
      rows.set(id, { id, status: 'pending', category: checkAction(action).category });
      return { id };
    },
    async get(id) {
      if (getFails) throw new Error('database down');
      return rows.get(id) ?? null;
    },
  };
  const orch = createOrchestrator({
    planner: async () => tasks,
    writeCard: async ({ task }) => ({ decide: task.title }),
    runTool: async ({ action }) => {
      ran.push(action.tool);
      await new Promise((resolve) => setImmediate(resolve)); // a real tool takes time
    },
    decisions,
    policy: { checkAction },
    checkpointer: new MemorySaver(),
    audit: async () => {},
  });
  return { orch, ran, rows };
}

test('a plan of 20 tasks finishes: LangGraph default step limit is not hit', async () => {
  const { orch, ran } = setup({ tasks: Array.from({ length: 20 }, (_, i) => routine(`Task ${i + 1}`)) });
  const res = await orch.start({ goal: 'Do twenty things', threadId: 'twenty' });
  assert.equal(res.status, 'done');
  assert.equal(ran.length, 20);
});

test('twenty tasks with a spend in the middle pause and then finish', async () => {
  const tasks = Array.from({ length: 20 }, (_, i) => (i === 10 ? spend('Buy') : routine(`Task ${i + 1}`)));
  const { orch, ran, rows } = setup({ tasks });
  const paused = await orch.start({ goal: 'Do many things', threadId: 'mid' });
  assert.equal(paused.status, 'waiting');
  assert.equal(ran.length, 10);
  rows.get(paused.waitingFor).status = 'approved';
  const res = await orch.resume({ threadId: 'mid' });
  assert.equal(res.status, 'done');
  assert.equal(ran.length, 20);
});

test('two answers arriving at once resume the run once and run the tool once', async () => {
  const { orch, ran, rows } = setup({ tasks: [spend('Buy it')] });
  const paused = await orch.start({ goal: 'Buy it', threadId: 'race' });
  rows.get(paused.waitingFor).status = 'approved';
  const [a, b] = await Promise.all([orch.resume({ threadId: 'race' }), orch.resume({ threadId: 'race' })]);
  assert.equal(a.status, 'done');
  assert.equal(b.status, 'done');
  assert.equal(ran.length, 1);
});

test('a decision that cannot be read keeps the run waiting instead of guessing', async () => {
  const flaky = setup({ tasks: [spend('Buy it')], getFails: true });
  const first = await flaky.orch.start({ goal: 'Buy it', threadId: 'flaky' });
  const again = await flaky.orch.resume({ threadId: 'flaky' });
  assert.equal(first.status, 'waiting');
  assert.equal(again.status, 'waiting');
  assert.equal(flaky.ran.length, 0);
});

test('a generated thread id is used when none is given, and the run can be found by it', async () => {
  const { orch } = setup({ tasks: [spend('Buy it')] });
  const paused = await orch.start({ goal: 'Buy it' });
  assert.match(paused.threadId, /^[0-9a-f-]{36}$/);
  assert.equal((await orch.status({ threadId: paused.threadId })).status, 'waiting');
});
