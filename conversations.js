// conversations.js
//
// Chat memory for signed-in students. Each student has conversations; the
// newest one is their "current" chat. The server always works out the
// conversation from the logged-in student - the browser never sends a
// conversation id - so one student cannot reach another student's messages.

const { query, transaction } = require('./db.js');

// How many of the most recent messages go to the model with each question.
const HISTORY_MESSAGE_LIMIT = 15;

function rowToMessage(row) {
  return {
    id: Number(row.id),
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

async function startConversation(studentId) {
  const result = await query('INSERT INTO conversations (student_id) VALUES ($1)', [studentId]);
  return { id: Number(result.insertId) };
}

/** The student's current conversation, created on first use. */
async function getOrCreateCurrent(studentId) {
  const { rows } = await query(
    'SELECT id FROM conversations WHERE student_id = $1 ORDER BY id DESC LIMIT 1',
    [studentId]
  );
  if (rows[0]) return { id: Number(rows[0].id) };
  return startConversation(studentId);
}

/**
 * Start a fresh conversation ("New chat"). If the current one has no messages
 * yet it is reused, so pressing the button twice does not pile up empty chats.
 */
async function startNew(studentId) {
  const current = await getOrCreateCurrent(studentId);
  const { rows } = await query(
    'SELECT COUNT(*) AS total FROM messages WHERE conversation_id = $1',
    [current.id]
  );
  if (Number(rows[0]?.total || 0) === 0) return current;
  return startConversation(studentId);
}

/**
 * The newest `limit` messages of a conversation, oldest first. The join on
 * student_id means a conversation id that is not this student's returns
 * nothing, even if it were somehow guessed.
 */
async function loadRecent(conversationId, studentId, limit = HISTORY_MESSAGE_LIMIT) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || HISTORY_MESSAGE_LIMIT, 1), 200);
  const { rows } = await query(
    `SELECT messages.id, messages.role, messages.content, messages.created_at
     FROM messages JOIN conversations ON conversations.id = messages.conversation_id
     WHERE messages.conversation_id = $1 AND conversations.student_id = $2
     ORDER BY messages.id DESC LIMIT ${cap}`,
    [conversationId, studentId]
  );
  return rows.reverse().map(rowToMessage);
}

/** Save the student's question and the bot's answer together, or not at all. */
async function saveExchange({ conversationId, studentId, question, answer }) {
  await transaction(async (tx) => {
    const owned = await tx.query(
      'SELECT id FROM conversations WHERE id = $1 AND student_id = $2',
      [conversationId, studentId]
    );
    if (!owned.rows[0]) throw new Error('That conversation does not belong to this student.');
    await tx.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [conversationId, 'user', question]
    );
    await tx.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [conversationId, 'assistant', answer]
    );
  });
}

/** Turn a message list into the { summary, messages, turns } shape ask.js reads. */
function toHistory(messages) {
  const plain = messages.map(({ role, content }) => ({ role, content }));
  const turns = [];
  for (let index = 0; index < plain.length; index += 1) {
    if (plain[index].role === 'user' && plain[index + 1]?.role === 'assistant') {
      turns.push({ question: plain[index].content, answer: plain[index + 1].content });
    }
  }
  return { summary: '', messages: plain, turns };
}

module.exports = {
  HISTORY_MESSAGE_LIMIT,
  getOrCreateCurrent,
  startNew,
  loadRecent,
  saveExchange,
  toHistory,
};
