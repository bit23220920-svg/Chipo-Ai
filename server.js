require('dotenv').config();
const express = require('express');
const path = require('path');

const { askQuestion } = require('./ask.js');
const tickets = require('./tickets.js');
const faqs = require('./faqs.js');
const departments = require('./departments.js');
const staffAuth = require('./staffAuth.js');
const chatlog = require('./chatlog.js');
const systemLog = require('./systemLog.js');
const { isTicketRequest, resolveTicketDepartment } = require('./ticketRouting.js');
const { pool } = require('./db.js');
const { requireStaffAuth, requireAdminStaff } = require('./middleware.js');

const app = express();
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await departments.ensureDefaultDepartments();
  } catch (err) {
    console.error('Could not start the server because the database is not ready.');
    console.error('Check that MariaDB/MySQL is running, the database exists, and the app schema has been created.');
    console.error('Typical fix: start XAMPP MySQL, create the "chipo" database in phpMyAdmin, then run: node migrate.js');
    console.error(err && (err.message || err));
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Used by Docker/hosting health checks (see docker-compose.yml) — confirms
// the process is up AND can actually reach the database, not just that the
// HTTP server is listening.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: 'Database unreachable.' });
  }
});

// Small helper so every admin route doesn't repeat its own try/catch —
// errors with a statusCode (validation errors from faqs.js/departments.js/
// tickets.js) use that; anything unexpected is a 500.
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('ERROR:', err.cause || err);
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      // Unexpected errors (including raw database errors we didn't
      // explicitly handle in a module) should never leak internals to
      // the client — log the detail server-side, return a plain message.
      res.status(500).json({ error: 'Something went wrong.' });
    }
  };
}

// ==================== Student-facing: chat ====================

app.post('/ask', handle(async (req, res) => {
  const { question, history, sessionId } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required.' });
  }

  // Validate history so a malformed client request can't break the prompt builder
  const safeHistory = Array.isArray(history)
    ? history
        .filter(h => h && typeof h.question === 'string' && typeof h.answer === 'string')
        .slice(-3)
    : [];

  console.log(`\nReceived question: "${question}" (with ${safeHistory.length} prior turns)`);
  const ticketRequest = isTicketRequest(question);
  const result = ticketRequest
    ? {
        answer: '',
        confidence: null,
        needsHuman: true,
        source: 'manual_request',
        departmentId: null,
      }
    : await askQuestion(question, safeHistory);
  const needsHuman = ticketRequest || result.needsHuman;
  const answer = needsHuman
    ? 'I can send your question to the right university team. First, please share your name and either your email address or phone number using the form below.'
    : result.answer;
  const { confidence, source } = result;
  res.json({
    answer,
    confidence,
    needsHuman,
    escalation: needsHuman
      ? {
          question,
          answer,
          confidence,
          departmentId: result.departmentId,
          reason: ticketRequest ? 'manual_request' : 'low_confidence',
        }
      : null,
  });

  // Log after responding — a logging hiccup shouldn't delay or break the
  // student's answer. Best-effort; failures are just logged server-side.
  chatlog
    .logMessage({ sessionId, question, answer, confidence, needsHuman, source })
    .catch((err) => console.error('Could not log chat message:', err.message));
}));

// ==================== Student-facing: ticket lookup ====================

app.post('/tickets', handle(async (req, res) => {
  const body = req.body || {};
  const { question, answer, confidence, name, email, phone, reason } = body;
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'A question is required to open a ticket.' });
  }

  const availableDepartments = await departments.listDepartments();
  const preferredDepartmentId = availableDepartments.some((department) => department.id === body.departmentId)
    ? body.departmentId
    : null;
  const routedDepartmentId = resolveTicketDepartment(question, availableDepartments, preferredDepartmentId);
  const ticket = await tickets.createTicket({
    name,
    email,
    phone,
    question,
    answer,
    confidence,
    reason,
    departmentId: routedDepartmentId,
  });
  ticket.departmentName = availableDepartments.find((department) => department.id === routedDepartmentId)?.name || null;
  res.status(201).json({ ticket: { id: ticket.id, departmentName: ticket.departmentName, status: ticket.status } });
}));

// Check a single ticket by its reference number. No login required — the
// reference itself (random, unguessable) is the credential, the same way a
// parcel tracking number works.
app.get('/tickets/:id', handle(async (req, res) => {
  const ticket = await tickets.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'No ticket found with that reference.' });
  res.json({ ticket: { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt } });
}));

// ==================== Staff login ====================

app.post('/admin/login', handle(async (req, res) => {
  const { username, password } = req.body;
  const staff = await staffAuth.verifyLogin(username, password);
  if (!staff) return res.status(401).json({ error: 'Incorrect username or password.' });
  const token = staffAuth.issueToken(staff);
  res.json({ token, staff });
}));

app.post('/admin/signup', handle(async (req, res) => {
  const { username, password, departmentId } = req.body;
  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!departmentId) {
    return res.status(400).json({ error: 'Choose a department for this staff account.' });
  }

  const staff = await staffAuth.createStaffUser(username, password, departmentId);
  res.status(201).json({ staff });
}));

app.get('/admin/departments/public', async (req, res) => {
  try {
    res.json({ departments: await departments.listDepartments() });
  } catch (err) {
    console.warn('Could not load public departments list for signup:', err.message);
    res.json({ departments: [] });
  }
});

app.get('/admin/me', requireStaffAuth, handle(async (req, res) => {
  const staff = await staffAuth.getStaffProfile(req.staff.sub);
  if (!staff) return res.status(401).json({ error: 'Staff account no longer exists.' });
  res.json(staff);
}));

// ==================== Admin: tickets ====================

app.get('/admin/tickets', requireStaffAuth, handle(async (req, res) => {
  const { status } = req.query;
  if (status && !tickets.VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${tickets.VALID_STATUSES.join(', ')}` });
  }
  res.json({ tickets: await tickets.listTickets({ status, departmentId: req.staff.departmentId, isAdmin: req.staff.isAdmin }) });
}));

app.patch('/admin/tickets/:id/status', requireStaffAuth, handle(async (req, res) => {
  const { status } = req.body;
  const ticket = await tickets.updateTicketStatus(req.params.id, status, req.staff.departmentId, req.staff.isAdmin);
  if (!ticket) return res.status(404).json({ error: 'No ticket found with that reference.' });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'ticket.status_change', detail: `${ticket.id} -> ${status}` })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.json({ ticket });
}));

// ==================== Admin: staff accounts ====================

app.get('/admin/staff', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ staff: await staffAuth.listStaffUsers() });
}));

app.post('/admin/staff', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const { username, password, departmentId } = req.body;
  if (!departmentId) {
    return res.status(400).json({ error: 'Choose a department for this staff account.' });
  }
  const staff = await staffAuth.createStaffUser(username, password, departmentId);
  systemLog
    .logEvent({ actor: req.staff.username, action: 'staff.create', detail: `${staff.username} -> ${staff.departmentName}` })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.status(201).json({ staff });
}));

// ==================== Admin: FAQs ====================

app.get('/admin/faqs', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ faqs: await faqs.listFaqs() });
}));

app.post('/admin/faqs', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const { question, answer, departmentId, isActive } = req.body;
  const faq = await faqs.createFaq({ question, answer, departmentId, isActive });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'faq.create', detail: faq.question })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.status(201).json({ faq });
}));

app.put('/admin/faqs/:id', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const { question, answer, departmentId, isActive } = req.body;
  const faq = await faqs.updateFaq(req.params.id, { question, answer, departmentId, isActive });
  if (!faq) return res.status(404).json({ error: 'No FAQ found with that id.' });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'faq.update', detail: faq.question })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.json({ faq });
}));

app.delete('/admin/faqs/:id', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const deleted = await faqs.deleteFaq(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'No FAQ found with that id.' });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'faq.delete', detail: req.params.id })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.status(204).end();
}));

// ==================== Admin: Departments ====================

app.get('/admin/departments', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ departments: await departments.listDepartments() });
}));

app.post('/admin/departments', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const { name, contactEmail, routingKeywords } = req.body;
  const dept = await departments.createDepartment({ name, contactEmail, routingKeywords });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'department.create', detail: dept.name })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.status(201).json({ department: dept });
}));

app.put('/admin/departments/:id', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const { name, contactEmail, routingKeywords } = req.body;
  const dept = await departments.updateDepartment(req.params.id, { name, contactEmail, routingKeywords });
  if (!dept) return res.status(404).json({ error: 'No department found with that id.' });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'department.update', detail: dept.name })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.json({ department: dept });
}));

app.delete('/admin/departments/:id', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const deleted = await departments.deleteDepartment(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'No department found with that id.' });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'department.delete', detail: req.params.id })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.status(204).end();
}));

// ==================== Admin: logs ====================

// Staff activity feed (who changed what).
app.get('/admin/logs/system', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ events: await systemLog.listEvents({ limit: req.query.limit }) });
}));

// Chat activity (what students have been asking, and how confidently
// Chipo answered) — the other half of "view system logs".
app.get('/admin/logs/chat', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ messages: await chatlog.listRecentMessages({ limit: req.query.limit }) });
}));

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
