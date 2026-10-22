// chatlog.js
//
// Persists each question/answer exchange (chat history) and reads it back
// for the admin dashboard's activity view. session_id groups one browser
// session's turns together — a random ID the frontend generates per tab
// (crypto.randomUUID()), not a login identity, since students don't have
// accounts here.

const { query } = require('./db.js');

async function logMessage({ sessionId, question, answer, confidence, needsHuman, source, studentId = null, studentNumber = null }) {
  await query(
    `INSERT INTO chat_messages (session_id, question, answer, confidence, needs_human, source, student_id, student_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      sessionId || 'unknown',
      question,
      answer,
      typeof confidence === 'number' ? confidence : null,
      !!needsHuman,
      source || 'rag',
      studentId,
      studentNumber,
    ]
  );
}

function rowToMessage(row) {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    question: row.question,
    answer: row.answer,
    confidence: row.confidence === null ? null : Number(row.confidence),
    needsHuman: !!row.needs_human,
    source: row.source,
    createdAt: row.created_at,
  };
}

async function listRecentMessages({ limit = 100 } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await query('SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT $1', [cappedLimit]);
  return rows.map(rowToMessage);
}

module.exports = { logMessage, listRecentMessages };
