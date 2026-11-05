// notifications.js
//
// In-portal notifications for students. A notification is written by
// tickets.changeStatus() in the same transaction as the status change; this
// module only reads them and marks them read.
//
// Every function takes the student id first and puts it in the WHERE clause,
// so a student can only ever see or touch their own notifications. The id
// always comes from the verified login session, never from the request.

const { query } = require('./db.js');

function rowToNotification(row) {
  return {
    id: Number(row.id),
    ticketId: row.ticket_id,
    message: row.message,
    isRead: !!row.is_read,
    createdAt: row.created_at,
  };
}

async function unreadCount(studentId) {
  const { rows } = await query(
    'SELECT COUNT(*) AS total FROM notifications WHERE student_id = $1 AND is_read = $2',
    [studentId, false]
  );
  return Number(rows[0]?.total || 0);
}

/** The student's newest notifications plus how many are still unread. */
async function listForStudent(studentId, { limit = 30 } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const { rows } = await query(
    `SELECT * FROM notifications WHERE student_id = $1 ORDER BY id DESC LIMIT ${cap}`,
    [studentId]
  );
  return {
    notifications: rows.map(rowToNotification),
    unreadCount: await unreadCount(studentId),
  };
}

/** Mark everything this student has as read. Returns how many changed. */
async function markAllRead(studentId) {
  const result = await query(
    'UPDATE notifications SET is_read = $1 WHERE student_id = $2 AND is_read = $3',
    [true, studentId, false]
  );
  return result.rowCount;
}

/** Mark some of this student's notifications as read. Other ids are ignored. */
async function markRead(studentId, ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);
  if (!clean.length) return 0;
  const params = [true, studentId, false];
  const marks = clean.map((id) => `$${params.push(id)}`).join(', ');
  const result = await query(
    `UPDATE notifications SET is_read = $1 WHERE student_id = $2 AND is_read = $3 AND id IN (${marks})`,
    params
  );
  return result.rowCount;
}

module.exports = { listForStudent, unreadCount, markAllRead, markRead };
