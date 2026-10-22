require('dotenv').config();
const express = require('express');
const path = require('path');

const ask = require('./ask.js');
const tickets = require('./tickets.js');
const faqs = require('./faqs.js');
const departments = require('./departments.js');
const staffAuth = require('./staffAuth.js');
const studentAuth = require('./studentAuth.js');
const studentPortal = require('./studentPortal.js');
const portalAccess = require('./portalAccess.js');
const chatlog = require('./chatlog.js');
const systemLog = require('./systemLog.js');
const attachmentStore = require('./attachments.js');
const fileReader = require('./fileReader.js');
const { isTicketRequest, resolveTicketDepartment } = require('./ticketRouting.js');
const { pool, useTurso } = require('./db.js');
const { requireStaffAuth, requireAdminStaff, requireStudentAuth, bearerToken } = require('./middleware.js');

const app = express();
const PORT = process.env.PORT || 3000;
const ticketEventClients = new Set();

/**
 * The student session attached to a request, or null.
 *
 * The chat endpoint is open to everyone, so this never rejects a request —
 * it just says whether Chipo may read a student account. A missing, invalid
 * or expired token means "no session", i.e. the public experience.
 */
async function studentSessionFromRequest(req) {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const payload = studentAuth.verifyToken(token);
    if (!payload || payload.type !== 'student') return null;
    return await studentAuth.getStudentProfile(payload.sub);
  } catch (err) {
    return null;
  }
}

function notifyTicketChange() {
  for (const response of ticketEventClients) {
    response.write('data: tickets_changed\n\n');
  }
}

async function startServer() {
  // Turso (and sometimes a cold MySQL) can reject the very first connection
  // with "fetch failed". Retry a few times before giving up so a brief network
  // blip does not stop the whole site from starting.
  const attempts = 6;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const availableDepartments = await departments.ensureDefaultDepartments();
      const defaultDepartment = availableDepartments.find((department) => department.name.toLowerCase() === 'student affairs')
        || availableDepartments[0];
      if (defaultDepartment) {
        await tickets.assignUnassignedTickets(defaultDepartment.id);
      }
      await studentPortal.ensureDefaultPortalContent();
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        console.error(`Database not ready (attempt ${attempt}/${attempts}) - retrying in 2s: ${err && (err.message || err)}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  if (lastError) {
    console.error('Could not start the server because the database is not ready.');
    if (useTurso) {
      console.error('The app is configured to use Turso. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env, and that this machine can reach the Turso host.');
    } else {
      console.error('Check that MariaDB/MySQL is running, the database exists, and the app schema has been created.');
      console.error('Typical fix: start XAMPP MySQL, create the "chipo" database in phpMyAdmin, then run: node migrate.js');
    }
    console.error(lastError && (lastError.message || lastError));
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// The student portal lives at /portal (served from public/portal.html).
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

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

app.get('/admin/tickets/stream', requireStaffAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  ticketEventClients.add(res);

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  res.on('close', () => {
    clearInterval(heartbeat);
    ticketEventClients.delete(res);
  });
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
//
// Two chat entry points, and the difference matters:
//
//   POST /ask         the public website. Chipo has NO access to student
//                     records here, even if the browser still holds a
//                     student token from an earlier portal visit. It answers
//                     general university questions and refuses anything about
//                     somebody's own account.
//   POST /portal/ask  the student portal. Requires a valid student session,
//                     and Chipo reads that student's portal records so it can
//                     answer account questions in full.
//
// The split lives on the server, so the page decides which one it is by
// choosing the endpoint - the public site simply never sends a session.

// The contact details a visitor typed into their own question.
//
// Outside the portal nobody is signed in, so Chipo has no name, email or
// phone to work with. If the visitor gave them in the question - "my email is
// jane@example.com" - the ticket is opened straight away, exactly like it is
// for a signed-in student, instead of asking them to type it in again.
const EMAIL_IN_QUESTION = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// A phone number in the local or international format. It has to start with a
// country or a zero, so a student number such as BIT23220920 is not picked up
// as a phone number.
const PHONE_IN_QUESTION = /(?<![\w.])(?:\+260|0)\s?\d{3}[\s.-]?\d{3}[\s.-]?\d{3,4}(?![\w.])/;
const NAME_IN_QUESTION = /\b(?:my name is|i am|i'm|im)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/;

function contactFromQuestion(question) {
  const text = String(question || '');
  const email = (text.match(EMAIL_IN_QUESTION) || [])[0] || null;
  const phone = (text.match(PHONE_IN_QUESTION) || [])[0] || null;
  const name = (text.match(NAME_IN_QUESTION) || [])[1] || null;
  if (!email && !phone) return null;
  return { name, email, phone };
}

/**
 * Route a question to the right department and open a ticket for it.
 *
 * @param {{question: string, answer?: string, confidence?: number,
 *          reason?: string, departmentId?: string|null,
 *          contact: {name?: string, email?: string, phone?: string},
 *          routingContext?: string[]}} fields
 */
async function routeAndCreateTicket({ question, answer, confidence, reason, departmentId, contact, routingContext = [], forceDepartmentId = null }) {
  const availableDepartments = await departments.listDepartments();
  const preferredDepartmentId = availableDepartments.some((department) => department.id === departmentId)
    ? departmentId
    : null;
  const forcedDepartmentId = availableDepartments.some((department) => department.id === forceDepartmentId)
    ? forceDepartmentId
    : null;
  const routedDepartmentId = forcedDepartmentId
    || resolveTicketDepartment(question, availableDepartments, preferredDepartmentId, routingContext);

  const ticket = await tickets.createTicket({
    ...contact,
    question,
    answer,
    confidence,
    reason,
    departmentId: routedDepartmentId,
  });

  notifyTicketChange();
  ticket.departmentName = availableDepartments.find((department) => department.id === routedDepartmentId)?.name || null;
  return ticket;
}

// The office a student should contact if a ticket could not be opened. The
// departments table has the real email; the default keeps the message useful
// even when the database is the thing that failed.
async function officeContactFor(question, departmentId = null, preferStudentAffairs = false) {
  const fallback = { name: 'Student Affairs', email: 'studentaffairs@unilus.edu.zm' };
  try {
    const availableDepartments = await departments.listDepartments();
    const studentAffairs = availableDepartments.find((department) => /student affairs/i.test(department.name));
    const resolvedId = preferStudentAffairs
      ? studentAffairs?.id
      : resolveTicketDepartment(question, availableDepartments, departmentId);
    const office = availableDepartments.find((department) => department.id === resolvedId)
      || studentAffairs
      || availableDepartments.find((department) => department.contactEmail);
    if (!office) return fallback;
    return { name: office.name, email: office.contactEmail || fallback.email };
  } catch (err) {
    return fallback;
  }
}

async function chatResponse(req, student) {
  const { question, history, sessionId, attachmentIds } = req.body;

  if (!question || !question.trim()) {
    return { status: 400, body: { error: 'Question is required.' } };
  }

  // Validate history so a malformed client request can't break the prompt builder
  const safeHistory = Array.isArray(history)
    ? history
        .filter(h => h && typeof h.question === 'string' && typeof h.answer === 'string')
        .slice(-3)
    : [];

  console.log(`\nReceived question: "${question}" (with ${safeHistory.length} prior turns)`);

  const access = student ? 'student' : 'public';
  console.log(`Portal access for this request: ${access}${student ? ` (${student.studentNumber})` : ''}`);

  const ticketRequest = isTicketRequest(question);
  const attachments = attachmentStore.getMany(attachmentIds);
  if (Array.isArray(attachmentIds) && attachmentIds.length && !attachments.length) {
    return { status: 400, body: { error: 'The attached file is no longer available. Please attach it again.' } };
  }
  const result = ticketRequest
    ? {
        answer: '',
        confidence: null,
        needsHuman: true,
        source: 'manual_request',
        departmentId: null,
        access,
      }
    : await ask.askQuestion(question, safeHistory, { student, attachments });
  // A wellbeing crisis always reaches Student Affairs, even when the question
  // mentions exams or fees.
  const wellbeing = Boolean(student) && portalAccess.isWellbeingConcern(question);
  const needsHuman = ticketRequest || result.needsHuman || wellbeing;
  const { confidence, source } = result;

  // Chipo always gives the best answer it can. When that is not enough, the
  // question goes to the right department:
  //   - inside the portal, the student's own name, email and phone are
  //     already on file, so the ticket is opened straight away and the
  //     student is not asked to type their details in again.
  //   - outside the portal, the same happens when the visitor put their email
  //     or phone number in the question. Only when there is no way to reach
  //     them is the contact form shown.
  let answer = result.answer || '';
  let ticket = null;

  if (needsHuman) {
    const contact = student
      ? { name: student.fullName, email: student.email, phone: student.phone }
      : contactFromQuestion(question);
    const knownContact = contact && (contact.email || contact.phone);

    let forcedDepartmentId = null;
    if (wellbeing) {
      try {
        const availableDepartments = await departments.listDepartments();
        forcedDepartmentId = availableDepartments.find((department) => /student affairs/i.test(department.name))?.id || null;
      } catch (err) {
        console.error('Could not look up Student Affairs for a wellbeing ticket:', err.message);
      }
    }

    if (knownContact) {
      try {
        ticket = await routeAndCreateTicket({
          question,
          answer: result.answer,
          confidence,
          reason: wellbeing ? 'wellbeing' : (ticketRequest ? 'manual_request' : 'low_confidence'),
          departmentId: result.departmentId,
          forceDepartmentId: forcedDepartmentId,
          contact,
          routingContext: safeHistory.map((turn) => turn.question.slice(0, 1000)),
        });
      } catch (err) {
        console.error('Could not open the ticket:', err.message);
      }
    }

    let note;
    if (ticket) {
      const officeName = ticket.departmentName || 'the right university team';
      if (wellbeing) {
        note = `I've asked Student Affairs to reach out to you. Your reference is ${ticket.id}. Staff will contact you using the details on your portal account.`;
      } else {
        const prefix = ticketRequest
          ? "I've sent this"
          : "I wasn't completely sure about that, so I've sent it";
        note = `${prefix} to ${officeName}. Your reference is ${ticket.id}. Staff will contact you using the details on your portal account.`;
      }
    } else if (student) {
      // No ticket: either the database failed or the portal has no email or
      // phone on file. Say so honestly and give the office's real email.
      const office = await officeContactFor(question, result.departmentId, wellbeing);
      note = wellbeing
        ? `I couldn't open a ticket just now, so please reach out to ${office.name} directly at ${office.email}, or to someone you trust right now.`
        : `I couldn't open a ticket just now, so please contact ${office.name} directly at ${office.email}.`;
    } else {
      note = 'I can send your question to the right university team. First, please share your name and either your email address or phone number using the form below.';
    }

    answer = answer ? `${answer}\n\n${note}` : note;
  }

  // Log after responding — a logging hiccup shouldn't delay or break the
  // student's answer. Best-effort; failures are just logged server-side.
  chatlog
    .logMessage({
      sessionId,
      question,
      answer,
      confidence,
      needsHuman,
      source,
      studentId: student ? student.id : null,
      studentNumber: student ? student.studentNumber : null,
    })
    .catch((err) => console.error('Could not log chat message:', err.message));

  return {
    status: 200,
    body: {
      answer,
      confidence,
      needsHuman,
      access,
      sources: result.sources || [],
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        kind: attachment.kind,
        characters: attachment.characters || 0,
      })),
      ticket: ticket
        ? { id: ticket.id, departmentName: ticket.departmentName, status: ticket.status }
        : null,
      escalation: needsHuman
        ? {
            question,
            answer,
            confidence,
            departmentId: result.departmentId,
            routingContext: safeHistory.map((turn) => turn.question.slice(0, 1000)),
            reason: wellbeing ? 'wellbeing' : (ticketRequest ? 'manual_request' : 'low_confidence'),
          }
        : null,
    },
  };
}

// Upload a file for Chipo to read.
//
// The file is read on the server (PDF, Word, PowerPoint, Excel, plain text) or
// kept as an image for the model to look at, and then held in memory for a
// short while. The next question carries the returned id, so the content
// never has to travel back and forth inside the chat request.
app.post('/attachments', handle(async (req, res) => {
  const { filename, mimeType, data } = req.body || {};

  if (typeof data !== 'string' || !data) {
    return res.status(400).json({ error: 'No file content was received.' });
  }

  const attachment = await fileReader.readUploadedFile({ filename, mimeType, data });
  const id = attachmentStore.save(attachment);

  console.log(`\nStored attachment "${attachment.filename}" (${attachment.kind}, ${attachment.characters || 0} characters)`);

  res.json({
    id,
    filename: attachment.filename,
    kind: attachment.kind,
    characters: attachment.characters,
    truncated: Boolean(attachment.truncated),
    preview: attachment.preview,
  });
}));

// The public website. No student session is honoured here, on purpose.
app.post('/ask', handle(async (req, res) => {
  const { status, body } = await chatResponse(req, null);
  res.status(status).json(body);
}));

// The student portal. The session is required — without it Chipo stays
// locked and the portal asks the student to sign in again.
app.post('/portal/ask', handle(async (req, res) => {
  const student = await studentSessionFromRequest(req);
  if (!student) {
    return res.status(401).json({ error: 'Your portal session has expired. Please sign in again.' });
  }
  const { status, body } = await chatResponse(req, student);
  res.status(status).json(body);
}));

// ==================== Student-facing: ticket lookup ====================

app.post('/tickets', handle(async (req, res) => {
  const body = req.body || {};
  const { question, answer, confidence, name, email, phone, reason } = body;
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'A question is required to open a ticket.' });
  }

  const routingContext = Array.isArray(body.routingContext)
    ? body.routingContext.filter((entry) => typeof entry === 'string').slice(-3)
    : [];
  const ticket = await routeAndCreateTicket({
    question,
    answer,
    confidence,
    reason,
    departmentId: body.departmentId,
    contact: { name, email, phone },
    routingContext,
  });
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

// ==================== Student portal ====================

app.post('/student/login', handle(async (req, res) => {
  const { studentNumber, password } = req.body;
  const student = await studentAuth.verifyLogin(studentNumber, password);
  if (!student) return res.status(401).json({ error: 'Incorrect student number or password.' });
  const token = studentAuth.issueToken(student);
  res.json({ token, student });
}));

// Public self-registration for student accounts, used by the "Create an
// account" form on the portal sign-in screen. It is enabled by default for
// the demo; set ALLOW_STUDENT_SIGNUP=false to close it and fall back to the
// create-student.js CLI.
app.post('/student/register', handle(async (req, res) => {
  if (String(process.env.ALLOW_STUDENT_SIGNUP || '').toLowerCase() === 'false') {
    return res.status(403).json({ error: 'Student sign-up is closed. Please contact the Registry for an account.' });
  }

  const body = req.body || {};
  const studentNumber = String(body.studentNumber || '').trim().toUpperCase();
  const fullName = String(body.fullName || '').trim();
  const password = String(body.password || '');
  const email = String(body.email || '').trim() || null;
  const phone = String(body.phone || '').trim() || null;
  const programme = String(body.programme || '').trim() || null;
  const yearOfStudy = String(body.yearOfStudy || '').trim() || null;

  if (!/^[A-Z0-9-]{4,20}$/.test(studentNumber)) {
    return res.status(400).json({ error: 'Enter a valid student number (4-20 letters and numbers).' });
  }
  if (fullName.length < 3 || fullName.length > 120) {
    return res.status(400).json({ error: 'Enter your full name.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (phone && !/^[0-9+()\-\s]{7,25}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid phone number.' });
  }
  if (yearOfStudy && !/^Year [1-6]$/.test(yearOfStudy)) {
    return res.status(400).json({ error: 'Choose your year of study.' });
  }
  if (programme && programme.length > 120) {
    return res.status(400).json({ error: 'Programme name is too long.' });
  }

  const student = await studentAuth.createStudent({
    studentNumber,
    password,
    fullName,
    programme,
    yearOfStudy,
    email,
    phone,
  });
  const token = studentAuth.issueToken(student);
  res.status(201).json({ token, student });
}));

app.get('/student/me', requireStudentAuth, handle(async (req, res) => {
  const student = await studentAuth.getStudentProfile(req.student.sub);
  if (!student) return res.status(401).json({ error: 'Student account no longer exists.' });
  res.json(student);
}));

// Everything the portal dashboard renders, in one request.
app.get('/student/portal', requireStudentAuth, handle(async (req, res) => {
  const student = await studentAuth.getStudentProfile(req.student.sub);
  if (!student) return res.status(401).json({ error: 'Student account no longer exists.' });
  res.json(await studentPortal.getPortalData(student));
}));

app.post('/student/password', requireStudentAuth, handle(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  await studentAuth.changePassword(req.student.sub, currentPassword, newPassword);
  res.json({ ok: true });
}));

app.post('/student/logout', requireStudentAuth, (req, res) => {
  // Tokens are stateless — the client discards it. The endpoint exists so
  // the portal can record the sign-out in one place.
  res.json({ ok: true });
});

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
  notifyTicketChange();
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
