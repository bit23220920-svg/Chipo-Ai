// middleware.js
//
// Gates for the admin dashboard's API routes and for the student portal's
// protected routes. Staff log in via POST /admin/login and students via
// POST /student/login (or the shared POST /login route); both get a JWT back and send it as
// "Authorization: Bearer <token>".
//
// Staff have one flat role — the staff gate checks "is this a valid staff
// session", not a permission level. Student tokens carry a different payload
// type, so the two kinds of session can never be swapped.

const { verifyToken: verifyStaffToken } = require('./staffAuth.js');
const { verifyToken: verifyStudentToken, getStudentProfile } = require('./studentAuth.js');

function bearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

function requireStaffAuth(req, res, next) {
  const token = bearerToken(req);

  if (!token) return res.status(401).json({ error: 'Staff login required.' });

  try {
    req.staff = verifyStaffToken(token); // { sub, username, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

function requireAdminStaff(req, res, next) {
  if (req.staff && req.staff.isAdmin) return next();
  return res.status(403).json({ error: 'Administrator access is required.' });
}

function requireStudentAuth(req, res, next) {
  const token = bearerToken(req);

  if (!token) return res.status(401).json({ error: 'Student login required.' });

  try {
    req.student = verifyStudentToken(token); // { sub, studentNumber, fullName, ... }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

/**
 * Like requireStudentAuth, but also checks the account still exists, and puts
 * the student's own id on req.studentId. A token alone is not enough: the
 * account could have been removed since it was issued.
 *
 * Every route that reads a student's messages, tickets or notifications uses
 * this and takes the student id from here - never from the URL or the body.
 */
async function requireActiveStudent(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Student login required.' });

  let payload;
  try {
    payload = verifyStudentToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }

  try {
    const student = await getStudentProfile(payload.sub);
    if (!student) return res.status(401).json({ error: 'Student account no longer exists.' });
    req.student = payload;
    req.studentProfile = student;
    req.studentId = student.id;
    next();
  } catch (err) {
    console.error('ERROR:', err.cause || err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
}

module.exports = { bearerToken, requireStaffAuth, requireAdminStaff, requireStudentAuth, requireActiveStudent };
