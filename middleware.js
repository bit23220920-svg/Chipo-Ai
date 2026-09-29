// middleware.js
//
// Gate for the admin dashboard's API routes. Staff log in via
// POST /admin/login (server.js) and get a JWT back; every protected
// /admin/* route requires it as "Authorization: Bearer <token>".
// One staff role — this checks "is this a valid staff session", not a
// permission level.

const { verifyToken } = require('./staffAuth.js');

function requireStaffAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Staff login required.' });

  try {
    req.staff = verifyToken(token); // { sub, username, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

function requireAdminStaff(req, res, next) {
  if (req.staff && req.staff.isAdmin) return next();
  return res.status(403).json({ error: 'Administrator access is required.' });
}

module.exports = { requireStaffAuth, requireAdminStaff };
