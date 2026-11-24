'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyCheckpoint } = require('@langchain/langgraph-checkpoint');

const { createSupabaseSaver } = require('./checkpointer');

/** An in-memory stand-in for the REST store that counts what the saver asks of it. */
function fakeStore() {
  const tables = { graph_checkpoints: [], graph_writes: [] };
  const calls = { insert: 0, update: 0 };
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    tables,
    calls,
    async select(table, { where = {}, limit } = {}) {
      const rows = tables[table].filter((r) => matches(r, where));
      return limit ? rows.slice(0, limit) : rows;
    },
    async insert(table, row) {
      calls.insert += 1;
      tables[table].push({ ...row });
      return row;
    },
    async update(table, where, patch) {
      calls.update += 1;
      for (const row of tables[table].filter((r) => matches(r, where))) Object.assign(row, patch);
    },
  };
}

const config = (extra = {}) => ({ configurable: { thread_id: 't', checkpoint_ns: '', ...extra } });
const checkpoint = (id) => ({ ...emptyCheckpoint(), id });

test('it refuses to be built without a usable store', () => {
  for (const store of [undefined, null, {}, { select() {}, insert() {} }]) {
    assert.throws(() => createSupabaseSaver({ store }), /needs the runtime store/);
  }
});

test('a new checkpoint is inserted and the same id again is updated, never inserted twice', async () => {
  const store = fakeStore();
  const saver = createSupabaseSaver({ store });
  await saver.put(config(), checkpoint('c1'), { step: 1 }, {});
  await saver.put(config(), checkpoint('c1'), { step: 2 }, {});
  assert.deepEqual(store.calls, { insert: 1, update: 1 });
  assert.equal(store.tables.graph_checkpoints.length, 1);
});

test('values are stored as base64 text, never as raw bytes or objects', async () => {
  const store = fakeStore();
  await createSupabaseSaver({ store }).put(config(), checkpoint('c1'), { step: 1 }, {});
  const [row] = store.tables.graph_checkpoints;
  for (const field of [row.checkpoint, row.metadata]) {
    assert.equal(typeof field, 'string');
    assert.match(field, /^[A-Za-z0-9+/]*={0,2}$/);
  }
});

test('an ordinary write repeated is skipped without touching the store again', async () => {
  const store = fakeStore();
  const saver = createSupabaseSaver({ store });
  const saved = await saver.put(config(), checkpoint('c1'), { step: 1 }, {});
  await saver.putWrites(saved, [['channel', 'first']], 'task');
  const before = { ...store.calls };
  await saver.putWrites(saved, [['channel', 'second']], 'task');
  assert.deepEqual(store.calls, before);
});

test('listing stops reading checkpoints once the limit is reached', async () => {
  const store = fakeStore();
  const saver = createSupabaseSaver({ store });
  let parent = config();
  for (const id of ['c1', 'c2', 'c3']) parent = await saver.put(parent, checkpoint(id), { step: 1 }, {});
  let seen = 0;
  for await (const _item of saver.list(config(), { limit: 1 })) seen += 1;
  assert.equal(seen, 1);
});

test('a missing thread id is refused before the store is touched', async () => {
  const store = fakeStore();
  const saver = createSupabaseSaver({ store });
  await assert.rejects(saver.getTuple({ configurable: {} }), /thread_id/);
  assert.deepEqual(store.calls, { insert: 0, update: 0 });
});
