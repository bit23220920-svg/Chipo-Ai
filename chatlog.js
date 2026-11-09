// chatlog.js
//
// Persists each question/answer exchange (chat history) and reads it back
// for the admin dashboard's activity view. session_id groups one browser
// session's turns together — a random ID the frontend generates per tab
// (crypto.randomUUID()), not a login identity, since students don't have
// accounts here.

const { query } = require('./db.js');

const MAX_RECENT_MESSAGES = 12;

async function loadConversationHistory(sessionId, summarizeOlderMessages) {
  let state = { summary: '', summarized_through_id: 0 };
  let summaryStorageAvailable = true;
  try {
    const conversation = await query(
      'SELECT summary, summarized_through_id FROM chat_conversations WHERE session_id = $1',
      [sessionId]
    );
    if (conversation.rows[0]) {
      state = conversation.rows[0];
    } else {
      try {
        await query(
          'INSERT INTO chat_conversations (session_id, summary) VALUES ($1, $2)',
          [sessionId, '']
        );
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY' && !/unique constraint failed/i.test(err.message || '')) throw err;
      }
    }
  } catch (err) {
    if (!/no such table: chat_conversations|doesn.t exist.*chat_conversations|ER_NO_SUCH_TABLE/i.test(err.message || err.code || '')) {
      throw err;
    }
    summaryStorageAvailable = false;
    console.warn('Conversation summary table is missing; run node migrate.js to enable long-term summaries.');
  }

  const recentResult = await query(
    `SELECT id, question, answer FROM chat_messages
     WHERE session_id = $1 ORDER BY id DESC LIMIT $2`,
    [sessionId, MAX_RECENT_MESSAGES / 2]
  );
  const recentTurns = recentResult.rows.reverse();
  const messages = recentTurns.flatMap((row) => [
    { id: Number(row.id), role: 'user', content: row.question },
    { id: Number(row.id), role: 'assistant', content: row.answer },
  ]);

  if (summaryStorageAvailable && recentTurns.length === MAX_RECENT_MESSAGES / 2) {
    const oldestRecentId = Number(recentTurns[0].id);
    const olderResult = await query(
      `SELECT id, question, answer FROM chat_messages
       WHERE session_id = $1 AND id > $2 AND id < $3 ORDER BY id ASC`,
      [sessionId, Number(state.summarized_through_id || 0), oldestRecentId]
    );
    if (olderResult.rows.length) {
      const olderMessages = olderResult.rows.flatMap((row) => [
        { role: 'user', content: row.question },
        { role: 'assistant', content: row.answer },
      ]);
      // A summary is a convenience. If no model can write one right now, the
      // question is still answered, from the recent messages alone; the
      // older ones are picked up the next time a model is available.
      try {
        const summary = await summarizeOlderMessages(state.summary || '', olderMessages);
        const lastSummarizedId = Number(olderResult.rows[olderResult.rows.length - 1].id);
        await query(
          `UPDATE chat_conversations SET summary = $1, summarized_through_id = $2
           WHERE session_id = $3`,
          [summary, lastSummarizedId, sessionId]
        );
        state.summary = summary;
      } catch (err) {
        console.warn('Could not summarise the earlier messages, continuing without a new summary:', err.message);
      }
    }
  }

  const turns = recentTurns.map((row) => ({ question: row.question, answer: row.answer }));

  return { summary: state.summary || '', messages, turns };
}

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

module.exports = {
  logMessage,
  listRecentMessages,
  loadConversationHistory,
  MAX_RECENT_MESSAGES,
};
