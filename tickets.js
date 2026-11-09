// tickets.js
//
// Ticket store for the escalation system, backed by MariaDB (see
// schema.sql). Function
// shapes match what server.js already expects.

const crypto = require('crypto');
const { query, transaction } = require('./db.js');
const { detectPriority, normalizePriority, PRIORITY_RANK, PRIORITIES, PRIORITY_LABELS } = require('./priority.js');

// A ticket only ever moves forward through these, in this order.
const VALID_STATUSES = ['opened', 'in_progress', 'resolved'];
const STATUS_LABELS = { opened: 'Opened', in_progress: 'In Progress', resolved: 'Resolved' };

// Older rows (and older browser tabs) say "open"; it means "opened".
function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return status === 'open' ? 'opened' : status;
}

function statusLabel(status) {
  return STATUS_LABELS[normalizeStatus(status)] || String(status);
}

// Forward only: opened -> in_progress -> resolved. Skipping ahead (opened ->
// resolved) is still a forward move; going back or repeating a status is not.
function isForwardMove(from, to) {
  return VALID_STATUSES.indexOf(normalizeStatus(to)) > VALID_STATUSES.indexOf(normalizeStatus(from));
}
const VALID_REASONS = ['low_confidence', 'manual_request', 'wellbeing'];

// How many earlier messages travel with a ticket, and how long each may be.
const HISTORY_LIMIT = 20;
const HISTORY_MESSAGE_CHARS = 1500;

/** Keep only well-formed {role, content} messages, trimmed. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-HISTORY_LIMIT)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, HISTORY_MESSAGE_CHARS) }));
}

function parseHistory(value) {
  if (!value) return [];
  try { return cleanHistory(JSON.parse(value)); } catch (err) { return []; }
}

// Short, human-readable reference the student can quote later,
// e.g. "TCK-0123456789ABCDEF". Not sequential on purpose, so one student can't
// guess another student's ticket number.
function generateReference() {
  return 'TCK-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function rowToTicket(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    question: row.question,
    conversationSummary: row.conversation_summary || null,
    lastAnswer: row.last_answer,
    confidence: row.confidence === null ? null : Number(row.confidence),
    reason: row.reason,
    departmentId: row.department_id,
    departmentName: row.department_name || null,
    studentId: row.student_id || null,
    subject: row.subject || null,
    priority: normalizePriority(row.priority) || 'medium',
    priorityLabel: PRIORITY_LABELS[normalizePriority(row.priority) || 'medium'],
    conversationHistory: parseHistory(row.conversation_history),
    status: normalizeStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function normalizeContact({ name, email, phone } = {}) {
  const safeName = typeof name === 'string' ? name.trim() : '';
  const safeEmail = typeof email === 'string' ? email.trim() : '';
  const safePhone = typeof phone === 'string' ? phone.trim() : '';
  if (safeName.length > 255) throw badRequest('Name must be 255 characters or fewer.');
  if (!safeEmail && !safePhone) throw badRequest('Provide an email address or phone number.');
  if (safeEmail.length > 255) throw badRequest('Email must be 255 characters or fewer.');
  if (safeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
    throw badRequest('Enter a valid email address.');
  }
  if (safePhone && (!/^[+()\d\s.-]{7,40}$/.test(safePhone) || safePhone.replace(/\D/g, '').length < 7)) {
    throw badRequest('Enter a valid phone number.');
  }
  return { name: safeName || null, email: safeEmail || null, phone: safePhone || null };
}

/**
 * Create a new ticket.
 * @param {object} fields
 * @param {string} [fields.name]
 * @param {string} [fields.email]        - Student contact address; email or phone is required.
 * @param {string} [fields.phone]        - Student contact number; email or phone is required.
 * @param {string} fields.question       - The question that triggered escalation.
 * @param {string} [fields.answer]       - Chipo's best-effort answer, if any.
 * @param {number} [fields.confidence]   - Top retrieval similarity score (0-1), if known.
 * @param {'low_confidence'|'manual_request'|'wellbeing'} [fields.reason]
 * @param {string} [fields.departmentId] - Routed department, if known.
 */
async function createTicket({ name, email, phone, question, answer, confidence, reason, departmentId, conversationSummary, studentId, subject, priority, conversationHistory } = {}) {
  if (!question || !question.trim()) throw badRequest('A question is required to open a ticket.');
  if (question.trim().length > 10000) throw badRequest('Question must be 10,000 characters or fewer.');
  if (conversationSummary !== undefined && conversationSummary !== null && typeof conversationSummary !== 'string') {
    throw badRequest('Conversation summary must be text.');
  }
  if (typeof conversationSummary === 'string' && conversationSummary.length > 6000) {
    throw badRequest('Conversation summary must be 6,000 characters or fewer.');
  }
  const contact = normalizeContact({ name, email, phone });

  const id = generateReference();
  const safeReason = VALID_REASONS.includes(reason) ? reason : 'manual_request';

  // One line that says what the ticket is about, for lists and notifications.
  const safeSubject = (typeof subject === 'string' && subject.trim() ? subject : question)
    .replace(/\s+/g, ' ').trim().slice(0, 120);

  const safePriority = normalizePriority(priority)
    || detectPriority({ question, reason: safeReason, conversationSummary });
  const history = cleanHistory(conversationHistory);

  await query(
    `INSERT INTO tickets (id, name, email, phone, question, conversation_summary, last_answer, confidence, reason, department_id, student_id, subject, priority, conversation_history, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      contact.name,
      contact.email,
      contact.phone,
      question.trim(),
      typeof conversationSummary === 'string' ? conversationSummary.trim() || null : null,
      answer ? String(answer).trim() : null,
      typeof confidence === 'number' ? confidence : null,
      safeReason,
      departmentId || null,
      studentId || null,
      safeSubject,
      safePriority,
      history.length ? JSON.stringify(history) : null,
      'opened',
    ]
  );
  return getTicket(id);
}

/**
 * A student who sends the same question to the same office while an earlier
 * ticket for it is still open gets that ticket back, not a second one.
 */
async function findOpenDuplicate({ studentId, departmentId, question }) {
  if (!studentId || !departmentId || typeof question !== 'string' || !question.trim()) return null;
  const { rows } = await query(
    `SELECT id FROM tickets
     WHERE student_id = $1 AND department_id = $2 AND status <> 'resolved'
       AND LOWER(TRIM(question)) = LOWER(TRIM($3))
     LIMIT 1`,
    [studentId, departmentId, question]
  );
  return rows[0] ? getTicket(rows[0].id) : null;
}

async function assignUnassignedTickets(departmentId) {
  if (!departmentId) return;
  await query(
    `UPDATE tickets SET department_id = $1, updated_at = CURRENT_TIMESTAMP WHERE department_id IS NULL`,
    [departmentId]
  );
}

/** List tickets, optionally filtered by status, newest first. */
async function listTickets({ status, departmentId, isAdmin = true } = {}) {
  const filters = [];
  const params = [];
  if (status) {
    // Rows written before the rename may still say "open".
    const wanted = normalizeStatus(status);
    if (wanted === 'opened') {
      filters.push(`tickets.status IN ($${params.push('opened')}, $${params.push('open')})`);
    } else {
      filters.push(`tickets.status = $${params.push(wanted)}`);
    }
  } else {
    filters.push(`tickets.status <> 'resolved'`);
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
  const list = rows.map(rowToTicket);
  // Most urgent first; within a priority the newest stays on top (the query
  // already returned newest first and Array.sort is stable).
  return list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
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

function conflict(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

const TICKET_SELECT = `SELECT tickets.*, departments.name AS department_name
     FROM tickets LEFT JOIN departments ON departments.id = tickets.department_id`;

/**
 * Move a ticket to its next status.
 *
 * In ONE transaction this updates the ticket, writes a ticket_events row and,
 * when the ticket belongs to a student, writes that student's notification.
 * If any of the three fails, none of them are saved.
 *
 * @param {object} fields
 * @param {string} fields.ticketId
 * @param {string} fields.status  - 'in_progress' or 'resolved' ('opened' only
 *                                  ever happens when the ticket is created).
 * @param {string} [fields.note]  - Optional note stored on the event.
 * @param {{id: string, departmentId: string|null, isAdmin: boolean}} fields.staff
 *        The staff member making the change (read fresh from the database).
 * @returns {Promise<object|null>} the updated ticket, or null when there is no
 *          such ticket *for this staff member* - staff of another department get
 *          the same answer as for a ticket that does not exist.
 */
async function changeStatus({ ticketId, status, note, staff } = {}) {
  const next = normalizeStatus(status);
  if (!VALID_STATUSES.includes(next)) {
    throw badRequest(`Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  if (cleanNote.length > 1000) throw badRequest('A note must be 1,000 characters or fewer.');
  if (!staff || !staff.id) throw badRequest('A staff member is required to change a ticket.');

  return transaction(async (tx) => {
    const { rows } = await tx.query(`${TICKET_SELECT} WHERE tickets.id = $1`, [ticketId]);
    const row = rows[0];
    const mayAct = row && (staff.isAdmin || (staff.departmentId && row.department_id === staff.departmentId));
    if (!mayAct) return null;

    const current = normalizeStatus(row.status);
    if (!isForwardMove(current, next)) {
      throw conflict(
        current === next
          ? `This ticket is already ${statusLabel(current)}.`
          : `A ticket can only move forward (Opened, then In Progress, then Resolved). This one is already ${statusLabel(current)}, so it cannot go back to ${statusLabel(next)}.`
      );
    }

    // Compare-and-swap on the status we just read, so two staff members acting
    // at the same moment cannot both "win".
    const updated = await tx.query(
      `UPDATE tickets SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status = $3`,
      [next, ticketId, row.status]
    );
    if (updated.rowCount !== 1) {
      throw conflict('Someone else just changed this ticket. Refresh the list and try again.');
    }

    await tx.query(
      `INSERT INTO ticket_events (ticket_id, status, note, staff_id) VALUES ($1, $2, $3, $4)`,
      [ticketId, next, cleanNote || null, staff.id]
    );

    if (row.student_id) {
      const office = row.department_name ? `${row.department_name} ticket` : 'ticket';
      await tx.query(
        `INSERT INTO notifications (student_id, ticket_id, message) VALUES ($1, $2, $3)`,
        [row.student_id, ticketId, `Your ${office} ${ticketId} is now ${statusLabel(next)}.`]
      );
    }

    const fresh = await tx.query(`${TICKET_SELECT} WHERE tickets.id = $1`, [ticketId]);
    return rowToTicket(fresh.rows[0]);
  });
}

/**
 * Staff change a ticket's priority. Recorded as a ticket event (with the same
 * status) so the history shows who changed it and why.
 */
async function changePriority({ ticketId, priority, note, staff } = {}) {
  const next = normalizePriority(priority);
  if (!next) throw badRequest(`Invalid priority "${priority}". Must be one of: ${PRIORITIES.join(', ')}`);
  if (!staff || !staff.id) throw badRequest('A staff member is required to change a ticket.');
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  if (cleanNote.length > 1000) throw badRequest('A note must be 1,000 characters or fewer.');

  return transaction(async (tx) => {
    const { rows } = await tx.query(`${TICKET_SELECT} WHERE tickets.id = $1`, [ticketId]);
    const row = rows[0];
    const mayAct = row && (staff.isAdmin || (staff.departmentId && row.department_id === staff.departmentId));
    if (!mayAct) return null;
    if (normalizePriority(row.priority) === next) return rowToTicket(row);
    await tx.query(`UPDATE tickets SET priority = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [next, ticketId]);
    await tx.query(
      `INSERT INTO ticket_events (ticket_id, status, note, staff_id) VALUES ($1, $2, $3, $4)`,
      [ticketId, normalizeStatus(row.status), `Priority set to ${PRIORITY_LABELS[next]}.${cleanNote ? ' ' + cleanNote : ''}`, staff.id]
    );
    const fresh = await tx.query(`${TICKET_SELECT} WHERE tickets.id = $1`, [ticketId]);
    return rowToTicket(fresh.rows[0]);
  });
}

/** The tickets that belong to one student, newest first. Never anyone else's. */
async function listStudentTickets(studentId, { limit = 50 } = {}) {
  if (!studentId) return [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const { rows } = await query(
    `${TICKET_SELECT} WHERE tickets.student_id = $1 ORDER BY tickets.created_at DESC, tickets.id DESC LIMIT ${cap}`,
    [studentId]
  );
  return rows.map(rowToTicket);
}

/** One ticket by reference, but only if it belongs to this student. */
async function getStudentTicket(studentId, id) {
  if (!studentId || !id) return null;
  const { rows } = await query(
    `${TICKET_SELECT} WHERE tickets.id = $1 AND tickets.student_id = $2`,
    [id, studentId]
  );
  return rows[0] ? rowToTicket(rows[0]) : null;
}

/** The history of a ticket's status changes, oldest first. */
async function listTicketEvents(ticketId) {
  const { rows } = await query(
    `SELECT ticket_events.*, staff_users.username AS staff_username
     FROM ticket_events LEFT JOIN staff_users ON staff_users.id = ticket_events.staff_id
     WHERE ticket_events.ticket_id = $1 ORDER BY ticket_events.id ASC`,
    [ticketId]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    ticketId: row.ticket_id,
    status: normalizeStatus(row.status),
    note: row.note || null,
    staffId: row.staff_id || null,
    staffUsername: row.staff_username || null,
    createdAt: row.created_at,
  }));
}

module.exports = {
  createTicket,
  findOpenDuplicate,
  assignUnassignedTickets,
  listTickets,
  getTicket,
  changeStatus,
  changePriority,
  cleanHistory,
  listStudentTickets,
  getStudentTicket,
  listTicketEvents,
  normalizeStatus,
  statusLabel,
  isForwardMove,
  VALID_STATUSES,
  STATUS_LABELS,
};
