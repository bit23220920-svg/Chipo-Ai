// tickets.js
//
// Ticket store for the escalation system, backed by MariaDB (see
// schema.sql). Function
// shapes match what server.js already expects.

const crypto = require('crypto');
const { query } = require('./db.js');

const VALID_STATUSES = ['open', 'in_progress', 'resolved'];
const VALID_REASONS = ['low_confidence', 'manual_request'];

// Short, human-readable reference the student can quote later,
// e.g. "TCK-8F3K2A". Not sequential on purpose, so one student can't
// guess another student's ticket number.
function generateReference() {
  return 'TCK-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function rowToTicket(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    question: row.question,
    lastAnswer: row.last_answer,
    confidence: row.confidence === null ? null : Number(row.confidence),
    reason: row.reason,
    departmentId: row.department_id,
    departmentName: row.department_name || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Create a new ticket.
 * @param {object} fields
 * @param {string} [fields.name]
 * @param {string} [fields.email]        - Optional student contact address.
 * @param {string} fields.question       - The question that triggered escalation.
 * @param {string} [fields.answer]       - Chipo's best-effort answer, if any.
 * @param {number} [fields.confidence]   - Top retrieval similarity score (0-1), if known.
 * @param {'low_confidence'|'manual_request'} [fields.reason]
 * @param {string} [fields.departmentId] - Routed department, if known.
 */
async function createTicket({ name, email, question, answer, confidence, reason, departmentId } = {}) {
  if (!question || !question.trim()) throw badRequest('A question is required to open a ticket.');

  const id = generateReference();
  const safeReason = VALID_REASONS.includes(reason) ? reason : 'manual_request';

  await query(
    `INSERT INTO tickets (id, name, email, question, last_answer, confidence, reason, department_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      (name || '').trim() || null,
      (email || '').trim() || null,
      question.trim(),
      answer ? String(answer).trim() : null,
      typeof confidence === 'number' ? confidence : null,
      safeReason,
      departmentId || null,
    ]
  );
  return getTicket(id);
}

/** List tickets, optionally filtered by status, newest first. */
async function listTickets({ status, departmentId, isAdmin = true } = {}) {
  const filters = [];
  const params = [];
  if (status) {
    filters.push(`tickets.status = $${params.push(status)}`);
  }
  if (isAdmin && !departmentId) {
    // Administrators may see every ticket.
  } else if (departmentId) {
    filters.push(`tickets.department_id = $${params.push(departmentId)}`);
  } else {
    filters.push('1 = 0');
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT tickets.*, departments.name AS department_name
     FROM tickets LEFT JOIN departments ON departments.id = tickets.department_id
     ${where} ORDER BY tickets.created_at DESC`,
    params
  );
  return rows.map(rowToTicket);
}

async function getTicket(id, departmentId = null) {
  const departmentFilter = departmentId ? ' AND tickets.department_id = $2' : '';
  const params = departmentId ? [id, departmentId] : [id];
  const { rows } = await query(
    `SELECT tickets.*, departments.name AS department_name
     FROM tickets LEFT JOIN departments ON departments.id = tickets.department_id
     WHERE tickets.id = $1${departmentFilter}`,
    params
  );
  return rows[0] ? rowToTicket(rows[0]) : null;
}

async function updateTicketStatus(id, status, departmentId = null, isAdmin = true) {
  if (!VALID_STATUSES.includes(status)) {
    throw badRequest(`Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  const params = [id, status];
  const departmentFilter = isAdmin
    ? ''
    : departmentId ? ` AND department_id = $${params.push(departmentId)}` : ' AND 1 = 0';
  await query(
    `UPDATE tickets SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1${departmentFilter}`,
    params
  );
  return getTicket(id, departmentId);
}

module.exports = { createTicket, listTickets, getTicket, updateTicketStatus, VALID_STATUSES };
