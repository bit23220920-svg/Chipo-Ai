// db.js
//
// Shared database access. Turso/libSQL is selected when TURSO_DATABASE_URL
// and TURSO_AUTH_TOKEN are configured; otherwise the local MySQL/MariaDB
// settings remain available for XAMPP and Docker Compose.

require('dotenv').config();
const mysql = require('mysql2/promise');
const { createClient } = require('@libsql/client');

const tursoUrl = process.env.TURSO_DATABASE_URL || process.env.TURSO_DB_URL || process.env.turso_db_url;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN || process.env.turso_auth_token;
const hasTursoConfig = Boolean(tursoUrl || tursoAuthToken);
const useTurso = hasTursoConfig;

const mysqlPool = useTurso ? null : mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'chipo',
  waitForConnections: true,
  connectionLimit: 10,
});

let tursoClientPromise;

async function getTursoClient() {
  if (!tursoUrl || !tursoAuthToken) {
    throw new Error('Turso configuration is incomplete. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env.');
  }
  if (!tursoClientPromise) {
    tursoClientPromise = (async () => {
      const client = createClient({ url: tursoUrl, authToken: tursoAuthToken });
      await client.execute('PRAGMA foreign_keys = ON');
      return client;
    })();
  }
  return tursoClientPromise;
}

function normalizeSqliteError(error) {
  if (
    error &&
    typeof error.message === 'string' &&
    /unique constraint failed/i.test(error.message)
  ) {
    const duplicateError = new Error(error.message, { cause: error });
    duplicateError.code = 'ER_DUP_ENTRY';
    throw duplicateError;
  }
  throw error;
}

async function executeTurso(text, params = []) {
  const values = [];
  const sql = text.replace(/\$(\d+)/g, (_, position) => {
    values.push(params[Number(position) - 1]);
    return '?';
  });
  const args = values.map((value) => typeof value === 'boolean' ? Number(value) : value);
  const client = await getTursoClient();
  try {
    return await client.execute({ sql, args });
  } catch (error) {
    normalizeSqliteError(error);
  }
}

async function query(text, params = []) {
  if (useTurso) {
    const result = await executeTurso(text, params);
    return {
      rows: result.rows,
      rowCount: Number(result.rowsAffected || 0),
      insertId: result.lastInsertRowid,
    };
  }
  const values = [];
  const sql = text.replace(/\$(\d+)/g, (_, position) => {
    values.push(params[Number(position) - 1]);
    return '?';
  });
  const [result] = await mysqlPool.execute(sql, values);
  if (Array.isArray(result)) return { rows: result, rowCount: result.length };
  return { rows: [], rowCount: result.affectedRows || 0, insertId: result.insertId };
}

async function executeMultiple(text) {
  if (useTurso) {
    const client = await getTursoClient();
    return client.executeMultiple(text);
  }
  return mysqlPool.query(text);
}

const pool = useTurso
  ? {
      query: async (text, params = []) => {
        const result = await executeTurso(text, params);
        return [result.rows, result];
      },
      end: async () => {
        if (tursoClientPromise) {
          const client = await tursoClientPromise;
          client.close();
          tursoClientPromise = null;
        }
      },
    }
  : mysqlPool;

module.exports = { pool, query, executeMultiple, useTurso };
