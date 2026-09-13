/**
 * node-postgres driver, behind the same surface as the PGlite one.
 *
 * This is the only file that knows a pool exists. `src/db.js` chooses between the
 * two, so swapping a development PGlite for a real Postgres server — or the
 * reverse — touches nothing else.
 *
 * The important difference from PGlite is that a pool hands out a DIFFERENT
 * connection per query. Sending `BEGIN` through the pool and then a statement
 * through the pool again can land on two connections, which means the statement
 * runs outside the transaction and the rollback does nothing. So `transaction()`
 * pins one client for the whole callback, and everything inside goes to that
 * client. This is why the db surface has a `transaction` method rather than a
 * generic `withTransaction(db, fn)` helper that issues raw BEGIN/COMMIT.
 */

/** Wrap one connection so callbacks see the same tiny surface as the db. */
function scoped(client) {
  return {
    __scoped: true,
    query: async (text, params) => {
      const res = await client.query(text, params);
      return { rows: res.rows ?? [], rowCount: res.rowCount ?? null };
    },
    // No parameters => simple query protocol => multiple statements allowed.
    exec: async (sql) => { await client.query(sql); }
  };
}

/**
 * @param {object} options
 * @param {string} [options.connectionString]  used only when no pool is injected
 * @param {object} [options.pool]              an existing pg.Pool (or a test double)
 * @param {number} [options.max]               pool size when we create one
 */
export async function createPgDb({ connectionString = null, pool = null, max = 10 } = {}) {
  let activePool = pool;

  if (!activePool) {
    if (!connectionString) {
      throw new Error('createPgDb needs a connectionString or an existing pool');
    }
    const { Pool } = await import('pg');   // only required on this path
    activePool = new Pool({ connectionString, max });
  }

  return {
    driver: 'pg',

    async query(text, params) {
      const res = await activePool.query(text, params);
      return { rows: res.rows ?? [], rowCount: res.rowCount ?? null };
    },

    async exec(sql) {
      await activePool.query(sql);
    },

    /** One pinned connection for the whole callback, so BEGIN/COMMIT are real. */
    async transaction(fn) {
      const client = await activePool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(scoped(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      await activePool.end();
    }
  };
}
