'use strict';

// The runtime's database client: Supabase's REST API (PostgREST) with the service key.
// It only needs three operations, so it is a thin wrapper over fetch rather than a
// full client library. Table and column names are checked against a strict pattern so
// they can never reshape a request; values are always URL-encoded.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ORDER = /^[a-z_][a-z0-9_]*(\.(asc|desc))?$/;

/** An error with a short, safe `code` (never a message that could contain a secret). */
class StoreError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

function identifier(name, what) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) throw new StoreError('rejected', `invalid ${what}`);
  return name;
}

function filters(where) {
  return Object.entries(where).map(([col, value]) => {
    identifier(col, 'column name');
    if (value === null) return `${col}=is.null`;
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new StoreError('rejected', 'invalid filter value');
    return `${col}=eq.${encodeURIComponent(String(value))}`;
  });
}

function createRestStore({ url, serviceKey, fetchImpl = fetch, timeoutMs = 8000 }) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;

  async function request(method, table, query, body) {
    identifier(table, 'table name');
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    let res;
    try {
      res = await fetchImpl(`${base}/${table}${query ? `?${query}` : ''}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new StoreError('unreachable', 'Could not reach the database.');
    }
    if (res.status === 401 || res.status === 403) throw new StoreError('unauthorized', 'The database rejected the key.', res.status);
    if (res.status === 404) throw new StoreError('missing_table', 'The table was not found. Have the migrations been applied?', 404);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = '';
      try {
        detail = String(JSON.parse(text).message ?? '').slice(0, 300);
      } catch {
        // not JSON: keep the generic message
      }
      throw new StoreError(res.status >= 500 ? 'error' : 'rejected', detail || `The database answered ${res.status}.`, res.status);
    }
    return text ? JSON.parse(text) : [];
  }

  return {
    /** Insert one row; resolves to the stored row. */
    async insert(table, row) {
      const rows = await request('POST', table, '', row);
      return rows[0];
    },

    /** Read rows: `where` is a set of equalities, `order` looks like "created_at.asc". */
    async select(table, { where = {}, order, limit } = {}) {
      const parts = ['select=*', ...filters(where)];
      if (order !== undefined) {
        if (!ORDER.test(order)) throw new StoreError('rejected', 'invalid order');
        parts.push(`order=${order}`);
      }
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 1) throw new StoreError('rejected', 'invalid limit');
        parts.push(`limit=${limit}`);
      }
      return request('GET', table, parts.join('&'));
    },

    /** Update rows matching `where` (which must not be empty); resolves to the changed rows. */
    async update(table, where, patch) {
      if (!where || Object.keys(where).length === 0) throw new StoreError('rejected', 'an update needs a filter');
      return request('PATCH', table, filters(where).join('&'), patch);
    },
  };
}

module.exports = { createRestStore, StoreError };
