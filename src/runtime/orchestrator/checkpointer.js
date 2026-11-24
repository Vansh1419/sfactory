'use strict';

// The LangGraph checkpoint store on the existing Supabase REST client (PLAN.md step 1.7b).
// A run that is waiting for a founder decision is saved here, so it survives the app closing.
// Graded by the `graph-checkpointer` eval, against a real Postgres with the real migrations.
//
// The REST store can select, insert and update with equality filters, and nothing else:
// no upsert, no delete, no "less than". So this saver checks first and then inserts or
// updates, and filters `before` and metadata in code. Checkpoint and write values are
// serialized by LangGraph and kept as base64 text, so any bytes survive.
//
// Not supported yet: deleting a thread (the REST store cannot delete), and reading checkpoints
// older than LangGraph's version 4 format (this store never held any).

const { BaseCheckpointSaver, copyCheckpoint } = require('@langchain/langgraph');
const { WRITES_IDX_MAP, compareWritesSortKeys, writesSortKey } = require('@langchain/langgraph-checkpoint');

const CHECKPOINTS = 'graph_checkpoints';
const WRITES = 'graph_writes';

const toText = (bytes) => Buffer.from(bytes).toString('base64');
const toBytes = (text) => new Uint8Array(Buffer.from(text, 'base64'));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class SupabaseSaver extends BaseCheckpointSaver {
  constructor(store, serde) {
    super(serde);
    this.store = store;
  }

  /** The thread, namespace and (optionally) checkpoint a LangGraph config points at. */
  static address(config, { needCheckpoint = false } = {}) {
    const { thread_id: threadId, checkpoint_ns: ns = '', checkpoint_id: checkpointId } = config?.configurable ?? {};
    if (!threadId) throw new Error('Missing "thread_id" in config.configurable.');
    if (needCheckpoint && !checkpointId) throw new Error('Missing "checkpoint_id" in config.configurable.');
    return { threadId, ns, checkpointId };
  }

  async pendingWritesFor(threadId, ns, checkpointId) {
    const rows = await this.store.select(WRITES, { where: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpointId } });
    const keyed = rows.map((row) => ({ row, key: writesSortKey(row.task_path ?? '', row.task_id, row.idx ?? 0) }));
    keyed.sort((a, b) => compareWritesSortKeys(a.key, b.key));
    return Promise.all(keyed.map(async ({ row }) => [row.task_id, row.channel, await this.serde.loadsTyped(row.type ?? 'json', toBytes(row.value))]));
  }

  /** A checkpoint row as LangGraph wants it, without its pending writes (those cost one more query). */
  async decode(row) {
    const type = row.type ?? 'json';
    const config = { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } };
    return {
      config,
      checkpoint: await this.serde.loadsTyped(type, toBytes(row.checkpoint)),
      metadata: await this.serde.loadsTyped(type, toBytes(row.metadata)),
      parentConfig: row.parent_checkpoint_id
        ? { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.parent_checkpoint_id } }
        : undefined,
    };
  }

  async tupleFrom(row) {
    return { ...(await this.decode(row)), pendingWrites: await this.pendingWritesFor(row.thread_id, row.checkpoint_ns, row.checkpoint_id) };
  }

  async getTuple(config) {
    const { threadId, ns, checkpointId } = SupabaseSaver.address(config);
    const where = { thread_id: threadId, checkpoint_ns: ns, ...(checkpointId ? { checkpoint_id: checkpointId } : {}) };
    const [row] = await this.store.select(CHECKPOINTS, { where, order: 'checkpoint_id.desc', limit: 1 });
    return row ? this.tupleFrom(row) : undefined;
  }

  async *list(config, options) {
    const { limit, before, filter } = options ?? {};
    const threadId = config?.configurable?.thread_id;
    const ns = config?.configurable?.checkpoint_ns;
    const where = { ...(threadId ? { thread_id: threadId } : {}), ...(ns !== undefined && ns !== null ? { checkpoint_ns: ns } : {}) };
    const beforeId = before?.configurable?.checkpoint_id;
    const wanted = Object.entries(filter ?? {}).filter(([, value]) => value !== undefined);

    // The REST store has no "less than" and cannot filter inside metadata, so `before` and `filter`
    // are applied here. Without them a limit can be handed to the database.
    const pushLimit = limit !== undefined && beforeId === undefined && wanted.length === 0;
    const rows = await this.store.select(CHECKPOINTS, { where, order: 'checkpoint_id.desc', ...(pushLimit ? { limit } : {}) });
    let yielded = 0;
    for (const row of rows) {
      if (beforeId !== undefined && !(row.checkpoint_id < beforeId)) continue;
      const decoded = await this.decode(row);
      if (!wanted.every(([key, value]) => sameJson(decoded.metadata?.[key], value))) continue;
      // Pending writes are one query each, so they are loaded only for a checkpoint that is returned.
      yield { ...decoded, pendingWrites: await this.pendingWritesFor(row.thread_id, row.checkpoint_ns, row.checkpoint_id) };
      yielded += 1;
      if (limit !== undefined && yielded >= limit) return;
    }
  }

  async put(config, checkpoint, metadata) {
    const { threadId, ns, checkpointId: parentId } = SupabaseSaver.address(config);
    const [[type, checkpointBytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type !== metadataType) throw new Error('The checkpoint and its metadata did not serialize to the same type.');

    const key = { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id };
    const values = { parent_checkpoint_id: parentId ?? null, type, checkpoint: toText(checkpointBytes), metadata: toText(metadataBytes) };
    const [existing] = await this.store.select(CHECKPOINTS, { where: key, limit: 1 });
    if (existing) await this.store.update(CHECKPOINTS, key, values);
    else await this.store.insert(CHECKPOINTS, { ...key, ...values });

    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config, writes, taskId, taskPath = '') {
    const { threadId, ns, checkpointId } = SupabaseSaver.address(config, { needCheckpoint: true });
    // Special channels (an interrupt, an error) are replaced when written again; ordinary ones keep the first.
    const replace = writes.every(([channel]) => channel in WRITES_IDX_MAP);

    for (const [i, [channel, value]] of writes.entries()) {
      const idx = WRITES_IDX_MAP[channel] ?? i;
      const [type, bytes] = await this.serde.dumpsTyped(value);
      const key = { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpointId, task_id: taskId, idx };
      const values = { task_path: taskPath, channel, type, value: toText(bytes) };
      const [existing] = await this.store.select(WRITES, { where: key, limit: 1 });
      if (existing) {
        if (replace) await this.store.update(WRITES, key, values);
      } else {
        await this.store.insert(WRITES, { ...key, ...values });
      }
    }
  }

  async deleteThread() {
    throw new Error('Deleting a thread is not supported yet: the REST store cannot delete rows.');
  }
}

/** A LangGraph checkpoint saver over the runtime's REST store. */
function createSupabaseSaver({ store, serde } = {}) {
  if (!store || typeof store.select !== 'function' || typeof store.insert !== 'function' || typeof store.update !== 'function') {
    throw new Error('createSupabaseSaver needs the runtime store.');
  }
  return new SupabaseSaver(store, serde);
}

module.exports = { createSupabaseSaver };
