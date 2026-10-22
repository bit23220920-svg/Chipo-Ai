// Tickets being received.
//
// These two tests follow a ticket all the way to the department that has to
// act on it: a student asks something Chipo cannot answer (or asks for a
// person), a ticket is opened with the details from the portal record, and
// the ticket then shows up in that department's own staff list.
//
// The chat model is stubbed so the test is deterministic - what is being
// checked is the ticket that reaches the department, not the wording of the
// answer. The ticket itself is a real row in the database, and it is removed
// again at the end of the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');
const ask = require('../ask.js');
const staffAuth = require('../staffAuth.js');
const { query } = require('../db.js');

const DEMO_STUDENT = { studentNumber: 'BIT23220920', password: 'student1234' };
const TEST_PASSWORD = 'test-password-123';

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

/**
 * A temporary staff account for one department, so the test can look at the
 * department's own ticket list the way that department would.
 */
async function temporaryStaff(departmentName) {
  const staff = await staffAuth.createStaffUser(
    `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    TEST_PASSWORD,
    departmentName
  );
  return staff;
}

async function removeStaff(staff) {
  if (!staff) return;
  await query('DELETE FROM staff_users WHERE id = $1', [staff.id]);
}

async function removeTicket(ticketId) {
  if (!ticketId) return;
  await query('DELETE FROM tickets WHERE id = $1', [ticketId]);
}

async function loginAsStudent(base) {
  const response = await fetch(`${base}/student/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DEMO_STUDENT),
  });
  const body = await response.json();
  assert.equal(response.status, 200, 'the demo student should be able to sign in');
  return body.token;
}

async function loginAsStaff(base, staff) {
  const response = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: staff.username, password: TEST_PASSWORD }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, 'the temporary staff account should be able to sign in');
  return body.token;
}

async function listTicketsFor(base, staffToken) {
  const response = await fetch(`${base}/admin/tickets`, {
    headers: { Authorization: `Bearer ${staffToken}` },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  return body.tickets;
}

test('a question Chipo cannot answer arrives with the department as a ticket', async () => {
  const originalAsk = ask.askQuestion;
  ask.askQuestion = async () => ({
    answer: 'I do not have the details on that one.',
    confidence: 0.31,
    needsHuman: true,
    source: 'rag',
    departmentId: null,
    access: 'student',
  });

  let staff = null;
  let ticketId = null;

  try {
    staff = await temporaryStaff('Student Affairs');

    await withServer(async (base) => {
      const studentToken = await loginAsStudent(base);

      const response = await fetch(`${base}/portal/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
        },
        body: JSON.stringify({ question: 'How do I apply for hostel accommodation?' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.needsHuman, true);
      assert.ok(body.ticket, 'the portal should open a ticket on its own');
      ticketId = body.ticket.id;
      assert.equal(body.ticket.departmentName, 'Student Affairs');
      assert.match(body.answer, new RegExp(ticketId));

      // Now the department looks at its own list, exactly as staff do.
      const staffToken = await loginAsStaff(base, staff);
      const tickets = await listTicketsFor(base, staffToken);
      const received = tickets.find((ticket) => ticket.id === ticketId);

      assert.ok(received, 'the ticket should be in the department list');
      assert.equal(received.name, 'John Sichula');
      assert.equal(received.email, 'john.sichula@student.unilus.edu.zm');
      assert.equal(received.phone, '+260 977 000 000');
      assert.equal(received.question, 'How do I apply for hostel accommodation?');
      assert.equal(received.status, 'open');
      assert.equal(received.reason, 'low_confidence');
      assert.equal(received.departmentName, 'Student Affairs');
    });
  } finally {
    ask.askQuestion = originalAsk;
    await removeTicket(ticketId);
    await removeStaff(staff);
  }
});

test('asking for a person arrives with the department as a ticket', async () => {
  // A ticket request must never reach the model, so this stub fails the test
  // if it is ever called.
  const originalAsk = ask.askQuestion;
  ask.askQuestion = async () => {
    throw new Error('the model should not be called for a ticket request');
  };

  let staff = null;
  let ticketId = null;

  try {
    staff = await temporaryStaff('Accounts');

    await withServer(async (base) => {
      const studentToken = await loginAsStudent(base);

      const response = await fetch(`${base}/portal/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
        },
        body: JSON.stringify({ question: 'I need to open a support ticket about my fee payment' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.needsHuman, true);
      assert.ok(body.ticket, 'asking for a person should open a ticket');
      ticketId = body.ticket.id;
      assert.equal(body.ticket.departmentName, 'Accounts');
      assert.match(body.answer, new RegExp(ticketId));

      const staffToken = await loginAsStaff(base, staff);
      const tickets = await listTicketsFor(base, staffToken);
      const received = tickets.find((ticket) => ticket.id === ticketId);

      assert.ok(received, 'the ticket should be in the department list');
      assert.equal(received.name, 'John Sichula');
      assert.equal(received.email, 'john.sichula@student.unilus.edu.zm');
      assert.equal(received.question, 'I need to open a support ticket about my fee payment');
      assert.equal(received.reason, 'manual_request');
      assert.equal(received.status, 'open');
      assert.equal(received.departmentName, 'Accounts');
    });
  } finally {
    ask.askQuestion = originalAsk;
    await removeTicket(ticketId);
    await removeStaff(staff);
  }
});
