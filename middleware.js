// middleware.js
//
// Gates for the admin dashboard's API routes and for the student portal's
// protected routes. Staff log in via POST /admin/login and students via
// POST /student/login; both get a JWT back and send it as
// "Authorization: Bearer <token>".
//
// Staff have one flat role — the staff gate checks "is this a valid staff
// session", not a permission level. Student tokens carry a different payload
// type, so the two kinds of session can never be swapped.

const { verifyToken: verifyStaffToken } = require('./staffAuth.js');
const { verifyToken: verifyStudentToken } = require('./studentAuth.js');

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

module.exports = { bearerToken, requireStaffAuth, requireAdminStaff, requireStudentAuth };
