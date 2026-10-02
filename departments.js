// departments.js
//
// Plain MariaDB-backed CRUD over the departments table. Departments are referenced by
// FAQs (for ownership) and tickets (optionally, for routing) — there's no
// keyword-based auto-routing engine here, just a place to record which
// department owns what, viewable/editable from the admin dashboard.

const crypto = require('crypto');
const { query } = require('./db.js');

const DEFAULT_DEPARTMENTS = [
  { name: 'Accounts', contactEmail: 'accounts@unilus.edu.zm', routingKeywords: ['fees', 'fees payment', 'tuition', 'invoice', 'payment', 'refund', 'bursar'] },
  { name: 'Academic Office', contactEmail: 'academics@unilus.edu.zm', routingKeywords: ['academic', 'programme', 'course', 'curriculum', 'study plan', 'exams', 'timetable', 'class schedule'] },
  { name: 'Postgraduate Office', contactEmail: 'postgrad@unilus.edu.zm', routingKeywords: ['postgraduate', 'masters', 'phd', 'research', 'postgrad', 'thesis', 'supervision'] },
  { name: 'IT Department', contactEmail: 'it@unilus.edu.zm', routingKeywords: ['wifi', 'internet', 'system', 'login', 'password', 'ict', 'computer', 'technical'] },
  { name: 'Library', contactEmail: 'library@unilus.edu.zm', routingKeywords: ['library', 'book', 'student id', 'id card', 'borrow', 'card replacement'] },
  { name: 'Admissions', contactEmail: 'admissions@unilus.edu.zm', routingKeywords: ['admission', 'enrolment', 'application', 'letters', 'registration'] },
  { name: 'Registry', contactEmail: 'registry@unilus.edu.zm', routingKeywords: ['transcript', 'results', 'course registration', 'records', 'certificates', 'academic records'] },
  { name: 'Student Affairs', contactEmail: 'studentaffairs@unilus.edu.zm', routingKeywords: ['accommodation', 'housing', 'wellbeing', 'discipline', 'student support'] },
];

function rowToDept(row) {
  let routingKeywords = row.routing_keywords || [];
  if (typeof routingKeywords === 'string') {
    try { routingKeywords = JSON.parse(routingKeywords); } catch { routingKeywords = []; }
  }
  return {
    id: row.id,
    name: row.name,
    contactEmail: row.contact_email,
    routingKeywords: Array.isArray(routingKeywords) ? routingKeywords : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listDepartments() {
  const { rows } = await query(`SELECT * FROM departments ORDER BY name ASC`);
  return rows.map(rowToDept);
}

async function getDepartment(id) {
  const { rows } = await query(`SELECT * FROM departments WHERE id = $1`, [id]);
  return rows[0] ? rowToDept(rows[0]) : null;
}

function normalizeRoutingKeywords(value) {
  if (value === undefined || value === null || value === '') return [];
  const keywords = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(keywords.map((keyword) => String(keyword).trim()).filter(Boolean))];
}

async function createDepartment({ name, contactEmail, routingKeywords }) {
  if (!name || !name.trim()) throw badRequest('name is required.');
  const id = crypto.randomUUID();
  try {
    await query(
      `INSERT INTO departments (id, name, contact_email, routing_keywords) VALUES ($1, $2, $3, $4)`,
      [id, name.trim(), contactEmail || null, JSON.stringify(normalizeRoutingKeywords(routingKeywords))]
    );
    return await getDepartment(id);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const dup = new Error(`A department named "${name}" already exists.`);
      dup.statusCode = 409;
      throw dup;
    }
    throw err;
  }
}

async function updateDepartment(id, { name, contactEmail, routingKeywords }) {
  const existing = await query(`SELECT * FROM departments WHERE id = $1`, [id]);
  if (!existing.rows[0]) return null;
  const current = existing.rows[0];

  const nextName = name !== undefined ? name : current.name;
  const nextEmail = contactEmail !== undefined ? contactEmail : current.contact_email;
  const nextRoutingKeywords = routingKeywords !== undefined
    ? normalizeRoutingKeywords(routingKeywords)
    : rowToDept(current).routingKeywords;

  try {
    await query(
      `UPDATE departments SET name = $1, contact_email = $2, routing_keywords = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
      [nextName.trim(), nextEmail || null, JSON.stringify(nextRoutingKeywords), id]
    );
    return await getDepartment(id);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const dup = new Error(`A department named "${nextName}" already exists.`);
      dup.statusCode = 409;
      throw dup;
    }
    throw err;
  }
}

async function deleteDepartment(id) {
  const { rowCount } = await query(`DELETE FROM departments WHERE id = $1`, [id]);
  return rowCount > 0;
}

async function ensureDefaultDepartments() {
  const current = await listDepartments();
  if (current.length) return current;

  const created = [];
  for (const department of DEFAULT_DEPARTMENTS) {
    created.push(await createDepartment(department));
  }
  return created;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

module.exports = { listDepartments, getDepartment, createDepartment, updateDepartment, deleteDepartment, ensureDefaultDepartments };
