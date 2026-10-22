const test = require('node:test');
const assert = require('node:assert/strict');
const studentAuth = require('../studentAuth.js');
const studentPortal = require('../studentPortal.js');
const { app } = require('../server.js');

const demoStudent = {
  id: 'student-1',
  studentNumber: 'BIT23220920',
  fullName: 'John Sichula',
  role: 'Basic student',
  programme: 'BSc Computer Science',
  faculty: 'School of Technology and Social Sciences',
  yearOfStudy: 'Year 2',
  email: null,
  phone: null,
  status: 'Active',
};

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

test('POST /student/login issues a token for valid student credentials', async () => {
  const originalVerifyLogin = studentAuth.verifyLogin;
  const originalIssueToken = studentAuth.issueToken;

  studentAuth.verifyLogin = async (studentNumber, password) =>
    studentNumber === demoStudent.studentNumber && password === 'student1234' ? demoStudent : null;
  studentAuth.issueToken = () => 'test-student-token';

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentNumber: 'BIT23220920', password: 'student1234' }),
      });

      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.token, 'test-student-token');
      assert.equal(body.student.studentNumber, 'BIT23220920');
      assert.equal(body.student.fullName, 'John Sichula');
    });
  } finally {
    studentAuth.verifyLogin = originalVerifyLogin;
    studentAuth.issueToken = originalIssueToken;
  }
});

test('POST /student/login rejects a wrong password', async () => {
  const originalVerifyLogin = studentAuth.verifyLogin;
  studentAuth.verifyLogin = async () => null;

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentNumber: 'BIT23220920', password: 'wrong' }),
      });

      assert.equal(response.status, 401);
      assert.match((await response.json()).error, /Incorrect student number or password/);
    });
  } finally {
    studentAuth.verifyLogin = originalVerifyLogin;
  }
});

test('GET /student/portal needs a student session', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/student/portal`);
    assert.equal(response.status, 401);
  });
});

test('the portal page ships the sign-in form and the shared chatbot', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/portal`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="spLoginForm"/);
    assert.match(html, /id="spStudentNumber"/);
    assert.match(html, /src="\/chipobot\.js"/);
  });
});

test('the shared stylesheet enforces the hidden attribute', async () => {
  // `.sp-login { display: grid }` outranks the browser default
  // `[hidden] { display: none }`, which left the sign-in form covering the
  // portal after a successful login.
  await withServer(async (base) => {
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });
});

test('GET /student/portal returns the dashboard payload for a signed-in student', async () => {
  const originalGetStudentProfile = studentAuth.getStudentProfile;
  const originalGetPortalData = studentPortal.getPortalData;

  studentAuth.getStudentProfile = async () => demoStudent;
  studentPortal.getPortalData = async () => ({
    profile: { studentNumber: demoStudent.studentNumber, fullName: demoStudent.fullName, role: demoStudent.role, status: demoStudent.status },
    announcements: [{ id: 'a1', title: 'Registration notice', body: 'Register.', category: 'Registration', isImportant: true, publishedAt: '2026-09-18 12:08:00' }],
    announcementCount: 12,
    timetables: [{ id: 't1', name: 'LAW', academicYear: '2026', semester: '2', url: null }],
    services: [{ key: 'home', label: 'Home' }],
  });

  try {
    await withServer(async (base) => {
      const login = await fetch(`${base}/student/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentNumber: 'BIT23220920', password: 'student1234' }),
      });
      const { token } = await login.json();

      const response = await fetch(`${base}/student/portal`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.profile.studentNumber, 'BIT23220920');
      assert.equal(body.announcements.length, 1);
      assert.equal(body.announcementCount, 12);
      assert.equal(body.timetables[0].name, 'LAW');
      assert.equal(body.services[0].label, 'Home');
    });
  } finally {
    studentAuth.getStudentProfile = originalGetStudentProfile;
    studentPortal.getPortalData = originalGetPortalData;
  }
});
