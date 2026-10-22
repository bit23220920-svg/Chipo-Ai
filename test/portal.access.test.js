const test = require('node:test');
const assert = require('node:assert/strict');
const portalAccess = require('../portalAccess.js');
const ask = require('../ask.js');
const askModule = require('../ask.js');
const studentAuth = require('../studentAuth.js');
const { app } = require('../server.js');

const demoStudent = {
  id: 'student-1',
  studentNumber: 'BIT23220920',
  fullName: 'John Sichula',
  role: 'Basic student',
  programme: 'BSc Computer Science',
  faculty: 'School of Technology and Social Sciences',
  yearOfStudy: 'Year 2',
  email: 'john.sichula@student.unilus.edu.zm',
  phone: null,
  status: 'Active',
};

const PERSONAL_QUESTIONS = [
  'What is my fee balance?',
  'How much do I still owe?',
  'Am I registered for this semester?',
  'Show me my results',
  'What courses am I taking?',
  'What is my account status?',
  'Have I confirmed my graduation?',
  'What is the status of my deferment application?',
  'Where can I find my timetable?',
  'What is my student number?',
  'Can you check my appeal?',
  'What exemptions am I eligible for?',
];

const GENERAL_QUESTIONS = [
  'What are the admission requirements?',
  'How much is tuition for undergraduate students?',
  'What is the code of conduct?',
  'How do I apply for a deferment?',
  'When is the graduation ceremony?',
  'What documents do I need for an exemption?',
  'Who is the dean of the school?',
  'Explain UNILUS admissions requirements',
];

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test('questions about a student\'s own records are recognised as personal', () => {
  for (const question of PERSONAL_QUESTIONS) {
    assert.equal(
      portalAccess.isPersonalPortalQuestion(question),
      true,
      `expected "${question}" to need a student session`
    );
  }
});

test('general university questions are not treated as personal', () => {
  for (const question of GENERAL_QUESTIONS) {
    assert.equal(
      portalAccess.isPersonalPortalQuestion(question),
      false,
      `expected "${question}" to stay answerable without a session`
    );
  }
});

test('the public context carries notices but no student records', () => {
  const context = portalAccess.buildPublicContext({
    announcements: [
      { title: 'Registration notice', body: 'Register on time.', category: 'Registration', publishedAt: '2026-09-18 12:08:00' },
    ],
    timetables: [{ name: 'LAW', academicYear: '2026', semester: '2' }],
    services: [{ key: 'payments', label: 'Payments', sample: { intro: 'Payments received against your student account.', facts: { 'Total paid': '6,000.00 ZMW' } } }],
  });

  assert.match(context, /Registration notice/);
  assert.match(context, /LAW/);
  assert.doesNotMatch(context, /Total paid/);
  assert.doesNotMatch(context, /BIT23220920/);
});

test('the public context keeps general service guidance but drops the records', () => {
  const context = portalAccess.buildPublicContext({
    announcements: [],
    timetables: [],
    services: [
      {
        key: 'exemptions-apply',
        label: 'Exemptions Apply',
        sample: {
          intro: 'Exemptions you may apply for.',
          publicGuide: { columns: ['Exemption type', 'Evidence required'], rows: [['Medical grounds', 'Medical report from a registered practitioner']] },
          facts: { 'My application': 'Not applied' },
          columns: ['Exemption type'],
          rows: [['Staff / staff dependant']],
        },
      },
    ],
  });

  // The general rule (what evidence each exemption needs) stays available.
  assert.match(context, /Medical report from a registered practitioner/);
  // The student's own record does not.
  assert.doesNotMatch(context, /Not applied/);
  assert.doesNotMatch(context, /Staff \/ staff dependant/);
});

test('questions the portal itself can answer are recognised', () => {
  assert.equal(portalAccess.matchesPortalTopic('When is the graduation ceremony?'), true);
  assert.equal(portalAccess.matchesPortalTopic('How do I apply for a deferment?'), true);
  assert.equal(portalAccess.matchesPortalTopic('What documents do I need for an exemption?'), true);
  assert.equal(portalAccess.matchesPortalTopic('Is there any notice about registration?'), true);
  assert.equal(portalAccess.matchesPortalTopic('Who founded the university?'), false);
});

test('the student context carries that student\'s own portal records', () => {
  const context = portalAccess.buildStudentContext({
    student: demoStudent,
    announcements: [{ title: 'Registration notice', body: 'Register on time.', category: 'Registration', publishedAt: '2026-09-18 12:08:00' }],
    timetables: [{ name: 'LAW', academicYear: '2026', semester: '2' }],
    services: [
      { key: 'payments', label: 'Payments', sample: { intro: 'Payments received.', facts: { 'Total paid': '6,000.00 ZMW' }, columns: ['Receipt'], rows: [['RCP-88214']] } },
      { key: 'home', label: 'Home', sample: null },
    ],
  });

  assert.match(context, /BIT23220920/);
  assert.match(context, /John Sichula/);
  assert.match(context, /Total paid/);
  assert.match(context, /RCP-88214/);
  assert.match(context, /Registration notice/);
});

test('student numbers are scrubbed from public answers', () => {
  const scrubbed = portalAccess.scrubIdentifiers('Your record is BIT23220920 — see the registry.');
  assert.doesNotMatch(scrubbed, /BIT23220920/);
  assert.match(scrubbed, /withheld/);
});

test('asking about your own account without a session is refused', async () => {
  const result = await askModule.askQuestion('What is my fee balance?', []);

  assert.equal(result.source, 'portal_locked');
  assert.equal(result.access, 'public');
  assert.equal(result.needsHuman, false);
  assert.match(result.answer, /sign in to the student portal/i);
});

test('the locked answer is used for every personal question without a session', async () => {
  for (const question of PERSONAL_QUESTIONS) {
    const result = await askModule.askQuestion(question, []);
    assert.equal(result.source, 'portal_locked', `expected "${question}" to be refused`);
    assert.match(result.answer, /can't reach any student records/i);
  }
});

test('application questions are handed off instead of sending people to sign in', async () => {
  const questions = [
    'I paid the application fee but never got my admission letter',
    'What is my application status?',
    'I applied last month and have not heard anything',
    'When will I receive my admission letter?',
  ];

  for (const question of questions) {
    assert.equal(portalAccess.isPreAccountQuestion(question), true, `expected "${question}" to need the hand-off form`);

    const result = await askModule.askQuestion(question, []);
    assert.equal(result.source, 'portal_pre_account', `expected "${question}" to be handed off`);
    assert.equal(result.needsHuman, true, `expected "${question}" to show the contact form`);
    assert.equal(result.access, 'public');
    assert.doesNotMatch(result.answer, /sign in to the student portal/i);
  }

  assert.equal(portalAccess.isPreAccountQuestion('How much is the application fee?'), false);
  assert.equal(portalAccess.isPreAccountQuestion('What are the admission requirements?'), false);
  assert.equal(portalAccess.isPreAccountQuestion('I applied for a deferment'), false);
  assert.equal(portalAccess.isPreAccountQuestion('What is the status of my deferment application?'), false);
});

test('the public website never gets portal access, even with a student token', async () => {
  const originalAsk = ask.askQuestion;
  const originalVerifyToken = studentAuth.verifyToken;
  const originalGetProfile = studentAuth.getStudentProfile;
  let seen = null;

  ask.askQuestion = async (question, history, options) => {
    seen = options;
    return { answer: 'I cannot reach student records.', confidence: 0, needsHuman: false, source: 'portal_locked', access: 'public' };
  };
  studentAuth.verifyToken = () => ({ sub: demoStudent.id, type: 'student' });
  studentAuth.getStudentProfile = async () => demoStudent;

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer student-token',
        },
        body: JSON.stringify({ question: 'What is my fee balance?' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.access, 'public');
      assert.equal(seen.student, null);
    });
  } finally {
    ask.askQuestion = originalAsk;
    studentAuth.verifyToken = originalVerifyToken;
    studentAuth.getStudentProfile = originalGetProfile;
  }
});

test('the portal chat answers a signed-in student and reports student access', async () => {
  const originalAsk = ask.askQuestion;
  const originalVerifyToken = studentAuth.verifyToken;
  const originalGetProfile = studentAuth.getStudentProfile;
  let seen = null;

  ask.askQuestion = async (question, history, options) => {
    seen = options;
    return { answer: 'Your account is Active and your total paid is 6,000.00 ZMW.', confidence: 0.95, needsHuman: false, source: 'portal', access: 'student' };
  };
  studentAuth.verifyToken = () => ({ sub: demoStudent.id, type: 'student' });
  studentAuth.getStudentProfile = async () => demoStudent;

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/portal/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer student-token',
        },
        body: JSON.stringify({ question: 'What is my fee balance?' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.access, 'student');
      assert.match(body.answer, /6,000\.00 ZMW/);
      assert.equal(seen.student.studentNumber, 'BIT23220920');
    });
  } finally {
    ask.askQuestion = originalAsk;
    studentAuth.verifyToken = originalVerifyToken;
    studentAuth.getStudentProfile = originalGetProfile;
  }
});

test('the portal chat needs a student session', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/portal/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is my fee balance?' }),
    });

    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /session has expired/i);
  });
});

test('a staff token does not open the portal chat', async () => {
  const originalVerifyToken = studentAuth.verifyToken;

  // studentAuth.verifyToken throws for anything that is not a student token,
  // which is exactly what happens when a staff token is replayed here.
  studentAuth.verifyToken = () => {
    const err = new Error('Not a student session.');
    err.statusCode = 401;
    throw err;
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/portal/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer staff-token',
        },
        body: JSON.stringify({ question: 'What is my fee balance?' }),
      });

      assert.equal(response.status, 401);
    });
  } finally {
    studentAuth.verifyToken = originalVerifyToken;
  }
});

test('POST /ask without a session reports public access and passes no student', async () => {
  const originalAsk = ask.askQuestion;
  let seen = null;

  ask.askQuestion = async (question, history, options) => {
    seen = options;
    return { answer: 'Tuition for undergraduates is listed in the fees guide.', confidence: 0.8, needsHuman: false, source: 'rag', access: 'public' };
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'What are the admission requirements?' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.access, 'public');
      assert.equal(seen.student, null);
    });
  } finally {
    ask.askQuestion = originalAsk;
  }
});

test('the shared chatbot only sends the session to the portal endpoint', async () => {
  await withServer(async (base) => {
    const script = await (await fetch(`${base}/chipobot.js`)).text();

    assert.match(script, /inPortal \? '\/portal\/ask' : '\/ask'/);
    assert.match(script, /inPortal && session\.token \? \{ Authorization: 'Bearer ' \+ session\.token \}/);
    assert.match(script, /setScope/);
    assert.match(script, /accessBadge/);
  });
});

test('the portal declares itself as the portal scope', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/portal`)).text();

    assert.match(html, /window\.chipo && window\.chipo\.setScope\('portal'\)/);
    assert.match(html, /window\.chipo && window\.chipo\.setSession\(data\.token, data\.student\)/);
    assert.match(html, /window\.chipo && window\.chipo\.clearSession\(\)/);
  });
});
