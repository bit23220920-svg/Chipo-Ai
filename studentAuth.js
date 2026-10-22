// studentAuth.js
//
// Student accounts for the student portal (/portal). Students sign in with
// their student number and a password, and get a JWT back; every protected
// /student/* route requires it as "Authorization: Bearer <token>".
//
// Accounts are provisioned with the create-student.js CLI script (run on the
// server) — there is no public sign-up endpoint, because anyone who could
// create a student account could also read another student's portal.
//
// Student tokens are signed with the same JWT_SECRET as staff tokens but
// carry a distinct payload type, so a staff token can never be replayed
// against a student route (and vice versa).

require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('./db.js');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '12h';
const TOKEN_TYPE = 'student';

if (!JWT_SECRET) {
  console.warn('JWT_SECRET is not set in .env — student login will fail until it is configured.');
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function rowToStudent(row) {
  return {
    id: row.id,
    studentNumber: row.student_number,
    fullName: row.full_name,
    role: row.role || 'Basic student',
    programme: row.programme || null,
    faculty: row.faculty || null,
    yearOfStudy: row.year_of_study || null,
    email: row.email || null,
    phone: row.phone || null,
    status: row.status || 'Active',
    createdAt: row.created_at,
  };
}

/**
 * Create a student account.
 * @param {object} fields
 * @param {string} fields.studentNumber  - University student number (the login id).
 * @param {string} fields.password       - Plain text password, hashed here.
 * @param {string} fields.fullName
 * @param {string} [fields.programme]
 * @param {string} [fields.faculty]
 * @param {string} [fields.yearOfStudy]
 * @param {string} [fields.email]
 * @param {string} [fields.phone]
 * @param {string} [fields.role]
 */
async function createStudent({
  studentNumber,
  password,
  fullName,
  programme = null,
  faculty = null,
  yearOfStudy = null,
  email = null,
  phone = null,
  role = 'Basic student',
} = {}) {
  if (!studentNumber || !String(studentNumber).trim()) throw badRequest('Student number is required.');
  if (!fullName || !String(fullName).trim()) throw badRequest('Full name is required.');
  if (!password || password.length < 8) throw badRequest('Password must be at least 8 characters.');

  const hash = await bcrypt.hash(password, 12);
  const id = crypto.randomUUID();
  try {
    await query(
      `INSERT INTO students (id, student_number, password_hash, full_name, role, programme, faculty, year_of_study, email, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        String(studentNumber).trim().toUpperCase(),
        hash,
        String(fullName).trim(),
        role,
        programme,
        faculty,
        yearOfStudy,
        email,
        phone,
      ]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const dup = new Error(`A student account for "${studentNumber}" already exists.`);
      dup.statusCode = 409;
      throw dup;
    }
    throw err;
  }
  return getStudentProfile(id);
}

/** Returns the student record on success, or null on bad credentials. */
async function verifyLogin(studentNumber, password) {
  if (!studentNumber || !password) return null;
  const { rows } = await query(
    'SELECT * FROM students WHERE student_number = $1',
    [String(studentNumber).trim().toUpperCase()]
  );
  const student = rows[0];
  if (!student) return null;
  const ok = await bcrypt.compare(password, student.password_hash);
  if (!ok) return null;
  return rowToStudent(student);
}

async function getStudentProfile(id) {
  const { rows } = await query('SELECT * FROM students WHERE id = $1', [id]);
  return rows[0] ? rowToStudent(rows[0]) : null;
}

async function listStudents() {
  const { rows } = await query('SELECT * FROM students ORDER BY student_number ASC');
  return rows.map(rowToStudent);
}


/** Change a student's password after re-checking the current one. */
async function changePassword(id, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) throw badRequest('New password must be at least 8 characters.');
  const { rows } = await query('SELECT * FROM students WHERE id = $1', [id]);
  const student = rows[0];
  if (!student) throw badRequest('Student account no longer exists.');
  const ok = await bcrypt.compare(currentPassword || '', student.password_hash);
  if (!ok) throw badRequest('Your current password is incorrect.');
  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE students SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hash, id]);
  return true;
}

function issueToken(student) {
  return jwt.sign(
    {
      sub: student.id,
      type: TOKEN_TYPE,
      studentNumber: student.studentNumber,
      fullName: student.fullName,
      role: student.role,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

/** Throws if the token is missing/invalid/expired or is not a student token. */
function verifyToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.type !== TOKEN_TYPE) {
    const err = new Error('Not a student session.');
    err.statusCode = 401;
    throw err;
  }
  return payload;
}

module.exports = {
  createStudent,
  verifyLogin,
  getStudentProfile,
  listStudents,
  changePassword,
  issueToken,
  verifyToken,
  TOKEN_TYPE,
};
