// Fixes found by stress testing the running server: clean errors, no stack
// traces, rate limits, a cap on simultaneous password checks, routing
// mistakes and repeat tickets.

// Set before anything loads: the password gate reads these when it is first required.
process.env.HASH_CONCURRENCY = '1';
process.env.HASH_QUEUE = '2';
delete process.env.RATE_LIMIT_DISABLED;

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { app } = require('../server.js');
const hashGate = require('../hashGate.js');
const limits = require('../ratelimit.js');
const studentAuth = require('../studentAuth.js');
const staffAuth = require('../staffAuth.js');
const tickets = require('../tickets.js');
const { resolveTicketDepartment } = require('../ticketRouting.js');

const PASSWORD = 'test-password-123';
let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter += 1)}${Math.random().toString(36).slice(2, 5)}`;

async function withServer(run, theApp = app) {
  const server = theApp.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function send(base, method, path, { body, raw, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload = raw;
  if (raw === undefined && body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const response = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* not JSON */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function makeStudent(label) {
  const student = await studentAuth.createStudent({
    studentNumber: `HRD${unique()}`.toUpperCase(), password: PASSWORD, fullName: `Hard ${label}`,
    email: `${label.toLowerCase()}.${unique()}@example.com`,
  });
  return { ...student, token: studentAuth.issueToken(student) };
}

// ---------------------------------------------------------------- bad input

test('malformed JSON gets a short JSON 400, with no stack trace or file paths', async () => {
  await withServer(async (base) => {
    const r = await send(base, 'POST', '/student/login', { raw: '{bad json', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.ok(r.json && r.json.error, 'answers in JSON');
    assert.doesNotMatch(r.text, /node_modules|\.js:\d+|SyntaxError|at JSON\.parse/);
  });
});

test('a body over the size limit gets a JSON 413', async () => {
  await withServer(async (base) => {
    const r = await send(base, 'POST', '/ask', { body: { question: 'x'.repeat(17 * 1024 * 1024) } });
    assert.equal(r.status, 413);
    assert.ok(r.json && r.json.error);
    assert.doesNotMatch(r.text, /node_modules|\.js:\d+/);
  });
});

test('requests with no body at all are refused politely, never a 500', async () => {
  await withServer(async (base) => {
    for (const path of ['/student/login', '/admin/login', '/login', '/ask', '/portal/ask', '/tickets', '/student/register', '/admin/signup']) {
      const r = await send(base, 'POST', path);
      assert.ok(r.status >= 400 && r.status < 500, `${path} gave ${r.status}`);
    }
  });
});

test('a question that is not text is a 400, and an over-long one too', async () => {
  await withServer(async (base) => {
    for (const question of [12345, { a: 1 }, ['a'], true]) {
      const r = await send(base, 'POST', '/ask', { body: { question } });
      assert.equal(r.status, 400, JSON.stringify(question));
    }
    const long = await send(base, 'POST', '/ask', { body: { question: 'fees '.repeat(2000) } });
    assert.equal(long.status, 400);
    assert.match(long.json.error, /4,000 characters/);
    const fine = await send(base, 'POST', '/ask', { body: { question: 'Where is the library?' } });
    assert.equal(fine.status, 200);
  });
});

test('ticket contact fields that are not text do not crash the server', async () => {
  await withServer(async (base) => {
    const r = await send(base, 'POST', '/tickets', { body: { question: 'help with fees', name: { a: 1 }, email: ['x'], phone: 5 } });
    assert.ok(r.status < 500, `gave ${r.status}`);
  });
});

test('responses carry safety headers and hide the framework', async () => {
  await withServer(async (base) => {
    const r = await send(base, 'GET', '/health');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(r.headers.get('referrer-policy'));
    const secure = await send(base, 'GET', '/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.ok(secure.headers.get('strict-transport-security'));
  });
});

test('the student portal page has no garbled characters', async () => {
  await withServer(async (base) => {
    const r = await send(base, 'GET', '/portal');
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /Â·|â†|â€|ðŸ/);
  });
});

// -------------------------------------------------------------- rate limits

test('guessing a password is stopped after a few failures, for that account only', async () => {
  limits.reset();
  const a = await makeStudent('Alpha');
  const b = await makeStudent('Bravo');
  await withServer(async (base) => {
    for (let i = 0; i < 8; i += 1) {
      const r = await send(base, 'POST', '/student/login', { body: { studentNumber: a.studentNumber, password: `wrong-${i}` } });
      assert.equal(r.status, 401, `try ${i + 1}`);
    }
    const blocked = await send(base, 'POST', '/student/login', { body: { studentNumber: a.studentNumber, password: PASSWORD } });
    assert.equal(blocked.status, 429, 'even the right password waits once locked out');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    const other = await send(base, 'POST', '/student/login', { body: { studentNumber: b.studentNumber, password: PASSWORD } });
    assert.equal(other.status, 200, 'another account is not affected');
  });
  limits.reset();
});

test('a successful sign-in resets that account\'s failure count', async () => {
  limits.reset();
  const s = await makeStudent('Charlie');
  await withServer(async (base) => {
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 6; i += 1) {
        const r = await send(base, 'POST', '/student/login', { body: { studentNumber: s.studentNumber, password: 'nope' } });
        assert.equal(r.status, 401);
      }
      const ok = await send(base, 'POST', '/student/login', { body: { studentNumber: s.studentNumber, password: PASSWORD } });
      assert.equal(ok.status, 200, `round ${round + 1}`);
    }
  });
  limits.reset();
});

test('staff and combined sign-in forms are throttled too', async () => {
  limits.reset();
  const staff = await staffAuth.createStaffUser(`hard_${unique()}`, PASSWORD, null);
  await withServer(async (base) => {
    for (const path of ['/admin/login', '/login']) {
      let last;
      for (let i = 0; i < 10; i += 1) {
        last = await send(base, 'POST', path, { body: { username: staff.username, password: `bad-${i}` } });
      }
      assert.equal(last.status, 429, path);
    }
  });
  limits.reset();
});

test('rateLimit counts requests per key and answers 429 with Retry-After', async () => {
  limits.reset();
  const tiny = express();
  tiny.get('/x', limits.rateLimit({ name: 'unit', windowMs: 60000, max: 3, key: (req) => req.query.who }), (req, res) => res.json({ ok: true }));
  await withServer(async (base) => {
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await send(base, 'GET', '/x?who=a')).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await send(base, 'GET', '/x?who=b')).status, 200, 'someone else is unaffected');
    process.env.RATE_LIMIT_DISABLED = 'true';
    assert.equal((await send(base, 'GET', '/x?who=a')).status, 200, 'RATE_LIMIT_DISABLED switches it off');
    delete process.env.RATE_LIMIT_DISABLED;
  }, tiny);
  limits.reset();
});

test('a flood of password checks is capped: a few run, a few wait, the rest get 503 at once', async () => {
  const hash = bcrypt.hashSync('secret', 4);
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => hashGate.compare('guess', hash)));
  const refused = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(outcomes.length - refused.length, 3, 'one running plus two waiting');
  assert.equal(refused.length, 5);
  assert.ok(refused.every((o) => o.reason.statusCode === 503));
  // and once the queue has drained, checks work normally again
  assert.equal(await hashGate.compare('secret', hash), true);
});

// ------------------------------------------------------------------ routing

const OFFICES = [
  { id: 'accounts-id', name: 'Accounts' },
  { id: 'it-id', name: 'IT Department' },
  { id: 'library-id', name: 'Library' },
  { id: 'registry-id', name: 'Registry' },
  { id: 'admissions-id', name: 'Admissions' },
  { id: 'student-affairs-id', name: 'Student Affairs' },
];

test('an office named in the question gets the ticket', () => {
  assert.equal(resolveTicketDepartment('I want to speak to a person from the IT department about my email account', OFFICES), 'it-id');
  assert.equal(resolveTicketDepartment('I want to talk to the Registry about my transcript', OFFICES), 'registry-id');
  assert.equal(resolveTicketDepartment('please ask the library about my fine', OFFICES), 'library-id');
});

test('a locked email, wifi or student account is an IT problem, not Accounts', () => {
  assert.equal(resolveTicketDepartment('my student account is locked', OFFICES), 'it-id');
  assert.equal(resolveTicketDepartment('My laptop wifi account is locked and I need IT to reset my email password', OFFICES), 'it-id');
  assert.equal(resolveTicketDepartment('my email account is not working', OFFICES), 'it-id');
});

test('money questions still go to Accounts', () => {
  assert.equal(resolveTicketDepartment('I need to pay my account balance', OFFICES), 'accounts-id');
  assert.equal(resolveTicketDepartment('when is my tuition fee due', OFFICES), 'accounts-id');
});

test('earlier messages decide the office only for a follow-up, not a new topic', () => {
  const afterFees = ['How much are the fees for BSc ICT?'];
  assert.equal(resolveTicketDepartment('and when do I pay?', OFFICES, null, afterFees), 'accounts-id');
  assert.equal(resolveTicketDepartment('what about that one?', OFFICES, null, ['I lost my library book']), 'library-id');
  assert.notEqual(resolveTicketDepartment('what is the penalty for plagiarism', OFFICES, null, afterFees), 'accounts-id');
});

// ------------------------------------------------------------ repeat tickets

test('asking the same thing again while its ticket is open gives the same ticket back', async () => {
  limits.reset();
  const student = await makeStudent('Delta');
  await withServer(async (base) => {
    const question = 'I want to speak to a person from the library about a lost book';
    const first = await send(base, 'POST', '/portal/ask', { token: student.token, body: { question } });
    const second = await send(base, 'POST', '/portal/ask', { token: student.token, body: { question } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const mine = await send(base, 'GET', '/student/tickets', { token: student.token });
    assert.equal(mine.json.tickets.length, 1, 'one ticket, not two');
    assert.match(first.json.answer, new RegExp(mine.json.tickets[0].id));
    assert.match(second.json.answer, new RegExp(mine.json.tickets[0].id));

    // once it is resolved, the same question may open a fresh ticket
    const staff = await staffAuth.createStaffUser(`hard_${unique()}`, PASSWORD, null);
    const admin = { id: staff.id, departmentId: null, isAdmin: true };
    await tickets.changeStatus({ ticketId: mine.json.tickets[0].id, status: 'resolved', staff: admin });
    await send(base, 'POST', '/portal/ask', { token: student.token, body: { question } });
    const after = await send(base, 'GET', '/student/tickets', { token: student.token });
    assert.equal(after.json.tickets.length, 2);
  });
  limits.reset();
});

test('two different students asking the same thing each get their own ticket', async () => {
  limits.reset();
  const one = await makeStudent('Echo');
  const two = await makeStudent('Foxtrot');
  await withServer(async (base) => {
    const question = 'I want to speak to a person from the library about a lost book';
    await send(base, 'POST', '/portal/ask', { token: one.token, body: { question } });
    await send(base, 'POST', '/portal/ask', { token: two.token, body: { question } });
    const a = await send(base, 'GET', '/student/tickets', { token: one.token });
    const b = await send(base, 'GET', '/student/tickets', { token: two.token });
    assert.equal(a.json.tickets.length, 1);
    assert.equal(b.json.tickets.length, 1);
    assert.notEqual(a.json.tickets[0].id, b.json.tickets[0].id);
  });
  limits.reset();
});
