// errorlog.js
//
// A persistent record of why Chipo failed to answer, so a "Something went
// wrong" or a quiet fall-back to the local engine can be explained later.
// Each row says WHAT failed (Groq, Gemini, retrieval, the server, ...), the
// error text, and the question being answered at the time.
//
// Recording never throws and never slows an answer down on purpose: a failure
// to log is only printed. API keys and tokens are scrubbed from every message.

const { AsyncLocalStorage } = require('async_hooks');
const { query } = require('./db.js');

const context = new AsyncLocalStorage();

/** Run fn with request details (question, session, route) attached to any error recorded inside it. */
function runWith(details, fn) {
  return context.run({ ...details }, fn);
}

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_\-]{20,}/g,
  /gsk_[0-9A-Za-z_\-]{10,}/g,
  /sk-[0-9A-Za-z_\-]{20,}/g,
  /Bearer\s+[0-9A-Za-z._\-]{10,}/gi,
  /eyJ[0-9A-Za-z_\-]{10,}\.[0-9A-Za-z_\-]{10,}\.[0-9A-Za-z_\-]{10,}/g,
  /([?&](?:key|api_key|token)=)[^&\s]+/gi,
];

function scrub(text) {
  let out = String(text === undefined || text === null ? '' : text);
  // The exact secrets this server is configured with, whatever shape they have.
  for (const name of ['GROQ_API_KEY', 'LLM_API_KEY', 'GEMINI_API_KEY', 'JWT_SECRET', 'TURSO_AUTH_TOKEN', 'SMTP_PASS']) {
    const value = process.env[name];
    if (value && value.length >= 8) out = out.split(value).join('[hidden]');
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? `${prefix}[hidden]` : '[hidden]'));
  }
  return out;
}

function clip(text, max) {
  const value = scrub(text).replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, max) : null;
}

// Stop a failing dependency from filling the table: at most 120 rows a minute.
let windowStart = 0;
let windowCount = 0;
let dropped = 0;
let inserted = 0;

function allowed() {
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; windowCount = 0; }
  windowCount += 1;
  if (windowCount > 120) { dropped += 1; return false; }
  return true;
}

const KEEP_DAYS = 60;

/**
 * @param {object} fields
 * @param {string} fields.component  groq | gemini | retrieval | server | database | tickets | ...
 * @param {string} [fields.kind]     model_failure | fallback | server_error | ...
 * @param {Error|string} [fields.error]
 * @param {string} [fields.detail]   extra plain-language context
 */
async function record({ component, kind = 'error', error, detail, question, sessionId, route, statusCode } = {}) {
  try {
    if (!allowed()) return;
    const ctx = context.getStore() || {};
    const err = error && typeof error === 'object' ? error : null;
    const message = [
      detail,
      err ? `${err.name && err.name !== 'Error' ? err.name + ': ' : ''}${err.message || ''}` : (typeof error === 'string' ? error : ''),
      err && err.code ? `(code ${err.code})` : '',
    ].filter(Boolean).join(' - ');
    await query(
      `INSERT INTO error_logs (kind, component, message, status_code, question, session_id, route)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        String(kind).slice(0, 30),
        String(component || 'unknown').slice(0, 40),
        clip(message, 1000) || 'Unknown error',
        Number.isInteger(statusCode) ? statusCode : (err && Number.isInteger(err.status) ? err.status : null),
        clip(question !== undefined ? question : ctx.question, 500),
        clip(sessionId !== undefined ? sessionId : ctx.sessionId, 64),
        clip(route !== undefined ? route : ctx.route, 120),
      ]
    );
    inserted += 1;
    if (inserted % 200 === 0) {
      const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      await query('DELETE FROM error_logs WHERE created_at < $1', [cutoff]);
    }
  } catch (logErr) {
    // The table may be missing (node migrate.js not run yet) - never let that break an answer.
    console.error('Could not write to the error log:', logErr.message);
  }
}

function rowToEntry(row) {
  return {
    id: Number(row.id),
    kind: row.kind,
    component: row.component,
    message: row.message,
    statusCode: row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
    question: row.question || null,
    sessionId: row.session_id || null,
    route: row.route || null,
    createdAt: row.created_at,
  };
}

async function list({ limit = 100, component } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const params = [];
  const where = component ? `WHERE component = $${params.push(String(component).slice(0, 40))}` : '';
  const { rows } = await query(`SELECT * FROM error_logs ${where} ORDER BY id DESC LIMIT ${cap}`, params);
  return rows.map(rowToEntry);
}

/** Counts per component since a time, for the analytics tile. */
async function countsSince(sinceSql) {
  const { rows } = await query('SELECT component, COUNT(*) AS total FROM error_logs WHERE created_at >= $1 GROUP BY component', [sinceSql]);
  const out = {};
  for (const row of rows) out[row.component] = Number(row.total);
  return out;
}

function droppedCount() { return dropped; }

module.exports = { record, runWith, list, countsSince, scrub, droppedCount };
