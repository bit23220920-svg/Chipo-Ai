// faqs.js
//
// FAQ CRUD, backed by MariaDB. Each FAQ's question+answer is embedded
// once (cached via a content hash, same idea as the PDF embeddings cache)
// so editing an FAQ only re-embeds when the text actually changed.
//
// getActiveFaqChunks() is what ask.js calls to fold staff-curated FAQs
// into retrieval alongside the PDF-derived chunks — so writing an FAQ
// through the admin dashboard actually changes what Chipo says, not just
// a table nobody reads.

const crypto = require('crypto');
const { query } = require('./db.js');
const { embedText } = require('./embeddings.js');

function fingerprint(question, answer) {
  return crypto.createHash('sha256').update(`${question}\n${answer}`).digest('hex');
}

function rowToFaq(row) {
  let embedding = row.embedding;
  if (typeof embedding === 'string') {
    try { embedding = JSON.parse(embedding); } catch { embedding = null; }
  }
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    departmentId: row.department_id,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listFaqs({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? `SELECT * FROM faqs WHERE is_active = true ORDER BY updated_at DESC`
    : `SELECT * FROM faqs ORDER BY updated_at DESC`;
  const { rows } = await query(sql);
  return rows.map(rowToFaq);
}

async function getFaq(id) {
  const { rows } = await query(`SELECT * FROM faqs WHERE id = $1`, [id]);
  return rows[0] ? rowToFaq(rows[0]) : null;
}

async function createFaq({ question, answer, departmentId, isActive = true }) {
  if (!question || !question.trim()) throw badRequest('question is required.');
  if (!answer || !answer.trim()) throw badRequest('answer is required.');

  const hash = fingerprint(question, answer);
  const embedding = await embedText(`${question}\n${answer}`);
  const id = crypto.randomUUID();

  await query(
    `INSERT INTO faqs (id, question, answer, department_id, is_active, embedding, embedded_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, question.trim(), answer.trim(), departmentId || null, isActive, JSON.stringify(embedding), hash]
  );
  return getFaq(id);
}

async function updateFaq(id, { question, answer, departmentId, isActive }) {
  const existing = await query(`SELECT * FROM faqs WHERE id = $1`, [id]);
  if (!existing.rows[0]) return null;
  const current = existing.rows[0];

  const nextQuestion = question !== undefined ? question : current.question;
  const nextAnswer = answer !== undefined ? answer : current.answer;
  const nextDept = departmentId !== undefined ? departmentId : current.department_id;
  const nextActive = isActive !== undefined ? isActive : current.is_active;

  const hash = fingerprint(nextQuestion, nextAnswer);
  let embeddingJson = typeof current.embedding === 'string'
    ? current.embedding
    : JSON.stringify(current.embedding);
  if (hash !== current.embedded_hash) {
    const embedding = await embedText(`${nextQuestion}\n${nextAnswer}`);
    embeddingJson = JSON.stringify(embedding);
  }

  await query(
    `UPDATE faqs
     SET question = $1, answer = $2, department_id = $3, is_active = $4,
         embedding = $5, embedded_hash = $6, updated_at = CURRENT_TIMESTAMP
     WHERE id = $7`,
    [nextQuestion.trim(), nextAnswer.trim(), nextDept || null, nextActive, embeddingJson, hash, id]
  );
  return getFaq(id);
}

async function deleteFaq(id) {
  const { rowCount } = await query(`DELETE FROM faqs WHERE id = $1`, [id]);
  return rowCount > 0;
}

// Used by ask.js's retrieval step. Returns chunks shaped the same way as
// the PDF chunks (filename/text/embedding) plus a 'source' tag, so the two
// can be scored and merged in one pass.
async function getActiveFaqChunks() {
  const { rows } = await query(
    `SELECT id, question, answer, department_id, embedding FROM faqs WHERE is_active = true AND embedding IS NOT NULL`
  );
  return rows.map((row) => ({
    filename: `FAQ: ${row.question}`,
    text: `${row.question}\n${row.answer}`,
    embedding: typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding,
    source: 'faq',
    faqId: row.id,
    departmentId: row.department_id,
  }));
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

module.exports = { listFaqs, getFaq, createFaq, updateFaq, deleteFaq, getActiveFaqChunks };
