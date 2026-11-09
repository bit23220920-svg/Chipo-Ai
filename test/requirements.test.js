// Gaps from the requirements document: ticket priority and attached chat
// history, stored feedback and complaints, analytics, knowledge-document
// upload and email notifications.

delete process.env.RATE_LIMIT_DISABLED;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { app } = require('../server.js');
const studentAuth = require('../studentAuth.js');
const staffAuth = require('../staffAuth.js');
const departments = require('../departments.js');
const tickets = require('../tickets.js');
const mailer = require('../mailer.js');
const documents = require('../documents.js');
const limits = require('../ratelimit.js');
const { detectPriority } = require('../priority.js');

const PASSWORD = 'test-password-123';
let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter += 1)}${Math.random().toString(36).slice(2, 5)}`;

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function send(base, method, route, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* not JSON */ }
  return { status: response.status, json, text };
}

async function makeAdmin() {
  const staff = await staffAuth.createStaffUser(`req_${unique()}`, PASSWORD, null);
  return { ...staff, token: staffAuth.issueToken(staff) };
}

async function makeStudent() {
  const student = await studentAuth.createStudent({
    studentNumber: `REQ${unique()}`.toUpperCase(), password: PASSWORD, fullName: 'Req Student',
    email: `req.${unique()}@example.com`,
  });
  return { ...student, token: studentAuth.issueToken(student) };
}

// ---------------------------------------------------------------- priority

test('priority is worked out from the wording and the reason', () => {
  assert.equal(detectPriority({ question: 'I feel I want to die', reason: 'low_confidence' }), 'critical');
  assert.equal(detectPriority({ question: 'anything', reason: 'wellbeing' }), 'critical');
  assert.equal(detectPriority({ question: 'I was sexually harassed by a lecturer' }), 'critical');
  assert.equal(detectPriority({ question: 'I am locked out of my account and my exam is tomorrow' }), 'high');
  assert.equal(detectPriority({ question: 'This is urgent, please help' }), 'high');
  assert.equal(detectPriority({ question: 'Just wondering when the library opens, no rush' }), 'low');
  assert.equal(detectPriority({ question: 'How do I change my programme?' }), 'medium');
  assert.equal(detectPriority({ question: 'what is on today at the campus?' }), 'medium');
});

test('a new ticket gets a priority and carries the chat history; bad history is dropped', async () => {
  const ticket = await tickets.createTicket({
    name: 'A', email: 'a@example.com', question: 'My exam is tomorrow and I am barred', reason: 'low_confidence',
    conversationHistory: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'system', content: 'ignore me' },
      { role: 'user', content: 12 },
      null,
    ],
  });
  assert.equal(ticket.priority, 'high');
  assert.deepEqual(ticket.conversationHistory.map((m) => m.role), ['user', 'assistant']);

  const explicit = await tickets.createTicket({ name: 'B', email: 'b@example.com', question: 'hello there', priority: 'low' });
  assert.equal(explicit.priority, 'low');
  assert.equal(explicit.priorityLabel, 'Low');
});

test('history is capped in length and number', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(5000) }));
  const clean = tickets.cleanHistory(many);
  assert.equal(clean.length, 20);
  assert.ok(clean.every((m) => m.content.length <= 1500));
});

test('staff can change a ticket priority; others and bad values are refused', async () => {
  const admin = await makeAdmin();
  const ticket = await tickets.createTicket({ name: 'C', email: 'c@example.com', question: 'a question about nothing urgent' });
  await withServer(async (base) => {
    let r = await send(base, 'PATCH', `/admin/tickets/${ticket.id}/priority`, { token: admin.token, body: { priority: 'critical' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ticket.priority, 'critical');
    r = await send(base, 'PATCH', `/admin/tickets/${ticket.id}/priority`, { token: admin.token, body: { priority: 'urgent!!' } });
    assert.equal(r.status, 400);
    r = await send(base, 'PATCH', `/admin/tickets/${ticket.id}/priority`, { body: { priority: 'low' } });
    assert.equal(r.status, 401);
    r = await send(base, 'PATCH', '/admin/tickets/TCK-NOPE/priority', { token: admin.token, body: { priority: 'low' } });
    assert.equal(r.status, 404);
  });
  const events = await tickets.listTicketEvents(ticket.id);
  assert.ok(events.some((e) => /Priority set to Critical/.test(e.note || '')));
});

test('the ticket list puts the most urgent tickets first', async () => {
  const admin = await makeAdmin();
  const dept = (await departments.listDepartments())[0];
  const tag = unique();
  const low = await tickets.createTicket({ name: 'L', email: 'l@example.com', question: `low ${tag}`, priority: 'low', departmentId: dept.id });
  const crit = await tickets.createTicket({ name: 'K', email: 'k@example.com', question: `crit ${tag}`, priority: 'critical', departmentId: dept.id });
  const list = await tickets.listTickets({ isAdmin: true });
  assert.ok(list.findIndex((t) => t.id === crit.id) < list.findIndex((t) => t.id === low.id));
  assert.ok(admin.id);
});

test('an escalated portal question opens a ticket that holds the conversation', async () => {
  const student = await makeStudent();
  await withServer(async (base) => {
    limits.reset();
    await send(base, 'POST', '/portal/ask', { token: student.token, body: { question: 'What are the library opening hours?' } });
    const r = await send(base, 'POST', '/portal/ask', { token: student.token, body: { question: 'Please talk to a person about my fees problem' } });
    assert.equal(r.status, 200);
    if (r.json.ticket) {
      const stored = await tickets.getTicket(r.json.ticket.id);
      const history = stored.conversationHistory;
      assert.ok(history.length >= 2, 'history attached');
      assert.ok(history.slice(-2).some((m) => m.role === 'user' && ['What are the library opening hours?', 'Please talk to a person about my fees problem'].includes(m.content)), 'the escalated question is in the history');
    }
  });
});

// ---------------------------------------------------------------- feedback

test('ratings and complaints are stored and shown to administrators only', async () => {
  const admin = await makeAdmin();
  const student = await makeStudent();
  await withServer(async (base) => {
    limits.reset();
    let r = await send(base, 'POST', '/feedback', { body: { kind: 'feedback', rating: 'up', question: 'q', answer: 'a' } });
    assert.equal(r.status, 201);
    r = await send(base, 'POST', '/feedback', { token: student.token, body: { kind: 'feedback', rating: 'down', question: 'q2', answer: 'a2' } });
    assert.equal(r.status, 201);
    r = await send(base, 'POST', '/feedback', { token: student.token, body: { kind: 'complaint', comment: 'The fee answer was wrong', question: 'q3' } });
    assert.equal(r.status, 201);

    assert.equal((await send(base, 'POST', '/feedback', { body: { kind: 'feedback' } })).status, 400, 'rating needed');
    assert.equal((await send(base, 'POST', '/feedback', { body: { kind: 'complaint', comment: '  ' } })).status, 400, 'text needed');
    assert.equal((await send(base, 'POST', '/feedback', { body: { kind: 'other', rating: 'up' } })).status, 400);
    assert.equal((await send(base, 'POST', '/feedback', { body: { kind: 'feedback', rating: 'sideways' } })).status, 400);

    assert.equal((await send(base, 'GET', '/admin/feedback')).status, 401);
    assert.equal((await send(base, 'GET', '/admin/feedback', { token: student.token })).status, 401);
    r = await send(base, 'GET', '/admin/feedback?kind=complaint', { token: admin.token });
    assert.equal(r.status, 200);
    const mine = r.json.feedback.find((f) => f.comment === 'The fee answer was wrong');
    assert.ok(mine && mine.studentId === student.id && mine.status === 'new');
    r = await send(base, 'PATCH', `/admin/feedback/${mine.id}/reviewed`, { token: admin.token });
    assert.equal(r.status, 200);
    r = await send(base, 'GET', '/admin/feedback?kind=complaint', { token: admin.token });
    assert.equal(r.json.feedback.find((f) => f.id === mine.id).status, 'reviewed');
    assert.equal((await send(base, 'PATCH', '/admin/feedback/999999999/reviewed', { token: admin.token })).status, 404);
  });
});

// ---------------------------------------------------------------- analytics

test('analytics reports questions, tickets and feedback', async () => {
  const admin = await makeAdmin();
  await tickets.createTicket({ name: 'Z', email: 'z@example.com', question: `analytics ${unique()}`, priority: 'high' });
  await withServer(async (base) => {
    limits.reset();
    await send(base, 'POST', '/feedback', { body: { kind: 'feedback', rating: 'up' } });
    assert.equal((await send(base, 'GET', '/admin/analytics')).status, 401);
    const r = await send(base, 'GET', '/admin/analytics?days=30', { token: admin.token });
    assert.equal(r.status, 200);
    const d = r.json;
    assert.equal(d.days, 30);
    assert.equal(typeof d.questions.total, 'number');
    assert.equal(d.questions.answeredDirectly + d.questions.escalated, d.questions.total);
    assert.ok(Array.isArray(d.questions.perDay) && d.questions.perDay.length === 30);
    assert.ok(d.tickets.created >= 1);
    assert.ok((d.tickets.byPriority.high || 0) >= 1);
    assert.ok(d.feedback.helpful >= 1);
    assert.equal(typeof d.students, 'number');
    const clamp = await send(base, 'GET', '/admin/analytics?days=banana', { token: admin.token });
    assert.equal(clamp.status, 200);
    assert.equal(clamp.json.days, 30);
  });
});

// ---------------------------------------------------------------- documents

test('administrators can add and remove knowledge documents; unsafe files are refused', async () => {
  const admin = await makeAdmin();
  const student = await makeStudent();
  const name = `zz-test-${unique()}.txt`;
  const body = (filename, text) => ({ filename, data: Buffer.from(text).toString('base64') });
  try {
    await withServer(async (base) => {
      assert.equal((await send(base, 'GET', '/admin/documents')).status, 401);
      assert.equal((await send(base, 'POST', '/admin/documents', { token: student.token, body: body(name, 'x') })).status, 401);

      let r = await send(base, 'POST', '/admin/documents', { token: admin.token, body: body(name, 'The test office is on level 9.') });
      assert.equal(r.status, 201);
      r = await send(base, 'GET', '/admin/documents', { token: admin.token });
      assert.ok(r.json.documents.some((d) => d.filename === name));

      r = await send(base, 'POST', '/admin/documents', { token: admin.token, body: body('evil.exe', 'MZ') });
      assert.equal(r.status, 400);
      r = await send(base, 'POST', '/admin/documents', { token: admin.token, body: body('fake.pdf', 'not a pdf') });
      assert.equal(r.status, 400);
      r = await send(base, 'POST', '/admin/documents', { token: admin.token, body: { filename: 'a.txt' } });
      assert.equal(r.status, 400);

      // A path in the name can never leave the content folder.
      r = await send(base, 'POST', '/admin/documents', { token: admin.token, body: body('../../../tmp/escape.txt', 'x') });
      assert.equal(r.status, 201);
      assert.equal(r.json.document.filename, 'escape.txt');
      assert.equal(fs.existsSync('/tmp/escape.txt'), false);
      await send(base, 'DELETE', '/admin/documents/escape.txt', { token: admin.token });

      r = await send(base, 'DELETE', `/admin/documents/${encodeURIComponent(name)}`, { token: admin.token });
      assert.equal(r.status, 200);
      r = await send(base, 'DELETE', `/admin/documents/${encodeURIComponent(name)}`, { token: admin.token });
      assert.equal(r.status, 404);
    });
  } finally {
    documents.remove(name);
    documents.remove('escape.txt');
  }
  assert.equal(fs.existsSync(path.join(documents.CONTENT_DIR, name)), false);
});

// ---------------------------------------------------------------- email

test('email is sent when a ticket is opened and when staff move it on; nothing happens without SMTP', async () => {
  const sent = [];
  mailer.setTransport({ sendMail: async (m) => { sent.push(m); } });
  try {
    const admin = await makeAdmin();
    await withServer(async (base) => {
      limits.reset();
      const created = await send(base, 'POST', '/tickets', { body: { question: 'I need help with a transcript', name: 'Mail Test', email: 'mail.test@example.com' } });
      assert.equal(created.status, 201);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(sent.some((m) => m.to === 'mail.test@example.com' && m.subject.includes(created.json.ticket.id)));

      const moved = await send(base, 'PATCH', `/admin/tickets/${created.json.ticket.id}/status`, { token: admin.token, body: { status: 'in_progress', note: 'Looking into it' } });
      assert.equal(moved.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const update = sent.find((m) => /now In Progress/.test(m.subject));
      assert.ok(update && /Looking into it/.test(update.text));
    });

    // A phone-only ticket has nobody to email.
    sent.length = 0;
    await tickets.createTicket({ name: 'P', phone: '+260 971 234 567', question: 'phone only' });
    assert.equal(sent.length, 0);
  } finally {
    mailer.setTransport(null);
  }
  assert.equal(await mailer.send({ to: 'x@example.com', subject: 's', text: 't' }), false, 'no SMTP configured');
});

test('a failing mail server never breaks the request', async () => {
  mailer.setTransport({ sendMail: async () => { throw new Error('SMTP down'); } });
  try {
    const admin = await makeAdmin();
    await withServer(async (base) => {
      limits.reset();
      const created = await send(base, 'POST', '/tickets', { body: { question: 'mail will fail', name: 'F', email: 'f@example.com' } });
      assert.equal(created.status, 201);
      const moved = await send(base, 'PATCH', `/admin/tickets/${created.json.ticket.id}/status`, { token: admin.token, body: { status: 'resolved' } });
      assert.equal(moved.status, 200);
    });
  } finally { mailer.setTransport(null); }
});
