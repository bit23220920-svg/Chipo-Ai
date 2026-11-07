const test = require('node:test');
const assert = require('node:assert/strict');
const studentAuth = require('../studentAuth.js');
const staffAuth = require('../staffAuth.js');
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

test('POST /login routes valid student credentials to the student portal', async () => {
  const originalStudentVerify = studentAuth.verifyLogin;
  const originalStudentIssue = studentAuth.issueToken;
  const originalStaffVerify = staffAuth.verifyLogin;

  studentAuth.verifyLogin = async () => demoStudent;
  studentAuth.issueToken = () => 'test-student-token';
  staffAuth.verifyLogin = async () => null;

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'BIT23220920', password: 'student1234' }),
      });

      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.role, 'student');
      assert.equal(body.token, 'test-student-token');
      assert.equal(body.student.studentNumber, 'BIT23220920');
    });
  } finally {
    studentAuth.verifyLogin = originalStudentVerify;
    studentAuth.issueToken = originalStudentIssue;
    staffAuth.verifyLogin = originalStaffVerify;
  }
});

test('POST /login routes valid staff credentials to the staff portal', async () => {
  const originalStudentVerify = studentAuth.verifyLogin;
  const originalStaffVerify = staffAuth.verifyLogin;
  const originalStaffIssue = staffAuth.issueToken;
  const demoStaff = { id: 'staff-1', username: 'fees.staff', isAdmin: false };

  studentAuth.verifyLogin = async () => null;
  staffAuth.verifyLogin = async () => demoStaff;
  staffAuth.issueToken = () => 'test-staff-token';

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'fees.staff', password: 'staff1234' }),
      });

      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.role, 'staff');
      assert.equal(body.token, 'test-staff-token');
      assert.equal(body.staff.username, 'fees.staff');
    });
  } finally {
    studentAuth.verifyLogin = originalStudentVerify;
    staffAuth.verifyLogin = originalStaffVerify;
    staffAuth.issueToken = originalStaffIssue;
  }
});

test('POST /login rejects credentials shared by student and staff accounts', async () => {
  const originalStudentVerify = studentAuth.verifyLogin;
  const originalStaffVerify = staffAuth.verifyLogin;

  studentAuth.verifyLogin = async () => demoStudent;
  staffAuth.verifyLogin = async () => ({ id: 'staff-1', username: 'BIT23220920' });

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'BIT23220920', password: 'same-password' }),
      });

      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /match more than one account/);
    });
  } finally {
    studentAuth.verifyLogin = originalStudentVerify;
    staffAuth.verifyLogin = originalStaffVerify;
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

test('the public site offers one login form for both portal types', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(base)).text();

    assert.match(html, /<h1>Login<\/h1>/);
    assert.match(html, /<label for="portalUsername">Username<\/label>/);
    assert.match(html, /fetch\('\/login'/);
    assert.doesNotMatch(html, /Student portal login|Staff login/);
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
