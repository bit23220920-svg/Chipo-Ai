// Why a question failed: model failures, fallbacks and server errors are
// written to the error log, with the question and without any secret.

delete process.env.RATE_LIMIT_DISABLED;

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');
const ask = require('../ask.js');
const llm = require('../llm.js');
const errorlog = require('../errorlog.js');
const staffAuth = require('../staffAuth.js');
const studentAuth = require('../studentAuth.js');
const limits = require('../ratelimit.js');

const FAKE_KEY = 'gsk_test_key_do_not_log_123456';
const realFetch = global.fetch;
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test('secrets are removed from anything written to the log', () => {
  const text = `fetch failed https://x/v1?key=AIzaSyA1234567890abcdefghijklmnop and ${FAKE_KEY} and Bearer abcdefghijklmnop123 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstu`;
  const clean = errorlog.scrub(text);
  assert.doesNotMatch(clean, /AIzaSy|gsk_test|abcdefghijklmnop123|eyJhbGci/);
  assert.match(clean, /\[hidden\]/);
});

test('a Groq failure is logged with the question, the status and no key', async () => {
  const question = `What are the tuition fees for BSc Information Technology? ${unique()}`;
  process.env.GROQ_API_KEY = FAKE_KEY;
  delete process.env.GEMINI_API_KEY;
  llm.resetGroqCooldown();
  global.fetch = async (url, init) => (String(url).includes('api.groq.com')
    ? new Response(JSON.stringify({ error: { message: `Invalid API Key ${FAKE_KEY}` } }), { status: 401 })
    : realFetch(url, init));
  try {
    const student = await studentAuth.createStudent({ studentNumber: `ERR${unique()}`.toUpperCase(), password: 'test-password-123', fullName: 'Err Student', email: `e.${unique()}@example.com` });
    const token = studentAuth.issueToken(student);
    await withServer(async (base) => {
      limits.reset();
      const r = await send(base, 'POST', '/portal/ask', { token, body: { question } });
      assert.equal(r.status, 200, 'the student still gets an answer');
      await settle();
    });
  } finally {
    global.fetch = realFetch;
    delete process.env.GROQ_API_KEY;
    llm.resetGroqCooldown();
  }
  const entries = await errorlog.list({ limit: 200 });
  const groq = entries.find((e) => e.component === 'groq' && e.question && e.question.startsWith(question.slice(0, 50)) && e.question.includes(question.slice(-8)));
  assert.ok(groq, 'the Groq failure is on record');
  assert.equal(groq.statusCode, 401);
  assert.match(groq.message, /Groq 401/);
  assert.equal(groq.route, 'POST /portal/ask');
  assert.doesNotMatch(JSON.stringify(entries), /gsk_test_key/);
});

test('record() works outside a request and never throws, even for odd input', async () => {
  await errorlog.record({ component: 'test', kind: 'unit', error: new Error('boom'), question: 'q'.repeat(2000) });
  await errorlog.record({});
  await errorlog.record({ component: 'test', error: 'a plain string' });
  const entries = await errorlog.list({ limit: 20, component: 'test' });
  assert.ok(entries.some((e) => e.message === 'boom' && e.question.length === 500));
  assert.ok(entries.some((e) => e.message === 'a plain string'));
});

test('only administrators can read the error log, and the analytics count it', async () => {
  const staff = await staffAuth.createStaffUser(`err_${unique()}`, 'test-password-123', null);
  const token = staffAuth.issueToken(staff);
  const student = await studentAuth.createStudent({ studentNumber: `ERS${unique()}`.toUpperCase(), password: 'test-password-123', fullName: 'S', email: `s.${unique()}@example.com` });
  await errorlog.record({ component: 'gemini', kind: 'model_failure', error: new Error('Gemini quota exceeded'), question: 'visible?' });
  await withServer(async (base) => {
    limits.reset();
    assert.equal((await send(base, 'GET', '/admin/logs/errors')).status, 401);
    assert.equal((await send(base, 'GET', '/admin/logs/errors', { token: studentAuth.issueToken(student) })).status, 401);
    const r = await send(base, 'GET', '/admin/logs/errors?component=gemini&limit=5', { token });
    assert.equal(r.status, 200);
    assert.ok(r.json.errors.length >= 1 && r.json.errors.every((e) => e.component === 'gemini'));
    const a = await send(base, 'GET', '/admin/analytics?days=7', { token });
    assert.ok(a.json.errors.total >= 1);
    assert.ok(a.json.errors.byComponent.gemini >= 1);
  });
});

test('an unexpected server error is recorded with its route, but the student only sees a plain message', async () => {
  const staff = await staffAuth.createStaffUser(`err_${unique()}`, 'test-password-123', null);
  const token = staffAuth.issueToken(staff);
  const db = require('../db.js');
  const original = db.query;
  // Break the database for one request only.
  const docs = require('../documents.js');
  const realList = docs.list;
  docs.list = () => { throw new Error('disk exploded at /secret/path'); };
  try {
    await withServer(async (base) => {
      const r = await send(base, 'GET', '/admin/documents', { token });
      assert.equal(r.status, 500);
      assert.equal(r.json.error, 'Something went wrong.');
      assert.doesNotMatch(r.text, /disk exploded/);
      await settle();
    });
  } finally { docs.list = realList; assert.equal(db.query, original); }
  const entries = await errorlog.list({ limit: 50, component: 'server' });
  assert.ok(entries.some((e) => /disk exploded/.test(e.message) && e.route === 'GET /admin/documents' && e.statusCode === 500));
});
