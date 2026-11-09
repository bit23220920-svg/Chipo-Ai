// A signed-in student's own records are answered directly from those records,
// with no language model; the public site never gets them.

process.env.RATE_LIMIT_DISABLED = 'true';
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');
const studentAuth = require('../studentAuth.js');
const studentPortal = require('../studentPortal.js');
const { answerFromRecords } = require('../portalAnswers.js');

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter += 1)}${Math.random().toString(36).slice(2, 5)}`;

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function ask(base, question, token) {
  const r = await fetch(`${base}${token ? '/portal/ask' : '/ask'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ question }),
  });
  return r.json();
}

async function makeStudent(extra = {}) {
  const s = await studentAuth.createStudent({
    studentNumber: `PAN${unique()}`.toUpperCase(), password: 'test-password-123', fullName: 'Pan Student',
    email: `pan.${unique()}@example.com`, phone: '+260 955 111 222', ...extra,
  });
  return { ...s, token: studentAuth.issueToken(s) };
}

const CASES = [
  ['what are my courses', /Introduction to Programming \(BIT101\)[\s\S]*Database Systems \(BIT103\)/],
  ['which courses am I registered for', /Computer Networks/],
  ['how many credits do I have', /19 credits/],
  ['what is my balance', /ZMW 15,150\.00/],
  ['how much do I owe', /outstanding balance is ZMW 15,150\.00/],
  ['what are my fees', /Tuition fee[\s\S]*18,500\.00/],
  ['what have I paid', /RCP-88214[\s\S]*3,350\.00/],
  ['who is my lecturer for Database Systems', /Mr\. C\. Mutale/],
  ['what is my email', /@example\.com/],
  ['what is my phone number', /\+260 955 111 222/],
  ['do I have any appeals', /APL-2026-0142/],
  ['what is my graduation status', /Not yet confirmed[\s\S]*Accounts Office: Outstanding/],
];

test('questions about the student\'s own records are answered from the records, with no model', async () => {
  const student = await makeStudent();
  await withServer(async (base) => {
    for (const [question, expected] of CASES) {
      const body = await ask(base, question, student.token);
      assert.equal(body.needsHuman, false, question);
      assert.equal(body.ticket, null, `${question} must not open a ticket`);
      assert.match(body.answer, expected, question);
    }
  });
});

test('the student\'s own programme and year come from their record', async () => {
  const student = await makeStudent({ programme: 'BSc Nursing', yearOfStudy: 'Year 4', faculty: 'School of Health' });
  await withServer(async (base) => {
    assert.match((await ask(base, 'what is my programme', student.token)).answer, /BSc Nursing/);
    assert.match((await ask(base, 'what year am I in', student.token)).answer, /Year 4/);
  });
});

test('one student never sees another student\'s details', async () => {
  const a = await makeStudent({ fullName: 'Alpha One', email: `alpha.${unique()}@example.com` });
  const b = await makeStudent({ fullName: 'Bravo Two', email: `bravo.${unique()}@example.com` });
  await withServer(async (base) => {
    const forB = (await ask(base, 'what is my email', b.token)).answer;
    assert.match(forB, new RegExp(b.email.replace('.', '\\.')));
    assert.doesNotMatch(forB, new RegExp(a.email.replace('.', '\\.')));
  });
});

test('the public site never gets student records, however the question is put', async () => {
  await withServer(async (base) => {
    for (const [question] of CASES) {
      const body = await ask(base, question);
      assert.doesNotMatch(body.answer, /Mutale|RCP-88214|15,150|APL-2026|BIT101|\+260 955/, question);
    }
    const answer = (await ask(base, 'what are my courses')).answer;
    assert.match(answer, /sign in/i);
  });
});

test('how-to and general questions are not answered from the records', async () => {
  const student = await makeStudent();
  await withServer(async (base) => {
    for (const question of ['how do I pay my fees', 'how do I apply at unilus', 'what is the tuition fee for BSc Information Technology']) {
      const body = await ask(base, question, student.token);
      assert.doesNotMatch(body.answer, /outstanding balance is ZMW|Registered: /, question);
    }
  });
  const payload = { student: { fullName: 'X', studentNumber: 'X1' }, services: [], announcements: [], timetables: [] };
  assert.equal(answerFromRecords('what are the fees for BSc IT', payload), null);
  assert.equal(answerFromRecords('how do I register for courses', payload), null);
  assert.equal(answerFromRecords('what are my courses', { student: null }), null);
});

test('public how-to questions are answered from the documents', async () => {
  await withServer(async (base) => {
    assert.doesNotMatch((await ask(base, 'how do I pay my fees')).answer, /sign in to the student portal/i);
    const apply = await ask(base, 'how do I apply at unilus');
    assert.equal(apply.needsHuman, false);
    assert.match(apply.answer, /apply/i);
  });
});

test('identity details are never filled in from the portal\'s sample record', async () => {
  const bare = await makeStudent();
  await withServer(async (base) => {
    for (const question of ['what is my programme', 'what year am I in', 'tell me my details']) {
      const body = await ask(base, question, bare.token);
      assert.doesNotMatch(body.answer, /Computer Science|14 March 2004|Zambian|john\.sichula|Lusaka, Zambia/i, question);
    }
    assert.match((await ask(base, 'what is my programme', bare.token)).answer, /can't see that on your portal record/);
  });
});
