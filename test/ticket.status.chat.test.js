const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');
const ask = require('../ask.js');
const chatlog = require('../chatlog.js');
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
      assert.match(body.answer, /currently In progress/);
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
  const originalLoadHistory = chatlog.loadConversationHistory;
  const originalLogMessage = chatlog.logMessage;
  const originalAsk = ask.askQuestion;
  const originalListDepartments = departments.listDepartments;
  const originalCreateTicket = tickets.createTicket;
  const originalVerifyToken = studentAuth.verifyToken;
  const originalGetProfile = studentAuth.getStudentProfile;
  const createdTickets = [];
  const student = {
    id: 'student-1',
    studentNumber: 'BIT23220920',
    fullName: 'John Sichula',
    email: 'john@example.com',
    phone: null,
  };

  chatlog.loadConversationHistory = async () => ({
    summary: 'The student has been trying to resolve a tuition payment issue.',
    messages: [],
    turns: [
      { question: 'I paid my tuition yesterday.', answer: 'I can help with fee questions.' },
      { question: 'The payment is not showing.', answer: 'I could not confirm the payment status.' },
    ],
  });
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
    return { id: 'TCK-0123456789ABCDEF', status: 'open' };
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
      assert.match(createdTickets[0].conversationSummary, /trying to resolve a tuition payment issue/);
      assert.match(createdTickets[0].conversationSummary, /I paid my tuition yesterday/);
      assert.match(createdTickets[0].conversationSummary, /I could not confirm the payment status/);
      assert.match(body.answer, /check its status using that reference/);
    });
  } finally {
    chatlog.loadConversationHistory = originalLoadHistory;
    chatlog.logMessage = originalLogMessage;
    ask.askQuestion = originalAsk;
    departments.listDepartments = originalListDepartments;
    tickets.createTicket = originalCreateTicket;
    studentAuth.verifyToken = originalVerifyToken;
    studentAuth.getStudentProfile = originalGetProfile;
  }
});
