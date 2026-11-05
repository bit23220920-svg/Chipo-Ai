const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');
const ask = require('../ask.js');
const chatlog = require('../chatlog.js');
const conversations = require('../conversations.js');
const departments = require('../departments.js');
const studentAuth = require('../studentAuth.js');
const tickets = require('../tickets.js');

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

test('chat checks a ticket reference and returns its current status without calling the model', async () => {
  const originalGetTicket = tickets.getTicket;
  const originalAsk = ask.askQuestion;
  const originalLogMessage = chatlog.logMessage;
  let lookedUp = null;
  let logged = null;
  tickets.getTicket = async (id) => {
    lookedUp = id;
    return {
      id,
      status: 'in_progress',
      departmentName: 'Accounts',
      updatedAt: '2026-11-04 10:30:00',
    };
  };
  ask.askQuestion = async () => {
    throw new Error('ticket status lookups should not call the model');
  };
  chatlog.logMessage = async (message) => { logged = message; };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Can you check the status of ticket tck-0123456789abcdef?',
          sessionId: 'ticket-status-chat-test',
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(lookedUp, 'TCK-0123456789ABCDEF');
      assert.match(body.answer, /currently In Progress/);
      assert.match(body.answer, /assigned to Accounts/);
      assert.equal(body.ticket.status, 'in_progress');
      assert.equal(logged.source, 'ticket_status');
    });
  } finally {
    tickets.getTicket = originalGetTicket;
    ask.askQuestion = originalAsk;
    chatlog.logMessage = originalLogMessage;
  }
});

test('chat asks for a reference when a status lookup has no ticket number', async () => {
  const originalGetTicket = tickets.getTicket;
  const originalLogMessage = chatlog.logMessage;
  let lookedUp = false;
  tickets.getTicket = async () => { lookedUp = true; return null; };
  chatlog.logMessage = async () => {};

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Can you check my ticket status?' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.match(body.answer, /ticket reference/i);
      assert.equal(lookedUp, false);
    });
  } finally {
    tickets.getTicket = originalGetTicket;
    chatlog.logMessage = originalLogMessage;
  }
});

test('staff handover includes a summary of the recent conversation', async () => {
  const originalGetCurrent = conversations.getOrCreateCurrent;
  const originalLoadRecent = conversations.loadRecent;
  const originalSaveExchange = conversations.saveExchange;
  const originalLogMessage = chatlog.logMessage;
  const originalAsk = ask.askQuestion;
  const originalListDepartments = departments.listDepartments;
  const originalCreateTicket = tickets.createTicket;
  const originalVerifyToken = studentAuth.verifyToken;
  const originalGetProfile = studentAuth.getStudentProfile;
  const createdTickets = [];
  const saved = [];
  const student = {
    id: 'student-1',
    studentNumber: 'BIT23220920',
    fullName: 'John Sichula',
    email: 'john@example.com',
    phone: null,
  };

  // A signed-in student's history is their own conversation, last 15 messages.
  conversations.getOrCreateCurrent = async () => ({ id: 7 });
  conversations.loadRecent = async (conversationId, studentId) => {
    assert.equal(conversationId, 7);
    assert.equal(studentId, 'student-1');
    return [
      { id: 1, role: 'user', content: 'I paid my tuition yesterday.' },
      { id: 2, role: 'assistant', content: 'I can help with fee questions.' },
      { id: 3, role: 'user', content: 'The payment is not showing.' },
      { id: 4, role: 'assistant', content: 'I could not confirm the payment status.' },
    ];
  };
  conversations.saveExchange = async (exchange) => { saved.push(exchange); };
  chatlog.logMessage = async () => {};
  ask.askQuestion = async () => ({
    answer: 'I cannot see the payment in the available records.',
    confidence: 0.3,
    needsHuman: true,
    source: 'rag',
    departmentId: null,
    access: 'student',
  });
  departments.listDepartments = async () => [{ id: 'accounts-id', name: 'Accounts' }];
  tickets.createTicket = async (fields) => {
    createdTickets.push(fields);
    return { id: 'TCK-0123456789ABCDEF', status: 'opened' };
  };
  studentAuth.verifyToken = () => ({ sub: student.id, type: 'student' });
  studentAuth.getStudentProfile = async () => student;

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/portal/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          question: 'Please have someone check it.',
          sessionId: 'ticket-handover-chat-test',
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(createdTickets.length, 1);
      assert.match(createdTickets[0].conversationSummary, /Issue: Please have someone check it\./);
      assert.match(createdTickets[0].conversationSummary, /I paid my tuition yesterday/);
      assert.match(createdTickets[0].conversationSummary, /I could not confirm the payment status/);
      assert.match(body.answer, /check its status using that reference/);
      // The ticket belongs to the signed-in student, so its status changes can
      // reach them as notifications.
      assert.equal(createdTickets[0].studentId, 'student-1');
      // And the exchange was saved to that student's conversation.
      assert.equal(saved.length, 1);
      assert.equal(saved[0].studentId, 'student-1');
      assert.equal(saved[0].question, 'Please have someone check it.');
    });
  } finally {
    conversations.getOrCreateCurrent = originalGetCurrent;
    conversations.loadRecent = originalLoadRecent;
    conversations.saveExchange = originalSaveExchange;
    chatlog.logMessage = originalLogMessage;
    ask.askQuestion = originalAsk;
    departments.listDepartments = originalListDepartments;
    tickets.createTicket = originalCreateTicket;
    studentAuth.verifyToken = originalVerifyToken;
    studentAuth.getStudentProfile = originalGetProfile;
  }
});
