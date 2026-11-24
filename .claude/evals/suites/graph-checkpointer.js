'use strict';

// Grades the Supabase-backed LangGraph checkpoint store (PLAN.md step 1.7b):
//   src/runtime/orchestrator/checkpointer.js   createSupabaseSaver({ store }) -> BaseCheckpointSaver
//
// It runs against the real REST client and a real Postgres with the real migrations
// (scripts/fake-supabase.js), so the two new tables and the code agree. The last cases
// drive a real LangGraph pause and resume through TWO separate saver instances over the
// same database, which is what an app restart looks like.
//
// The store has no upsert or delete: the saver checks, then inserts or updates. Values are
// stored as base64 text, so any bytes the serializer produces survive.

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/orchestrator/checkpointer.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

let environment = null;
async function database() {
  if (!environment) {
    const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
    const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
    const fake = await startFakeSupabase();
    environment = { fake, store: createRestStore({ url: fake.url, serviceKey: fake.serviceKey }) };
  }
  return environment;
}

/** A saver over the shared database. The module is loaded first so a missing file stays "pending". */
async function newSaver(store) {
  const mod = loadSubject(SUBJECT);
  return mod.createSupabaseSaver({ store: store ?? (await database()).store });
}

let counter = 0;
const thread = (name) => `${name}-${Date.now().toString(36)}-${(counter += 1)}`;
const cfg = (threadId, extra = {}) => ({ configurable: { thread_id: threadId, checkpoint_ns: '', ...extra } });

function checkpoint(id, channelValues = {}) {
  const { emptyCheckpoint } = require('@langchain/langgraph-checkpoint');
  return { ...emptyCheckpoint(), id, channel_values: channelValues };
}
const meta = (step) => ({ source: 'loop', step, parents: {} });

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return err;
  }
}

/** Save checkpoints c1..cN for a thread, each pointing at the one before. Returns the thread id. */
async function seed(saver, name, count) {
  const t = thread(name);
  let config = cfg(t);
  for (let i = 1; i <= count; i += 1) {
    config = await saver.put(config, checkpoint(`c${i}`, { n: i }), meta(i), {});
  }
  return t;
}

/** A tiny ask-then-act graph, the shape the orchestrator uses. */
function askGraphKit() {
  const { StateGraph, Annotation, interrupt, START, END } = require('@langchain/langgraph');
  const State = Annotation.Root({
    goal: Annotation(),
    answer: Annotation(),
    log: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  });
  const buildAskGraph = (checkpointer) =>
    new StateGraph(State)
      .addNode('ask', (s) => ({ answer: interrupt({ question: `May I proceed with: ${s.goal}?` }), log: ['asked'] }))
      .addNode('act', (s) => ({ log: [s.answer === 'approved' ? 'ran the action' : 'did NOT run the action'] }))
      .addEdge(START, 'ask')
      .addEdge('ask', 'act')
      .addEdge('act', END)
      .compile({ checkpointer });
  return { buildAskGraph };
}

const cases = [
  // ---- Saving and loading ---------------------------------------------------
  {
    id: 'a-saved-checkpoint-comes-back-as-the-latest-with-its-metadata',
    async check() {
      const saver = await newSaver();
      const t = thread('latest');
      await saver.put(cfg(t), checkpoint('c1', { greeting: 'hello' }), meta(1), {});
      const tuple = await saver.getTuple(cfg(t));
      const ok = tuple && tuple.checkpoint.id === 'c1' && tuple.checkpoint.channel_values.greeting === 'hello' && json(tuple.metadata) === json(meta(1)) && tuple.config.configurable.checkpoint_id === 'c1';
      return verdict(ok, json(tuple));
    },
  },
  {
    id: 'the-latest-checkpoint-is-the-newest-and-an-id-asks-for-an-older-one',
    async check() {
      const saver = await newSaver();
      const t = await seed(saver, 'newest', 3);
      const latest = await saver.getTuple(cfg(t));
      const older = await saver.getTuple(cfg(t, { checkpoint_id: 'c2' }));
      return verdict(latest.checkpoint.id === 'c3' && older.checkpoint.id === 'c2' && older.checkpoint.channel_values.n === 2, `latest ${latest?.checkpoint.id}, older ${older?.checkpoint.id}`);
    },
  },
  {
    id: 'the-parent-config-points-at-the-checkpoint-before',
    async check() {
      const saver = await newSaver();
      const t = await seed(saver, 'parent', 2);
      const second = await saver.getTuple(cfg(t));
      const first = await saver.getTuple(cfg(t, { checkpoint_id: 'c1' }));
      return verdict(second.parentConfig?.configurable.checkpoint_id === 'c1' && first.parentConfig === undefined, json([second.parentConfig, first.parentConfig]));
    },
  },
  {
    id: 'a-thread-with-nothing-saved-returns-undefined',
    async check() {
      const saver = await newSaver();
      const none = await saver.getTuple(cfg(thread('empty')));
      const missingId = await saver.getTuple(cfg(await seed(saver, 'has-one', 1), { checkpoint_id: 'nope' }));
      return verdict(none === undefined && missingId === undefined, json([none, missingId]));
    },
  },
  {
    id: 'threads-and-namespaces-never-see-each-other',
    async check() {
      const saver = await newSaver();
      const a = thread('iso-a');
      const b = thread('iso-b');
      await saver.put(cfg(a), checkpoint('c1', { who: 'a' }), meta(1), {});
      await saver.put(cfg(b), checkpoint('c1', { who: 'b' }), meta(1), {});
      await saver.put(cfg(a, { checkpoint_ns: 'sub' }), checkpoint('c9', { who: 'a-sub' }), meta(1), {});
      const [ta, tb, tsub] = [await saver.getTuple(cfg(a)), await saver.getTuple(cfg(b)), await saver.getTuple(cfg(a, { checkpoint_ns: 'sub' }))];
      return verdict(ta.checkpoint.channel_values.who === 'a' && tb.checkpoint.channel_values.who === 'b' && tsub.checkpoint.channel_values.who === 'a-sub' && ta.checkpoint.id === 'c1', json([ta.checkpoint.channel_values, tb.checkpoint.channel_values, tsub.checkpoint.channel_values]));
    },
  },
  {
    id: 'values-survive-unicode-nesting-binary-and-size',
    async check() {
      const saver = await newSaver();
      const t = thread('values');
      const values = { text: 'नमस्ते ₹ 日本語 "quotes" \\ back\nline', nested: { a: [1, { b: null }], c: true }, big: 'x'.repeat(300_000), bytes: new Uint8Array([0, 1, 254, 255]) };
      await saver.put(cfg(t), checkpoint('c1', values), meta(1), {});
      const got = (await saver.getTuple(cfg(t))).checkpoint.channel_values;
      const same = got.text === values.text && json(got.nested) === json(values.nested) && got.big === values.big && Array.from(got.bytes).join() === '0,1,254,255';
      return verdict(same, `text ok ${got.text === values.text}, big ok ${got.big === values.big}`);
    },
  },
  {
    id: 'saving-the-same-checkpoint-id-again-replaces-it',
    async check() {
      const saver = await newSaver();
      const t = thread('replace');
      await saver.put(cfg(t), checkpoint('c1', { v: 1 }), meta(1), {});
      await saver.put(cfg(t), checkpoint('c1', { v: 2 }), meta(2), {});
      const all = await collect(saver.list(cfg(t)));
      return verdict(all.length === 1 && all[0].checkpoint.channel_values.v === 2 && all[0].metadata.step === 2, json(all.map((x) => x.checkpoint.channel_values)));
    },
  },

  // ---- Pending writes ----------------------------------------------------------
  {
    id: 'pending-writes-come-back-with-their-checkpoint-in-a-fixed-order',
    async check() {
      const saver = await newSaver();
      const t = thread('writes');
      const config = await saver.put(cfg(t), checkpoint('c1'), meta(1), {});
      await saver.putWrites(config, [['x', 'from-b']], 'task-b');
      await saver.putWrites(config, [['p', 1], ['q', 2]], 'task-a');
      const writes = (await saver.getTuple(cfg(t))).pendingWrites;
      return verdict(json(writes) === json([['task-a', 'p', 1], ['task-a', 'q', 2], ['task-b', 'x', 'from-b']]), json(writes));
    },
  },
  {
    id: 'an-ordinary-write-repeated-keeps-the-first-and-a-special-one-is-replaced',
    async check() {
      const saver = await newSaver();
      const t = thread('conflict');
      const config = await saver.put(cfg(t), checkpoint('c1'), meta(1), {});
      await saver.putWrites(config, [['ordinary', 'first']], 'task-1');
      await saver.putWrites(config, [['ordinary', 'second']], 'task-1');
      await saver.putWrites(config, [['__interrupt__', 'first-q']], 'task-1');
      await saver.putWrites(config, [['__interrupt__', 'second-q']], 'task-1');
      const writes = (await saver.getTuple(cfg(t))).pendingWrites;
      const ordinary = writes.filter((w) => w[1] === 'ordinary').map((w) => w[2]);
      const special = writes.filter((w) => w[1] === '__interrupt__').map((w) => w[2]);
      return verdict(json(ordinary) === '["first"]' && json(special) === '["second-q"]', json(writes));
    },
  },
  {
    id: 'writes-belong-to-the-checkpoint-they-were-made-for',
    async check() {
      const saver = await newSaver();
      const t = thread('own-writes');
      const c1 = await saver.put(cfg(t), checkpoint('c1'), meta(1), {});
      const c2 = await saver.put(c1, checkpoint('c2'), meta(2), {});
      await saver.putWrites(c1, [['only-for-c1', 1]], 'task-1');
      const first = await saver.getTuple(cfg(t, { checkpoint_id: 'c1' }));
      const second = await saver.getTuple(c2);
      return verdict(first.pendingWrites.length === 1 && second.pendingWrites.length === 0, json([first.pendingWrites, second.pendingWrites]));
    },
  },
  {
    id: 'putting-or-writing-without-a-thread-or-checkpoint-id-throws',
    async check() {
      const saver = await newSaver();
      const t = thread('bad-config');
      const errs = [
        await rejects(() => saver.put({ configurable: {} }, checkpoint('c1'), meta(1), {})),
        await rejects(() => saver.put({}, checkpoint('c1'), meta(1), {})),
        await rejects(() => saver.putWrites({ configurable: { thread_id: t } }, [['a', 1]], 'task')),
        await rejects(() => saver.putWrites({ configurable: { checkpoint_id: 'c1' } }, [['a', 1]], 'task')),
      ];
      return verdict(errs.every(Boolean), `threw: ${errs.map(Boolean)}`);
    },
  },

  // ---- Listing -------------------------------------------------------------------
  {
    id: 'list-is-newest-first-and-only-for-its-own-thread',
    async check() {
      const saver = await newSaver();
      const t = await seed(saver, 'list', 3);
      await seed(saver, 'list-other', 2);
      const ids = (await collect(saver.list(cfg(t)))).map((x) => x.checkpoint.id);
      return verdict(ids.join() === 'c3,c2,c1', ids.join());
    },
  },
  {
    id: 'list-honours-limit-before-and-a-metadata-filter',
    async check() {
      const saver = await newSaver();
      const t = await seed(saver, 'list-opts', 4);
      const limited = (await collect(saver.list(cfg(t), { limit: 2 }))).map((x) => x.checkpoint.id);
      const before = (await collect(saver.list(cfg(t), { before: cfg(t, { checkpoint_id: 'c3' }) }))).map((x) => x.checkpoint.id);
      const filtered = (await collect(saver.list(cfg(t), { filter: { step: 2 } }))).map((x) => x.checkpoint.id);
      const ok = limited.join() === 'c4,c3' && before.join() === 'c2,c1' && filtered.join() === 'c2';
      return verdict(ok, json({ limited, before, filtered }));
    },
  },
  {
    id: 'list-carries-each-checkpoints-pending-writes',
    async check() {
      const saver = await newSaver();
      const t = thread('list-writes');
      const c1 = await saver.put(cfg(t), checkpoint('c1'), meta(1), {});
      await saver.putWrites(c1, [['x', 1]], 'task-1');
      const [item] = await collect(saver.list(cfg(t)));
      return verdict(json(item.pendingWrites) === json([['task-1', 'x', 1]]), json(item.pendingWrites));
    },
  },

  {
    id: 'list-reads-and-loads-writes-only-for-what-it-returns',
    async check() {
      const { store } = await database();
      const seen = { limits: [], writeReads: 0 };
      const counting = {
        insert: store.insert.bind(store),
        update: store.update.bind(store),
        select: async (table, options) => {
          if (table === 'graph_writes') seen.writeReads += 1;
          else seen.limits.push(options?.limit);
          return store.select(table, options);
        },
      };
      const saver = await newSaver(counting);
      const t = await seed(saver, 'cheap-list', 5);

      seen.limits.length = 0;
      seen.writeReads = 0;
      const limited = await collect(saver.list(cfg(t), { limit: 2 }));
      const limitedOk = limited.length === 2 && seen.limits.join() === '2' && seen.writeReads === 2;

      seen.writeReads = 0;
      const filtered = await collect(saver.list(cfg(t), { filter: { step: 2 } }));
      const filteredOk = filtered.length === 1 && seen.writeReads === 1;
      return verdict(limitedOk && filteredOk, json({ limited: [limited.length, seen.limits, seen.writeReads], filtered: filtered.length }));
    },
  },

  // ---- Failure behaviour -----------------------------------------------------------
  {
    id: 'a-failing-store-makes-the-saver-fail-loudly',
    async check() {
      const down = async () => {
        throw new Error('database down');
      };
      const saver = await newSaver({ select: down, insert: down, update: down });
      const errs = [
        await rejects(() => saver.getTuple(cfg('t'))),
        await rejects(() => saver.put(cfg('t'), checkpoint('c1'), meta(1), {})),
        await rejects(() => collect(saver.list(cfg('t')))),
      ];
      return verdict(errs.every(Boolean), `threw: ${errs.map(Boolean)}`);
    },
  },
  {
    id: 'deleting-a-thread-says-it-is-not-supported-yet',
    async check() {
      const saver = await newSaver();
      const err = await rejects(() => saver.deleteThread(thread('del')));
      return verdict(err && /not supported/i.test(err.message), err && err.message);
    },
  },

  // ---- A real graph through the saver ------------------------------------------------
  {
    id: 'a-paused-graph-resumes-through-a-new-saver-as-after-a-restart',
    async check() {
      const { buildAskGraph } = askGraphKit();
      const { store } = await database();
      const t = thread('restart');

      const before = buildAskGraph(await newSaver(store));
      const first = await before.invoke({ goal: 'Buy the domain' }, cfg(t));
      const paused = first.__interrupt__?.[0]?.value;

      // "The app restarts": a brand new saver and graph over the same database.
      const { Command } = require('@langchain/langgraph');
      const after = buildAskGraph(await newSaver(store));
      const state = await after.getState(cfg(t));
      const done = await after.invoke(new Command({ resume: 'approved' }), cfg(t));
      const ok = paused?.question && json(state.next) === '["ask"]' && done.log.join() === 'asked,ran the action';
      return verdict(ok, json({ paused, next: state.next, log: done.log }));
    },
  },
  {
    id: 'a-rejected-answer-through-the-saver-does-not-run-the-action',
    async check() {
      const { buildAskGraph } = askGraphKit();
      const { store } = await database();
      const t = thread('rejected');
      await buildAskGraph(await newSaver(store)).invoke({ goal: 'Buy the domain' }, cfg(t));
      const { Command } = require('@langchain/langgraph');
      const done = await buildAskGraph(await newSaver(store)).invoke(new Command({ resume: 'rejected' }), cfg(t));
      return verdict(done.log.join() === 'asked,did NOT run the action', done.log.join());
    },
  },
  {
    id: 'two-paused-graphs-resume-independently',
    async check() {
      const { buildAskGraph } = askGraphKit();
      const { store } = await database();
      const [a, b] = [thread('indep-a'), thread('indep-b')];
      const graph = buildAskGraph(await newSaver(store));
      await graph.invoke({ goal: 'Goal A' }, cfg(a));
      await graph.invoke({ goal: 'Goal B' }, cfg(b));
      const { Command } = require('@langchain/langgraph');
      const doneA = await graph.invoke(new Command({ resume: 'approved' }), cfg(a));
      const stateB = await graph.getState(cfg(b));
      return verdict(doneA.log.join() === 'asked,ran the action' && json(stateB.next) === '["ask"]', json({ a: doneA.log, bNext: stateB.next }));
    },
  },
];

module.exports = {
  name: 'graph-checkpointer',
  description: 'Supabase-backed LangGraph checkpoint store: round trips, isolation, writes, listing, failures, and a real pause and resume across a restart',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
