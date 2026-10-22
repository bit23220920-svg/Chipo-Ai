const test = require('node:test');
const assert = require('node:assert/strict');
const portalAccess = require('../portalAccess.js');
const ask = require('../ask.js');
const studentAuth = require('../studentAuth.js');
const departments = require('../departments.js');
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
  phone: '+260 977 000 000',
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

test('wellbeing messages are in scope and recognised as a crisis', () => {
  for (const question of [
    'I feel hopeless and I cannot cope',
    'I am overwhelmed with everything',
    'I want to hurt myself',
    'Sometimes I think about ending my life',
  ]) {
    assert.equal(portalAccess.isWellbeingConcern(question), true, `expected "${question}" to be a crisis`);
    assert.equal(portalAccess.scopeCheck(question).inScope, true, `expected "${question}" to stay in scope`);
  }

  assert.equal(portalAccess.isWellbeingConcern('I am stressed about my exam'), false);
});

test('vague follow-ups can be recognised without accepting unrelated subjects', () => {
  assert.equal(portalAccess.isVagueFollowUp('I have a problem'), true);
  assert.equal(portalAccess.isVagueFollowUp('help'), true);
  assert.equal(portalAccess.isVagueFollowUp('What is the capital of France?'), false);
  assert.equal(portalAccess.scopeCheck('How do I pay?').inScope, true);
});

test('a wellbeing message opens an urgent ticket to Student Affairs, not another office', async () => {
  const originalAsk = ask.askQuestion;
  const originalCreateTicket = require('../tickets.js').createTicket;
  const originalVerifyToken = studentAuth.verifyToken;
  const originalGetProfile = studentAuth.getStudentProfile;
  const created = [];

  ask.askQuestion = async () => ({
    answer: 'I am really glad you told me. You do not have to carry this alone.',
    confidence: 0.4,
    needsHuman: true,
    source: 'rag',
    departmentId: null,
    access: 'student',
  });
  studentAuth.verifyToken = () => ({ sub: demoStudent.id, type: 'student' });
  studentAuth.getStudentProfile = async () => demoStudent;
  require('../tickets.js').createTicket = async (fields) => {
    created.push(fields);
    return { id: 'TCK-WELLBEING0001', status: 'open', departmentName: 'Student Affairs' };
  };

  try {
    const offices = await departments.listDepartments();
    const studentAffairs = offices.find((department) => /student affairs/i.test(department.name));
    assert.ok(studentAffairs, 'Student Affairs should exist in the seeded departments');

    await withServer(async (base) => {
      const response = await fetch(`${base}/portal/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer student-token',
        },
        body: JSON.stringify({ question: 'I feel hopeless and cannot cope with my exams' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.needsHuman, true);
      assert.equal(created.length, 1);
      assert.equal(created[0].reason, 'wellbeing');
      assert.equal(created[0].departmentId, studentAffairs.id);
      assert.equal(body.ticket.departmentName, 'Student Affairs');
      assert.match(body.answer, /Student Affairs/);
      assert.doesNotMatch(body.answer, /wasn't completely sure/i);
    });
  } finally {
    ask.askQuestion = originalAsk;
    require('../tickets.js').createTicket = originalCreateTicket;
    studentAuth.verifyToken = originalVerifyToken;
    studentAuth.getStudentProfile = originalGetProfile;
  }
});
