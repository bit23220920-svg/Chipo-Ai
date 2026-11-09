require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const ask = require('./ask.js');
const tickets = require('./tickets.js');
const mailer = require('./mailer.js');
const feedback = require('./feedback.js');
const analytics = require('./analytics.js');
const documents = require('./documents.js');
const errorlog = require('./errorlog.js');
const faqs = require('./faqs.js');
const departments = require('./departments.js');
const staffAuth = require('./staffAuth.js');
const studentAuth = require('./studentAuth.js');
const studentPortal = require('./studentPortal.js');
const portalAccess = require('./portalAccess.js');
const chatlog = require('./chatlog.js');
const conversations = require('./conversations.js');
const notifications = require('./notifications.js');
const systemLog = require('./systemLog.js');
const attachmentStore = require('./attachments.js');
const fileReader = require('./fileReader.js');
const { isTicketRequest, resolveTicketDepartment } = require('./ticketRouting.js');
const { pool, useTurso } = require('./db.js');
const { requireStaffAuth, requireAdminStaff, requireStudentAuth, requireActiveStudent, bearerToken } = require('./middleware.js');
const { rateLimit, failedLogins } = require('./ratelimit.js');

const app = express();
// Do not tell visitors which framework this is.
app.disable('x-powered-by');
// Behind a proxy such as Caddy, set TRUST_PROXY=1 so req.ip (used by the rate
// limits) is the visitor and not the proxy.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
}
const PORT = process.env.PORT || 3000;
const ticketEventClients = new Set();
const MAX_QUESTION_LENGTH = 4000;
const CAMPUSES = [
  {
    name: 'Pioneer Campus (Main/Administration)',
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=University+of+Lusaka+Pioneer+Campus+Plot+37413+Alick+Nkhata+Road+Mass+Media+Lusaka',
  },
  {
    name: 'Leopards Hill Campus (Law Campus)',
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=University+of+Lusaka+Leopards+Hill+Campus+Plot+17986+Leopards+Hill+Road+Lusaka',
  },
  {
    name: 'Silverest Campus',
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=University+of+Lusaka+Silverest+Campus+Plot+23072+M+Great+East+Road+Chongwe',
  },
];

function isCampusLocationQuestion(question, history = []) {
  const asksForLocation = /\b(?:where|were|location|address|directions?|located)\b/i.test(question);
  if (!asksForLocation) return false;

  const namesCampus = /\b(?:school|university|unilus|campuses?|pioneer|leopards hill|silverest)\b/i.test(question);
  const refersToRecentCampuses = /\b(?:they|them|these|those|it|both|all three)\b/i.test(question)
    && history.slice(-4).some((turn) =>
      /\b(?:campuses?|pioneer|leopards hill|silverest)\b/i.test(`${turn.question} ${turn.answer}`)
    );
  return namesCampus || refersToRecentCampuses;
}

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

function describeModels() {
  const llm = require('./llm.js');
  if (String(process.env.CHIPO_ENGINE || '').toLowerCase() === 'local') return 'local engine only (CHIPO_ENGINE=local)';
  const chain = [];
  chain.push(llm.groqAvailable() ? `Groq (${llm.groqModel()})` : 'Groq NOT set up (GROQ_API_KEY missing)');
  chain.push(String(process.env.GEMINI_API_KEY || '').trim() ? 'Gemini' : 'Gemini NOT set up (GEMINI_API_KEY missing)');
  chain.push('local engine');
  return chain.join(' -> ');
}

async function startServer() {
  console.log(`Answer order: ${describeModels()}`);
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

  if (String(process.env.ALLOW_STAFF_SIGNUP || '').toLowerCase() !== 'false') {
    console.warn('WARNING: staff sign-up is open, so anyone who can reach this site can create a staff account and read student tickets. Set ALLOW_STAFF_SIGNUP=false once your staff accounts exist.');
  }
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});
app.use(express.json({ limit: '16mb' }));
// A request with no JSON body leaves req.body undefined. Give the routes an
// empty object so they answer "missing field" instead of crashing.
app.use((req, res, next) => {
  if (req.body === undefined || req.body === null) req.body = {};
  next();
});
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
      // A deliberate 4xx (bad input, busy, conflict) is the caller's mistake,
      // not the server's; logging each one with a stack trace buries the
      // real failures, and a flood of them would fill the log.
      if (err.statusCode && err.statusCode < 500) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error('ERROR:', err.cause || err);
      errorlog.record({
        component: /^(ER_|SQLITE|LibsqlError)|ECONNREFUSED|database/i.test(`${err.code || ''} ${err.name || ''} ${err.message || ''}`) ? 'database' : 'server',
        kind: 'server_error',
        error: err.cause || err,
        route: `${req.method} ${req.path}`,
        statusCode: err.statusCode || 500,
        question: req.body && typeof req.body.question === 'string' ? req.body.question : undefined,
      });
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

function summarizeTicketHandover(turns, question, answer, earlierSummary = '') {
  const lines = [`Issue: ${String(question || '').trim().slice(0, 1200)}`];
  if (earlierSummary) {
    lines.push(`Earlier conversation summary: ${String(earlierSummary).trim().slice(0, 1200)}`);
  }
  const recentTurns = (Array.isArray(turns) ? turns : []).slice(-3);
  if (recentTurns.length) {
    lines.push('Recent conversation:');
    for (const turn of recentTurns) {
      if (turn.question) lines.push(`Student: ${String(turn.question).trim().slice(0, 600)}`);
      if (turn.answer) lines.push(`Chipo: ${String(turn.answer).trim().slice(0, 600)}`);
    }
  }
  if (answer) lines.push(`Chipo's response: ${String(answer).trim().slice(0, 600)}`);
  return lines.join('\n').slice(0, 6000);
}

// Ways of asking about a ticket that is already open. They are specific on
// purpose: "where do I open a ticket?" is a how-to question, not a status check.
const OWN_TICKET = '(?:my|the|that|our)\\s+(?:\\w+\\s+){0,2}tickets?';
const TICKET_STATUS_PATTERNS = [
  new RegExp(`\\bwhere(?:'?s| is| are)\\s+${OWN_TICKET}\\b`, 'i'),
  new RegExp(`\\b(?:has|have|is|are|did|was|were|will)\\s+${OWN_TICKET}\\s+(?:been\\s+)?(?:resolved|sorted|handled|closed|answered|picked up|opened|looked at|updated|done|fixed|seen|received|moved|solved)\\b`, 'i'),
  new RegExp(`\\b(?:any|no)\\s+(?:news|update|updates|word|reply|response|movement|progress)\\s+(?:on|about|with|for|regarding)\\s+${OWN_TICKET}\\b`, 'i'),
  new RegExp(`\\b${OWN_TICKET}\\s+(?:status|progress|update|updates)\\b`, 'i'),
  new RegExp(`\\b(?:status|progress|update|updates|news)\\s+(?:of|on|for|with|about)\\s+${OWN_TICKET}\\b`, 'i'),
  new RegExp(`\\b(?:what(?:'?s| is)|how(?:'?s| is))\\s+(?:happening|going|up)\\s+(?:with|on)\\s+${OWN_TICKET}\\b`, 'i'),
  /\b(?:show|list|see|view|display|check)\s+(?:me\s+)?(?:all\s+)?(?:of\s+)?(?:my|the)\s+(?:\w+\s+){0,2}tickets?\b/i,
  /^\s*(?:my\s+)?tickets?\s*[?.!]*\s*$/i,
];

function parseTicketStatusRequest(question) {
  const reference = question.match(/\b(TCK-[A-F0-9]{16})\b/i);
  const asksAboutOne = TICKET_STATUS_PATTERNS.some((pattern) => pattern.test(question));
  const mentionsOne = /\b(?:ticket|reference)\b/i.test(question) || Boolean(reference);
  const asksForStatus = /\b(?:status|track(?:ing)?|progress|check|update)\b/i.test(question);
  if (!asksAboutOne && !(mentionsOne && asksForStatus)) return null;
  return { reference: reference ? reference[1].toUpperCase() : null };
}

// One short line per ticket, built only from what the database holds.
function describeTicket(ticket) {
  const office = ticket.departmentName ? ` (${ticket.departmentName})` : '';
  const subject = ticket.subject ? ` - ${ticket.subject}` : '';
  return `${ticket.id}${office}: ${tickets.statusLabel(ticket.status)}${subject}. Last updated ${ticket.updatedAt}.`;
}

/**
 * The reply to "where is my ticket?" for a signed-in student.
 *
 * It is written from the student's own rows in the database - the model is
 * never asked, so it cannot guess a status. Only tickets that belong to this
 * student are ever looked at; a reference that belongs to someone else gets
 * exactly the same answer as one that does not exist.
 */
async function studentTicketAnswer(student, reference) {
  if (reference) {
    const ticket = await tickets.getStudentTicket(student.id, reference);
    if (!ticket) {
      return {
        answer: `I couldn't find a ticket with reference ${reference} on your account. Check the reference, or ask me "where is my ticket?" to see all of yours.`,
        ticket: null,
      };
    }
    return {
      answer: `Your ${ticket.departmentName || 'university'} ticket ${ticket.id} is currently ${tickets.statusLabel(ticket.status)}. Last updated: ${ticket.updatedAt}.`,
      ticket,
    };
  }

  const own = await tickets.listStudentTickets(student.id, { limit: 6 });
  if (!own.length) {
    return { answer: "You don't have any tickets yet. If you'd like a university office to look into something, just ask me to open one.", ticket: null };
  }
  if (own.length === 1) {
    return { answer: `You have one ticket. ${describeTicket(own[0])}`, ticket: own[0] };
  }
  const shown = own.slice(0, 5);
  const more = own.length > shown.length ? '\nAsk me about a reference to see an older one.' : '';
  return {
    answer: `Here are your most recent tickets:\n${shown.map((ticket) => `- ${describeTicket(ticket)}`).join('\n')}${more}`,
    ticket: shown[0],
  };
}

/**
 * Route a question to the right department and open a ticket for it.
 *
 * @param {{question: string, answer?: string, confidence?: number,
 *          reason?: string, departmentId?: string|null,
 *          contact: {name?: string, email?: string, phone?: string},
 *          routingContext?: string[], conversationSummary?: string}} fields
 */
async function routeAndCreateTicket({ question, answer, confidence, reason, departmentId, contact, routingContext = [], conversationSummary, conversationHistory, forceDepartmentId = null, studentId = null }) {
  const availableDepartments = await departments.listDepartments();
  const preferredDepartmentId = availableDepartments.some((department) => department.id === departmentId)
    ? departmentId
    : null;
  const forcedDepartmentId = availableDepartments.some((department) => department.id === forceDepartmentId)
    ? forceDepartmentId
    : null;
  const routedDepartmentId = forcedDepartmentId
    || resolveTicketDepartment(question, availableDepartments, preferredDepartmentId, routingContext);

  const existing = await tickets.findOpenDuplicate({ studentId, departmentId: routedDepartmentId, question });
  const ticket = existing || await tickets.createTicket({
    ...contact,
    question,
    answer,
    confidence,
    reason,
    departmentId: routedDepartmentId,
    conversationSummary,
    conversationHistory,
    studentId,
  });

  if (!existing) notifyTicketChange();
  ticket.departmentName = availableDepartments.find((department) => department.id === routedDepartmentId)?.name || null;
  if (!existing) mailer.ticketCreated(ticket).catch(() => {});
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
  const { question, sessionId: providedSessionId, attachmentIds } = req.body;

  if (typeof question !== 'string' || !question.trim()) {
    return { status: 400, body: { error: 'Question is required.' } };
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return { status: 400, body: { error: `Question must be ${MAX_QUESTION_LENGTH.toLocaleString('en-US')} characters or fewer.` } };
  }
  if (providedSessionId !== undefined &&
      (typeof providedSessionId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(providedSessionId))) {
    return { status: 400, body: { error: 'A valid chat session ID is required.' } };
  }
  let sessionId = providedSessionId || crypto.randomUUID();

  // A signed-in student's memory belongs to that student: the server finds
  // their current conversation itself (the browser never names one) and loads
  // its last 15 messages. The public site keeps its per-tab session history.
  let memory = null;
  let conversation;
  if (student) {
    try {
      const current = await conversations.getOrCreateCurrent(student.id);
      const recent = await conversations.loadRecent(current.id, student.id, conversations.HISTORY_MESSAGE_LIMIT);
      conversation = conversations.toHistory(recent);
      memory = { conversationId: current.id };
      sessionId = `student-chat-${current.id}`;
    } catch (err) {
      // Memory is a convenience, not a gate: if it cannot be reached (for
      // example "node migrate.js" has not been run since this feature was
      // added) the student still gets answers, just without earlier messages.
      // It never falls back to another chat's history.
      console.error('Chat memory is unavailable; answering without earlier messages. Has "node migrate.js" been run?', err.message);
      conversation = conversations.toHistory([]);
    }
  } else {
    conversation = await chatlog.loadConversationHistory(sessionId, ask.summarizeConversation);
  }
  const safeHistory = conversation.turns;

  // Keep the exchange in the student's conversation. If saving fails the
  // student still gets their answer; the failure is logged.
  const remember = async (answerText) => {
    if (!memory) return;
    try {
      await conversations.saveExchange({
        conversationId: memory.conversationId,
        studentId: student.id,
        question,
        answer: answerText,
      });
    } catch (err) {
      console.error('Could not save the chat messages:', err.message);
      errorlog.record({ component: 'database', kind: 'memory_failure', error: err, detail: 'Could not save the chat exchange' });
    }
  };

  console.log(`\nReceived question: "${question}" (session ${sessionId}, ${conversation.messages.length} recent messages)`);

  const access = student ? 'student' : 'public';
  console.log(`Portal access for this request: ${access}${student ? ` (${student.studentNumber})` : ''}`);

  const statusRequest = parseTicketStatusRequest(question);
  if (statusRequest) {
    let answer;
    let ticket = null;
    if (student) {
      // Signed in: answer from this student's own tickets, whatever the
      // question says. The model is not involved.
      ({ answer, ticket } = await studentTicketAnswer(student, statusRequest.reference));
    } else if (!statusRequest.reference) {
      answer = 'Please send the ticket reference (for example, TCK-0123456789ABCDEF) and I can check its status. If you opened it from your student account, sign in to the student portal and ask me there.';
    } else {
      ticket = await tickets.getTicket(statusRequest.reference);
      if (ticket && ticket.studentId) {
        // A ticket tied to a student account is only visible to that student.
        answer = 'That ticket belongs to a student account. Please sign in to the student portal and ask me there to see its status.';
        ticket = null;
      } else if (!ticket) {
        answer = `I couldn't find a ticket with reference ${statusRequest.reference}. Check the reference and try again.`;
      } else {
        const statusLabel = tickets.statusLabel(ticket.status);
        const department = ticket.departmentName ? ` It is assigned to ${ticket.departmentName}.` : '';
        answer = `Ticket ${ticket.id} is currently ${statusLabel}.${department} Last updated: ${ticket.updatedAt}.`;
      }
    }
    await chatlog.logMessage({
      sessionId,
      question,
      answer,
      confidence: null,
      needsHuman: false,
      source: 'ticket_status',
      studentId: student ? student.id : null,
      studentNumber: student ? student.studentNumber : null,
    });
    await remember(answer);
    return {
      status: 200,
      body: {
        sessionId,
        answer,
        confidence: null,
        needsHuman: false,
        access,
        sources: [],
        ticket: ticket ? { id: ticket.id, departmentName: ticket.departmentName, status: ticket.status, updatedAt: ticket.updatedAt } : null,
      },
    };
  }

  const ticketRequest = isTicketRequest(question);
  const attachments = attachmentStore.getMany(attachmentIds);
  if (Array.isArray(attachmentIds) && attachmentIds.length && !attachments.length) {
    return { status: 400, body: { error: 'The attached file is no longer available. Please attach it again.' } };
  }
  const locationQuestion = !attachments.length && isCampusLocationQuestion(question, safeHistory);
  const result = ticketRequest
    ? {
        answer: '',
        confidence: null,
        needsHuman: true,
        source: 'manual_request',
        departmentId: null,
        access,
      }
    : await ask.askQuestion(question, conversation, { student, attachments });
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
          studentId: student ? student.id : null,
          contact,
          routingContext: safeHistory.map((turn) => turn.question.slice(0, 1000)),
          conversationSummary: summarizeTicketHandover(safeHistory, question, result.answer, conversation.summary),
          conversationHistory: [
            ...conversation.messages,
            { role: 'user', content: question },
            ...(result.answer ? [{ role: 'assistant', content: result.answer }] : []),
          ],
        });
      } catch (err) {
        console.error('Could not open the ticket:', err.message);
        errorlog.record({ component: 'tickets', kind: 'ticket_failure', error: err, detail: 'Could not open a ticket for an escalated question' });
      }
    }

    let note;
    if (ticket) {
      const officeName = ticket.departmentName || 'the right university team';
      if (wellbeing) {
        note = `I've asked Student Affairs to reach out to you. Your reference is ${ticket.id}. Staff will contact you using the details on your portal account. You can ask me to check its status using that reference.`;
      } else {
        const prefix = ticketRequest
          ? "I've sent this"
          : "I wasn't completely sure about that, so I've sent it";
        note = `${prefix} to ${officeName}. Your reference is ${ticket.id}. Staff will contact you using the details on your portal account. You can ask me to check its status using that reference.`;
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

  await chatlog.logMessage({
    sessionId,
    question,
    answer,
    confidence,
    needsHuman,
    source,
    studentId: student ? student.id : null,
    studentNumber: student ? student.studentNumber : null,
  });
  await remember(answer);

  return {
    status: 200,
    body: {
      sessionId,
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
      campusMaps: locationQuestion ? CAMPUSES : [],
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
            conversationSummary: summarizeTicketHandover(safeHistory, question, result.answer, conversation.summary),
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
app.post('/attachments', rateLimit({ name: 'attachments', windowMs: 10 * 60 * 1000, max: 30 }), handle(async (req, res) => {
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
app.post('/ask', rateLimit({ name: 'ask', windowMs: 60 * 1000, max: 120 }), handle(async (req, res) => {
  const { status, body } = await errorlog.runWith(
    { route: 'POST /ask', question: (req.body || {}).question, sessionId: (req.body || {}).sessionId },
    () => chatResponse(req, null)
  );
  res.status(status).json(body);
}));

// The student portal. The session is required — without it Chipo stays
// locked and the portal asks the student to sign in again.
app.post('/portal/ask', rateLimit({ name: 'portal-ask', windowMs: 60 * 1000, max: 60, key: (req) => crypto.createHash('sha256').update(String(bearerToken(req) || req.ip)).digest('hex').slice(0, 16) }), handle(async (req, res) => {
  const student = await studentSessionFromRequest(req);
  if (!student) {
    return res.status(401).json({ error: 'Your portal session has expired. Please sign in again.' });
  }
  const { status, body } = await errorlog.runWith(
    { route: 'POST /portal/ask', question: (req.body || {}).question, sessionId: (req.body || {}).sessionId },
    () => chatResponse(req, student)
  );
  res.status(status).json(body);
}));

// ==================== Student-facing: ticket lookup ====================

app.post('/tickets', rateLimit({ name: 'tickets', windowMs: 10 * 60 * 1000, max: 20 }), handle(async (req, res) => {
  const body = req.body || {};
  const { question, answer, confidence, name, email, phone, reason, conversationSummary } = body;
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
    conversationSummary,
    conversationHistory: tickets.cleanHistory(body.conversationHistory),
  });
  res.status(201).json({ ticket: { id: ticket.id, departmentName: ticket.departmentName, status: ticket.status } });
}));

// Check a single ticket by its reference number. No login required — the
// reference itself (random, unguessable) is the credential, the same way a
// parcel tracking number works.
app.get('/tickets/:id', rateLimit({ name: 'ticket-lookup', windowMs: 60 * 1000, max: 60 }), handle(async (req, res) => {
  const ticket = await tickets.getTicket(req.params.id);
  // A ticket tied to a student account is only shown to that student, inside
  // the portal - here it looks exactly like a ticket that does not exist.
  if (!ticket || ticket.studentId) return res.status(404).json({ error: 'No ticket found with that reference.' });
  res.json({ ticket: { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt } });
}));

// ==================== Student portal ====================

app.post('/login', failedLogins({ name: 'login', account: (req) => typeof (req.body || {}).username === 'string' ? req.body.username : '' }), handle(async (req, res) => {
  const { username, password } = req.body || {};
  const [student, staff] = await Promise.all([
    studentAuth.verifyLogin(username, password),
    staffAuth.verifyLogin(username, password),
  ]);

  if (student && staff) {
    return res.status(409).json({ error: 'These credentials match more than one account. Please contact support.' });
  }
  if (student) {
    return res.json({ token: studentAuth.issueToken(student), role: 'student', student });
  }
  if (staff) {
    return res.json({ token: staffAuth.issueToken(staff), role: 'staff', staff });
  }
  return res.status(401).json({ error: 'Incorrect username or password.' });
}));

app.post('/student/login', failedLogins({ name: 'student-login', account: (req) => typeof (req.body || {}).studentNumber === 'string' ? req.body.studentNumber : '' }), handle(async (req, res) => {
  const { studentNumber, password } = req.body;
  const student = await studentAuth.verifyLogin(studentNumber, password);
  if (!student) return res.status(401).json({ error: 'Incorrect student number or password.' });
  const token = studentAuth.issueToken(student);
  res.json({ token, student });
}));

// Public self-registration endpoint for student accounts. It is enabled by
// default for the demo; set ALLOW_STUDENT_SIGNUP=false to close it and fall
// back to the create-student.js CLI.
app.post('/student/register', rateLimit({ name: 'student-register', windowMs: 60 * 60 * 1000, max: 10 }), handle(async (req, res) => {
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

// ---- Student chat memory
//
// Every route below uses requireActiveStudent and works on req.studentId - the
// id from the verified login - so a student can only ever reach their own
// messages, tickets and notifications. None of them accept an id to look up.

// The student's current conversation, so the chat survives a page refresh.
app.get('/student/chat', requireActiveStudent, handle(async (req, res) => {
  const current = await conversations.getOrCreateCurrent(req.studentId);
  const messages = await conversations.loadRecent(current.id, req.studentId, 50);
  res.json({
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
  });
}));

// "New chat": the next question starts a fresh conversation with no memory of
// the old one. The old messages stay saved.
app.post('/student/chat/new', requireActiveStudent, handle(async (req, res) => {
  await conversations.startNew(req.studentId);
  res.json({ ok: true });
}));

// ---- Student tickets and notifications

app.get('/student/tickets', requireActiveStudent, handle(async (req, res) => {
  const own = await tickets.listStudentTickets(req.studentId);
  res.json({
    tickets: own.map((ticket) => ({
      id: ticket.id,
      subject: ticket.subject || ticket.question,
      departmentName: ticket.departmentName,
      status: ticket.status,
      statusLabel: tickets.statusLabel(ticket.status),
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    })),
  });
}));

app.get('/student/notifications', requireActiveStudent, handle(async (req, res) => {
  res.json(await notifications.listForStudent(req.studentId, { limit: req.query.limit }));
}));

// Opening the bell marks everything as read. A body of { ids: [...] } marks just
// those; ids that are not this student's are ignored.
app.post('/student/notifications/read', requireActiveStudent, handle(async (req, res) => {
  const ids = req.body && req.body.ids;
  const marked = Array.isArray(ids)
    ? await notifications.markRead(req.studentId, ids)
    : await notifications.markAllRead(req.studentId);
  res.json({ marked, unreadCount: await notifications.unreadCount(req.studentId) });
}));

app.post('/student/logout', requireStudentAuth, (req, res) => {
  // Tokens are stateless — the client discards it. The endpoint exists so
  // the portal can record the sign-out in one place.
  res.json({ ok: true });
});

// ==================== Staff login ====================

app.post('/admin/login', failedLogins({ name: 'admin-login', account: (req) => typeof (req.body || {}).username === 'string' ? req.body.username : '' }), handle(async (req, res) => {
  const { username, password } = req.body;
  const staff = await staffAuth.verifyLogin(username, password);
  if (!staff) return res.status(401).json({ error: 'Incorrect username or password.' });
  const token = staffAuth.issueToken(staff);
  res.json({ token, staff });
}));

app.post('/admin/signup', rateLimit({ name: 'admin-signup', windowMs: 60 * 60 * 1000, max: 10 }), handle(async (req, res) => {
  // Anyone who can sign up as department staff can read that department's
  // tickets and change their status, which notifies students. Set
  // ALLOW_STAFF_SIGNUP=false once your staff accounts exist, and create new
  // ones from the admin dashboard or create-staff.js instead.
  if (String(process.env.ALLOW_STAFF_SIGNUP || '').toLowerCase() === 'false') {
    return res.status(403).json({ error: 'Staff sign-up is closed. Ask an administrator to create your account.' });
  }
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
  if (status && !tickets.VALID_STATUSES.includes(tickets.normalizeStatus(status))) {
    return res.status(400).json({ error: `status must be one of: ${tickets.VALID_STATUSES.join(', ')}` });
  }
  // The token only proves who logged in. Department and admin rights are read
  // from the database, so a removed or re-assigned staff member loses access
  // straight away instead of when their token expires.
  const staff = await staffAuth.getStaffProfile(req.staff.sub);
  if (!staff) return res.status(401).json({ error: 'Staff account no longer exists.' });
  res.json({ tickets: await tickets.listTickets({ status, departmentId: staff.departmentId, isAdmin: staff.isAdmin }) });
}));

app.patch('/admin/tickets/:id/status', requireStaffAuth, handle(async (req, res) => {
  const { status, note } = req.body || {};
  const staff = await staffAuth.getStaffProfile(req.staff.sub);
  if (!staff) return res.status(401).json({ error: 'Staff account no longer exists.' });
  // Forward moves only, in one transaction with the event and the student's
  // notification. Staff of another department get the same 404 as for a
  // ticket that does not exist.
  const ticket = await tickets.changeStatus({ ticketId: req.params.id, status, note, staff });
  if (!ticket) return res.status(404).json({ error: 'No ticket found with that reference.' });
  notifyTicketChange();
  mailer.ticketStatusChanged(ticket, typeof note === 'string' ? note.trim() : '').catch(() => {});
  systemLog
    .logEvent({ actor: req.staff.username, action: 'ticket.status_change', detail: `${ticket.id} -> ${ticket.status}` })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.json({ ticket });
}));

app.patch('/admin/tickets/:id/priority', requireStaffAuth, handle(async (req, res) => {
  const { priority, note } = req.body || {};
  const staff = await staffAuth.getStaffProfile(req.staff.sub);
  if (!staff) return res.status(401).json({ error: 'Staff account no longer exists.' });
  const ticket = await tickets.changePriority({ ticketId: req.params.id, priority, note, staff });
  if (!ticket) return res.status(404).json({ error: 'No ticket found with that reference.' });
  notifyTicketChange();
  systemLog
    .logEvent({ actor: req.staff.username, action: 'ticket.priority_change', detail: `${ticket.id} -> ${ticket.priority}` })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.json({ ticket });
}));

// ==================== Feedback and complaints ====================

// Anyone may rate an answer or file a complaint. A signed-in student's
// feedback is tied to their account; the public site's is anonymous.
app.post('/feedback', rateLimit({ name: 'feedback', windowMs: 10 * 60 * 1000, max: 60 }), handle(async (req, res) => {
  const body = req.body || {};
  const student = await studentSessionFromRequest(req).catch(() => null);
  const saved = await feedback.record({
    kind: body.kind,
    rating: body.rating,
    comment: body.comment,
    question: body.question,
    answer: body.answer,
    sessionId: body.sessionId,
    studentId: student ? student.id : null,
  });
  res.status(201).json({ ok: true, id: saved.id });
}));

app.get('/admin/feedback', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ feedback: await feedback.list({ kind: req.query.kind, limit: req.query.limit }) });
}));

app.patch('/admin/feedback/:id/reviewed', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const ok = await feedback.markReviewed(req.params.id);
  if (!ok) return res.status(404).json({ error: 'No feedback found with that id.' });
  res.json({ ok: true });
}));

// ==================== Admin: analytics and knowledge documents ====================

app.get('/admin/analytics', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json(await analytics.overview({ days: req.query.days }));
}));

app.get('/admin/documents', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ documents: documents.list() });
}));

app.post('/admin/documents', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const saved = documents.save({ filename: (req.body || {}).filename, data: (req.body || {}).data });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'document.upload', detail: saved.filename })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.status(201).json({ document: saved, note: 'Chipo will re-read its documents on the next question.' });
}));

app.delete('/admin/documents/:filename', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  const removed = documents.remove(req.params.filename);
  if (!removed) return res.status(404).json({ error: 'No such document.' });
  systemLog
    .logEvent({ actor: req.staff.username, action: 'document.delete', detail: req.params.filename })
    .catch((err) => console.error('Could not log system event:', err.message));
  res.json({ ok: true });
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
app.get('/admin/logs/errors', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ errors: await errorlog.list({ limit: req.query.limit, component: req.query.component }) });
}));

app.get('/admin/logs/chat', requireStaffAuth, requireAdminStaff, handle(async (req, res) => {
  res.json({ messages: await chatlog.listRecentMessages({ limit: req.query.limit }) });
}));

// Anything that reaches here threw outside a route's own handler - mostly
// bodies the JSON parser rejected. Answer in JSON and keep the stack trace
// (which names files on the server) out of the response.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request is too large.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'The request body is not valid JSON.' });
  }
  const status = err && Number.isInteger(err.status || err.statusCode) ? (err.status || err.statusCode) : 500;
  if (status >= 500) console.error('ERROR:', err);
  return res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : 'The request could not be processed.' });
});

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
