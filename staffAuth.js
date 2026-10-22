// staffAuth.js
//
// Staff accounts for the admin dashboard. Deliberately one flat "staff"
// role — no permission levels. Accounts are provisioned via the
// create-staff.js CLI script (run on the server), not a public sign-up
// endpoint, since anyone who can create a staff account can reach the
// admin dashboard.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('./db.js');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '8h';

if (!JWT_SECRET) {
  console.warn('JWT_SECRET is not set in .env — staff login will fail until it is configured.');
}

function rowToStaff(row) {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function createStaffUser(username, password, department = null) {
  if (!username || !username.trim()) throw badRequest('Username is required.');
  if (!password || password.length < 8) throw badRequest('Password must be at least 8 characters.');

  const hash = await bcrypt.hash(password, 12);
  const id = crypto.randomUUID();
  let departmentId = null;
  let departmentName = null;
  if (department) {
    const match = await query(
      'SELECT id, name FROM departments WHERE id = $1 OR LOWER(name) = LOWER($1) LIMIT 1',
      [department]
    );
    if (!match.rows[0]) throw badRequest('Department was not found. Create it in the admin dashboard first.');
    departmentId = match.rows[0].id;
    departmentName = match.rows[0].name;
  }
  try {
    await query(
      `INSERT INTO staff_users (id, username, password_hash, department_id, is_admin) VALUES ($1, $2, $3, $4, $5)`,
      [id, username.trim(), hash, departmentId, !departmentId]
    );
    return { id, username: username.trim(), departmentId, departmentName, isAdmin: !departmentId, createdAt: new Date() };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const dup = new Error(`A staff account named "${username}" already exists.`);
      dup.statusCode = 409;
      throw dup;
    }
    throw err;
  }
}

/** Returns the staff record on success, or null on bad credentials. */
async function verifyLogin(username, password) {
  if (!username || !password) return null;
  const { rows } = await query('SELECT * FROM staff_users WHERE username = $1', [(username || '').trim()]);
  const user = rows[0];
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return { ...rowToStaff(user), departmentId: user.department_id || null, isAdmin: !!user.is_admin };
}

async function getStaffProfile(id) {
  const { rows } = await query(
    `SELECT staff_users.id, staff_users.username, staff_users.department_id, staff_users.is_admin,
            departments.name AS department_name
     FROM staff_users LEFT JOIN departments ON departments.id = staff_users.department_id
     WHERE staff_users.id = $1`,
    [id]
  );
  const staff = rows[0];
  return staff ? {
    id: staff.id,
    username: staff.username,
    departmentId: staff.department_id || null,
    departmentName: staff.department_name || null,
    isAdmin: !!staff.is_admin,
  } : null;
}

async function listStaffUsers() {
  const { rows } = await query(
    `SELECT staff_users.id, staff_users.username, staff_users.department_id, staff_users.is_admin,
            staff_users.created_at, departments.name AS department_name
     FROM staff_users LEFT JOIN departments ON departments.id = staff_users.department_id
     ORDER BY staff_users.username ASC`
  );
  return rows.map((staff) => ({
    id: staff.id,
    username: staff.username,
    departmentId: staff.department_id || null,
    departmentName: staff.department_name || null,
    isAdmin: !!staff.is_admin,
    createdAt: staff.created_at,
  }));
}

function issueToken(staff) {
  return jwt.sign({ sub: staff.id, type: 'staff', username: staff.username, departmentId: staff.departmentId || null, isAdmin: !!staff.isAdmin }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/** Throws if the token is missing/invalid/expired or is not a staff token. */
function verifyToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.type !== 'staff') {
    const err = new Error('Not a staff session.');
    err.statusCode = 401;
    throw err;
  }
  return payload;
}

module.exports = { createStaffUser, verifyLogin, getStaffProfile, listStaffUsers, issueToken, verifyToken };
