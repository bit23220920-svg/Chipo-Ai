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
  phone: '+260 977 000 000',
  status: 'Active',
};

const IN_SCOPE_QUESTIONS = [
  'What are the admission requirements?',
  'How much is tuition for undergraduate students?',
  'What is the code of conduct?',
  'How do I apply for a deferment?',
  'When is the graduation ceremony?',
  'What documents do I need for an exemption?',
  'Who is the dean of the school?',
  'Explain UNILUS admissions requirements',
  'How do I register for courses?',
  'What is the fee structure for the School of Technology?',
  'When does semester one start?',
  'How do I get my student ID card?',
  'What is my fee balance?',
  'Show me my results',
];

const OUT_OF_SCOPE_QUESTIONS = [
  'What is the capital of France?',
  'Write me a short poem about the rain',
  'Who won the football world cup in 1998?',
  'What is 2 + 2?',
  'Tell me a joke',
  'What is the weather in Tokyo today?',
  'Recommend me a restaurant in Lusaka',
  'How do I change a car tyre?',
];

const CONVERSATIONAL_QUESTIONS = [
  'hey',
  'hello',
  'hi there',
  'good morning',
  'how are you?',
  'how are you doing today?',
  'how have you been?',
  'thanks',
  'thank you',
  'bye',
  'help',
  'what can you do?',
  'what can you help me with?',
  'how can you help me?',
  'who are you?',
  'what do you know about the school?',
  'tell me about yourself',
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

/* ------------------------------------------------------------------ *
 * The boundary
 * ------------------------------------------------------------------ */

test('questions about the university are in scope', () => {
  for (const question of IN_SCOPE_QUESTIONS) {
    assert.equal(
      portalAccess.isInScope(question),
      true,
      `expected "${question}" to be in scope`
    );
  }
});

test('questions about anything else are out of scope', () => {
  for (const question of OUT_OF_SCOPE_QUESTIONS) {
    assert.equal(
      portalAccess.isInScope(question),
      false,
      `expected "${question}" to be out of scope`
    );
  }
});

test('an attached file is always in scope', () => {
  assert.equal(
    portalAccess.isInScope('What is in this document?', { attachments: [{ kind: 'text', text: '...' }] }),
    true
  );
});

test('greetings and simple conversation are never out of scope', () => {
  for (const question of CONVERSATIONAL_QUESTIONS) {
    assert.equal(
      portalAccess.isInScope(question),
      true,
      `expected "${question}" to be in scope`
    );
    assert.equal(
      portalAccess.isConversational(question),
      true,
      `expected "${question}" to be treated as conversation`
    );
  }
});

test('a greeting is never handed over to a department', async () => {
  const result = await askModule.askQuestion('hey', []);

  assert.notEqual(result.source, 'out_of_scope');
  assert.equal(result.needsHuman, false);
  assert.ok(result.answer.length > 0);
});

test('a question outside the boundary is refused without reaching the model', async () => {
  const result = await askModule.askQuestion('What is the capital of France?', []);

  assert.equal(result.source, 'out_of_scope');
  assert.equal(result.needsHuman, false);
  assert.equal(result.confidence, 0);
  assert.match(result.answer, /not really my area/i);
  assert.match(result.answer, /University of Lusaka/i);
});

test('the boundary is the same inside the portal', async () => {
  const result = await askModule.askQuestion('Write me a poem about the rain', [], {
    student: demoStudent,
  });

  assert.equal(result.source, 'out_of_scope');
  assert.equal(result.access, 'student');
  assert.match(result.answer, /not really my area/i);
});

test('an out of scope question is not a portal question', () => {
  assert.equal(ask.isOutOfScope('What is the capital of France?'), true);
  assert.equal(ask.isOutOfScope('How do I apply for a deferment?'), false);
  assert.equal(
    ask.isOutOfScope('What is in this document?', { attachments: [{ kind: 'text', text: 'x' }] }),
    false
  );
});

/* ------------------------------------------------------------------ *
 * Handing over to a department
 * ------------------------------------------------------------------ */

test('a signed-in student gets a ticket opened with the details from the portal', async () => {
  const originalAsk = ask.askQuestion;
  const originalVerifyToken = studentAuth.verifyToken;
  const originalGetProfile = studentAuth.getStudentProfile;
  const originalCreateTicket = require('../tickets.js').createTicket;
  const tickets = require('../tickets.js');

  const created = [];
  ask.askQuestion = async () => ({
    answer: 'I do not have the details on that one.',
    confidence: 0.31,
    needsHuman: true,
    source: 'rag',
    departmentId: null,
    access: 'student',
  });
  studentAuth.verifyToken = () => ({ sub: demoStudent.id, type: 'student' });
  studentAuth.getStudentProfile = async () => demoStudent;
  tickets.createTicket = async (fields) => {
    created.push(fields);
    return { id: 'TCK-TEST0000000001', status: 'open', departmentName: 'Student Affairs' };
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/portal/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer student-token',
        },
        body: JSON.stringify({ question: 'How do I apply for hostel accommodation?' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.needsHuman, true);
      // The ticket was opened for the student, using the portal record.
      assert.equal(created.length, 1);
      assert.equal(created[0].name, 'John Sichula');
      assert.equal(created[0].email, 'john.sichula@student.unilus.edu.zm');
      assert.equal(created[0].phone, '+260 977 000 000');
      assert.equal(created[0].question, 'How do I apply for hostel accommodation?');
      // And the student is told the reference.
      assert.match(body.answer, /TCK-TEST0000000001/);
      assert.equal(body.ticket.id, 'TCK-TEST0000000001');
    });
  } finally {
    ask.askQuestion = originalAsk;
    studentAuth.verifyToken = originalVerifyToken;
    studentAuth.getStudentProfile = originalGetProfile;
    tickets.createTicket = originalCreateTicket;
  }
});

test('on the public site the student is asked for their contact details instead', async () => {
  const originalAsk = ask.askQuestion;
  const tickets = require('../tickets.js');
  const originalCreateTicket = tickets.createTicket;
  let created = 0;

  ask.askQuestion = async () => ({
    answer: 'I do not have the details on that one.',
    confidence: 0.31,
    needsHuman: true,
    source: 'rag',
    departmentId: null,
    access: 'public',
  });
  tickets.createTicket = async () => {
    created += 1;
    return { id: 'TCK-SHOULD-NOT-HAPPEN', status: 'open' };
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'How do I apply for hostel accommodation?' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.needsHuman, true);
      // No ticket is opened behind the student's back, and no ticket details
      // are handed out either.
      assert.equal(created, 0);
      assert.equal(body.ticket, null);
      assert.match(body.answer, /share your name and either your email address or phone number/i);
    });
  } finally {
    ask.askQuestion = originalAsk;
    tickets.createTicket = originalCreateTicket;
  }
});

test('the best effort answer is kept even when the question is handed over', async () => {
  const originalAsk = ask.askQuestion;
  const tickets = require('../tickets.js');
  const originalCreateTicket = tickets.createTicket;

  ask.askQuestion = async () => ({
    answer: 'Deferment needs a medical report.',
    confidence: 0.4,
    needsHuman: true,
    source: 'rag',
    departmentId: null,
    access: 'public',
  });
  tickets.createTicket = async () => ({ id: 'TCK-X', status: 'open' });

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'What about deferment?' }),
      });
      const body = await response.json();

      // The useful part of the answer survives.
      assert.match(body.answer, /Deferment needs a medical report/);
    });
  } finally {
    ask.askQuestion = originalAsk;
    tickets.createTicket = originalCreateTicket;
  }
});

test('the chat widget shows the sent ticket instead of the contact form', async () => {
  await withServer(async (base) => {
    const script = await (await fetch(`${base}/chipobot.js`)).text();

    assert.match(script, /meta\.ticket/);
    assert.match(script, /escalate-confirm sent/);
    assert.match(script, /ticket: data\.ticket/);
  });
});

test('a request for a person opens a ticket without asking the model', async () => {
  const originalAsk = ask.askQuestion;
  const tickets = require('../tickets.js');
  const originalCreateTicket = tickets.createTicket;
  const originalVerifyToken = studentAuth.verifyToken;
  const originalGetProfile = studentAuth.getStudentProfile;

  const created = [];
  ask.askQuestion = async () => {
    throw new Error('the model should not be called for a request for a person');
  };
  studentAuth.verifyToken = () => ({ sub: demoStudent.id, type: 'student' });
  studentAuth.getStudentProfile = async () => demoStudent;
  tickets.createTicket = async (fields) => {
    created.push(fields);
    return { id: 'TCK-TEST0000000002', status: 'open', departmentName: 'Student Affairs' };
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/portal/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer student-token',
        },
        body: JSON.stringify({ question: 'I need to speak to someone about my hostel application' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.needsHuman, true);
      assert.equal(created.length, 1);
      assert.equal(created[0].reason, 'manual_request');
      assert.equal(created[0].email, 'john.sichula@student.unilus.edu.zm');
      assert.equal(body.ticket.id, 'TCK-TEST0000000002');
    });
  } finally {
    ask.askQuestion = originalAsk;
    tickets.createTicket = originalCreateTicket;
    studentAuth.verifyToken = originalVerifyToken;
    studentAuth.getStudentProfile = originalGetProfile;
  }
});

test('a visitor who left their email in the question gets a ticket straight away', async () => {
  const originalAsk = ask.askQuestion;
  const tickets = require('../tickets.js');
  const originalCreateTicket = tickets.createTicket;

  const created = [];
  ask.askQuestion = async () => ({
    answer: 'I do not have the details on that one.',
    confidence: 0.31,
    needsHuman: true,
    source: 'rag',
    departmentId: null,
    access: 'public',
  });
  tickets.createTicket = async (fields) => {
    created.push(fields);
    return { id: 'TCK-TEST0000000003', status: 'open', departmentName: 'Accounts' };
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'What is the tuition fee for 2028? My email is jane.mutale@example.com',
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.needsHuman, true);
      // The ticket was opened for the visitor, using the email in the question.
      assert.equal(created.length, 1);
      assert.equal(created[0].email, 'jane.mutale@example.com');
      assert.equal(body.ticket.id, 'TCK-TEST0000000003');
      // The visitor is told the reference, so the contact form is not needed.
      assert.match(body.answer, /TCK-TEST0000000003/);
    });
  } finally {
    ask.askQuestion = originalAsk;
    tickets.createTicket = originalCreateTicket;
  }
});
