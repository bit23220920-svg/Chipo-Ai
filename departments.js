// departments.js
//
// Plain MariaDB-backed CRUD over the departments table. Departments are referenced by
// FAQs (for ownership) and tickets (optionally, for routing) — there's no
// keyword-based auto-routing engine here, just a place to record which
// department owns what, viewable/editable from the admin dashboard.

const crypto = require('crypto');
const { query } = require('./db.js');

function rowToDept(row) {
  return {
    id: row.id,
    name: row.name,
    contactEmail: row.contact_email,
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

async function createDepartment({ name, contactEmail }) {
  if (!name || !name.trim()) throw badRequest('name is required.');
  const id = crypto.randomUUID();
  try {
    await query(
      `INSERT INTO departments (id, name, contact_email) VALUES ($1, $2, $3)`,
      [id, name.trim(), contactEmail || null]
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

async function updateDepartment(id, { name, contactEmail }) {
  const existing = await query(`SELECT * FROM departments WHERE id = $1`, [id]);
  if (!existing.rows[0]) return null;
  const current = existing.rows[0];

  const nextName = name !== undefined ? name : current.name;
  const nextEmail = contactEmail !== undefined ? contactEmail : current.contact_email;

  try {
    await query(
      `UPDATE departments SET name = $1, contact_email = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [nextName.trim(), nextEmail || null, id]
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

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

module.exports = { listDepartments, getDepartment, createDepartment, updateDepartment, deleteDepartment };
