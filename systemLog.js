// systemLog.js
//
// A plain activity feed for the admin dashboard's "system logs" tab —
// records what a staff member did (created an FAQ, changed a ticket's
// status, added a department...), not a full per-field diff-style audit
// trail. That's a deliberately smaller feature than a compliance-grade
// audit log.

const { query } = require('./db.js');

async function logEvent({ actor, action, detail }) {
  await query(
    'INSERT INTO system_logs (actor, action, detail) VALUES ($1, $2, $3)',
    [actor || 'system', action, detail || null]
  );
}

function rowToEvent(row) {
  return {
    id: Number(row.id),
    actor: row.actor,
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

async function listEvents({ limit = 100 } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await query('SELECT * FROM system_logs ORDER BY created_at DESC LIMIT $1', [cappedLimit]);
  return rows.map(rowToEvent);
}

module.exports = { logEvent, listEvents };
