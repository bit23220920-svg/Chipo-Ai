// feedback.js
//
// Stored answer feedback (thumbs up / down) and complaints. Both are kept so
// administrators can see how well Chipo is doing and follow up on complaints.

const { query } = require('./db.js');

const KINDS = ['feedback', 'complaint'];
const RATINGS = ['up', 'down'];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function text(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

async function record({ kind = 'feedback', rating, comment, question, answer, sessionId, studentId } = {}) {
  if (!KINDS.includes(kind)) throw badRequest('kind must be feedback or complaint.');
  if (rating !== undefined && rating !== null && !RATINGS.includes(rating)) throw badRequest('rating must be up or down.');
  const cleanComment = text(comment, 2000);
  if (kind === 'complaint' && !cleanComment) throw badRequest('Please describe your complaint.');
  if (kind === 'feedback' && !rating) throw badRequest('A rating (up or down) is required.');

  const result = await query(
    `INSERT INTO feedback (kind, rating, comment, question, answer, session_id, student_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      kind,
      rating || null,
      cleanComment,
      text(question, 4000),
      text(answer, 6000),
      typeof sessionId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(sessionId) ? sessionId : null,
      studentId || null,
    ]
  );
  return { id: Number(result.insertId) };
}

function rowToFeedback(row) {
  return {
    id: Number(row.id),
    kind: row.kind,
    rating: row.rating || null,
    comment: row.comment || null,
    question: row.question || null,
    answer: row.answer || null,
    studentId: row.student_id || null,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function list({ kind, limit = 100 } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const filters = [];
  const params = [];
  if (kind && KINDS.includes(kind)) filters.push(`kind = $${params.push(kind)}`);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await query(`SELECT * FROM feedback ${where} ORDER BY id DESC LIMIT ${cap}`, params);
  return rows.map(rowToFeedback);
}

async function markReviewed(id) {
  const result = await query(`UPDATE feedback SET status = 'reviewed' WHERE id = $1`, [id]);
  return result.rowCount === 1;
}

module.exports = { record, list, markReviewed, KINDS, RATINGS };
