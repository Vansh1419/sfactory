#!/usr/bin/env node
'use strict';

// A stand-in for Supabase's REST API, for local development and tests: a real
// Postgres (PGlite) with supabase/migrations applied, behind the few PostgREST
// endpoints the runtime uses:
//
//   GET    /rest/v1/<table>?select=*&<col>=eq.<value>&order=<col>.asc&limit=<n>
//   POST   /rest/v1/<table>              (JSON object body)
//   PATCH  /rest/v1/<table>?<col>=eq.<v> (JSON object body)
//
// It checks the service key, listens on 127.0.0.1 only, and keeps everything in memory.
//
//   node scripts/fake-supabase.js            prints the two settings to use, then serves until you stop it
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run dev

const http = require('node:http');
const { build } = require('../.claude/evals/db');

const TABLE_PATH = /^\/rest\/v1\/([a-z_][a-z0-9_]*)$/;
const toJson = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));

async function startFakeSupabase({ serviceKey = `sb_secret_fake_${'x'.repeat(24)}`, port = 0 } = {}) {
  const db = await build();
  const columns = new Map(); // table -> Map(column -> data_type)
  const info = await db.query("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'");
  for (const r of info.rows) {
    if (!columns.has(r.table_name)) columns.set(r.table_name, new Map());
    columns.get(r.table_name).set(r.column_name, r.data_type);
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : toJson(body));
  };

  /** Value for a column: jsonb columns take JSON text. */
  const param = (type, value) => (type === 'jsonb' ? JSON.stringify(value) : value);

  function where(table, searchParams, values) {
    const cols = columns.get(table);
    const clauses = [];
    for (const [key, raw] of searchParams) {
      if (['select', 'order', 'limit'].includes(key)) continue;
      if (!cols.has(key)) throw Object.assign(new Error(`column ${key} does not exist`), { status: 400 });
      if (raw === 'is.null') clauses.push(`"${key}" is null`);
      else if (raw.startsWith('eq.')) {
        values.push(raw.slice(3));
        clauses.push(`"${key}" = $${values.length}`);
      } else throw Object.assign(new Error(`unsupported filter on ${key}`), { status: 400 });
    }
    return clauses.length ? ` where ${clauses.join(' and ')}` : '';
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.apikey !== serviceKey || req.headers.authorization !== `Bearer ${serviceKey}`) {
      return send(res, 401, { message: 'Invalid API key' });
    }
    const match = TABLE_PATH.exec(url.pathname);
    if (!match) return send(res, 404, { message: 'not found' });
    const table = match[1];
    if (!columns.has(table)) {
      return send(res, 404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
    }
    const cols = columns.get(table);

    let body;
    if (req.method === 'POST' || req.method === 'PATCH') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      for (const k of Object.keys(body)) {
        if (!cols.has(k)) return send(res, 400, { message: `column ${k} does not exist` });
      }
    }

    const values = [];
    let sql;
    if (req.method === 'GET') {
      sql = `select * from public.${table}${where(table, url.searchParams, values)}`;
      const order = url.searchParams.get('order');
      if (order) {
        const [col, dir = 'asc'] = order.split('.');
        if (!cols.has(col) || !['asc', 'desc'].includes(dir)) return send(res, 400, { message: 'invalid order' });
        sql += ` order by "${col}" ${dir}`;
      }
      const limit = url.searchParams.get('limit');
      if (limit) sql += ` limit ${Number.parseInt(limit, 10)}`;
    } else if (req.method === 'POST') {
      const keys = Object.keys(body);
      keys.forEach((k) => values.push(param(cols.get(k), body[k])));
      sql = keys.length
        ? `insert into public.${table} (${keys.map((k) => `"${k}"`).join(', ')}) values (${keys.map((_k, i) => `$${i + 1}`).join(', ')}) returning *`
        : `insert into public.${table} default values returning *`;
    } else if (req.method === 'PATCH') {
      const keys = Object.keys(body);
      keys.forEach((k) => values.push(param(cols.get(k), body[k])));
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const filter = where(table, url.searchParams, values);
      if (!filter) return send(res, 400, { message: 'an update needs a filter' });
      sql = `update public.${table} set ${sets}${filter} returning *`;
    } else {
      return send(res, 405, { message: 'method not allowed' });
    }

    const result = await db.query(sql, values);
    return send(res, req.method === 'POST' ? 201 : 200, result.rows);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, err.status ?? 400, { code: err.code, message: err.message }));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    serviceKey,
    db, // the same database, for tests that want to look at the rows
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startFakeSupabase };

if (require.main === module) {
  const portArg = process.argv.indexOf('--port');
  startFakeSupabase({ port: portArg > -1 ? Number(process.argv[portArg + 1]) : 0 }).then((fake) => {
    console.log('Fake Supabase is running. In another terminal:\n');
    console.log(`  SUPABASE_URL=${fake.url} SUPABASE_SERVICE_ROLE_KEY=${fake.serviceKey} npm run dev\n`);
    console.log('It is a Postgres in memory with your migrations applied. Stop it with Ctrl+C; everything is lost.');
  });
}
