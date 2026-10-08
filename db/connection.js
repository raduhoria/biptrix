import { mkdirSync } from 'node:fs';
import path from 'node:path';

// One data-access interface over two engines (spec §3, §11):
//   get(sql, params) → row | undefined     all(sql, params) → rows
//   run(sql, params) → { changes }         batch([[sql, params], ...]) → atomic
//   exec(sql)  (DDL only)
// Parameters are positional (`?`) arrays so the same SQL runs on both.
// There are no multi-request transactions: anything that must be atomic is
// one batch() — a local transaction on SQLite, one `?transaction` request on
// rqlite. Callers never hold a BEGIN open across awaits.
export async function createDb(config) {
  return config.driver === 'rqlite' ? createRqliteDb(config) : createSqliteDb(config);
}

async function createSqliteDb({ sqlitePath }) {
  const { DatabaseSync } = await import('node:sqlite');
  if (sqlitePath !== ':memory:') mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  const raw = new DatabaseSync(sqlitePath);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  // Prepared statements are reused: the hot paths (message send, event
  // fan-out) run the same handful of statements thousands of times.
  const cache = new Map();
  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  }

  // node:sqlite is synchronous and this is the only connection, so writes
  // are serialized by construction ("conexiune de scriere controlată").
  function batchSync(statements) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map(([sql, params = []]) => stmt(sql).run(...params));
      raw.exec('COMMIT');
      return out.map((r) => ({ changes: Number(r.changes) }));
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    driver: 'sqlite',
    get: async (sql, params = []) => stmt(sql).get(...params),
    all: async (sql, params = []) => stmt(sql).all(...params),
    run: async (sql, params = []) => ({ changes: Number(stmt(sql).run(...params).changes) }),
    batch: async (statements) => batchSync(statements),
    exec: async (sql) => raw.exec(sql),
    // Consistent online copy for backups (VACUUM INTO writes a fresh file).
    backup: async (target) => raw.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`),
    // WAL checkpoint, run by the maintenance timer so the -wal file stays small.
    checkpoint: async () => raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
    close: async () => raw.close(),
  };
}

// rqlite over its HTTP API. Writes go to /db/execute?transaction (the leader
// applies them through Raft; success means a quorum committed them), reads to
// /db/query with the declared consistency level. Nodes are tried in turn;
// rqlite redirects writes to the leader itself.
function createRqliteDb({ rqliteUrls, rqliteUser, rqlitePassword, readConsistency }) {
  if (!rqliteUrls.length) throw new Error('DB_DRIVER=rqlite requires RQLITE_URL');
  const headers = { 'Content-Type': 'application/json' };
  if (rqliteUser) headers.Authorization = `Basic ${Buffer.from(`${rqliteUser}:${rqlitePassword}`).toString('base64')}`;
  const TIMEOUT_MS = 10_000;
  const RETRIES = 3;
  let preferred = 0;

  // Reads can always be retried. A write is retried only when it certainly
  // was not applied (connection refused, no leader): after a timeout or a
  // reset the batch may have committed with the answer lost, and running it
  // again would apply it twice (a counter incremented twice, a second row).
  // That outcome is reported as db_unavailable instead.
  const reason = (err) => `${err.message} ${err.cause?.code || ''}`;
  const retryable = (err) => /leader not found|not leader|no leader|ECONNREFUSED|ECONNRESET|fetch failed|timeout|aborted/i.test(reason(err));
  const notApplied = (err) => /leader not found|not leader|no leader|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(reason(err));

  async function call(urlPath, body, { write = false } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      for (let i = 0; i < rqliteUrls.length; i++) {
        const index = (preferred + i) % rqliteUrls.length;
        try {
          const res = await fetch(`${rqliteUrls[index]}${urlPath}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`rqlite ${res.status}: ${text.slice(0, 300)}`);
          const parsed = text ? JSON.parse(text) : {};
          if (parsed.error) throw new Error(parsed.error);
          preferred = index;
          return parsed;
        } catch (err) {
          lastError = err;
          if (write ? !notApplied(err) : !retryable(err)) {
            if (write && retryable(err)) throw Object.assign(new Error(`rqlite write outcome unknown: ${err.message}`), { code: 'db_unavailable' });
            throw err;
          }
        }
      }
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
    // Quorum loss is reported, never masked (acceptance criterion 22).
    throw Object.assign(new Error(`rqlite unavailable: ${lastError?.message}`), { code: 'db_unavailable' });
  }

  function rows(result) {
    if (!result) return [];
    if (result.error) throw new Error(result.error);
    const cols = result.columns || [];
    return (result.values || []).map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
  }

  const query = (sql, params) => call(`/db/query?level=${readConsistency}`, [[sql, ...params]]).then((r) => rows(r.results?.[0]));

  async function batch(statements) {
    if (!statements.length) return [];
    const r = await call('/db/execute?transaction', statements.map(([sql, params = []]) => [sql, ...params]), { write: true });
    return (r.results || []).map((x) => {
      if (x.error) throw new Error(x.error);
      return { changes: Number(x.rows_affected || 0) };
    });
  }

  return {
    driver: 'rqlite',
    get: async (sql, params = []) => (await query(sql, params))[0],
    all: async (sql, params = []) => query(sql, params),
    run: async (sql, params = []) => (await batch([[sql, params]]))[0],
    batch,
    // DDL: split on statement ends, keep trigger bodies (BEGIN … END;) whole.
    exec: async (sql) => batch(splitStatements(sql).map((s) => [s, []])),
    backup: async () => {
      throw new Error('Use `rqlite /db/backup` (or rqlite\'s automatic backups) for rqlite deployments');
    },
    checkpoint: async () => {},
    close: async () => {},
  };
}

export function splitStatements(sql) {
  const out = [];
  let current = '';
  let inTrigger = false;
  for (const line of sql.split('\n')) {
    const trimmed = line.replace(/--.*$/, '').trim();
    if (!trimmed) continue;
    current += `${line}\n`;
    if (/^CREATE\s+TRIGGER/i.test(trimmed)) inTrigger = true;
    if (inTrigger ? /^END;$/i.test(trimmed) : trimmed.endsWith(';')) {
      out.push(current.trim().replace(/;$/, ''));
      current = '';
      inTrigger = false;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
