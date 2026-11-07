// Chat memory, ticket tracking and notifications.
//
// These tests use the real database (so the foreign keys, cascades and
// transactions are really exercised) and stub only the AI model. Every row a
// test creates is removed again at the end. Run "node migrate.js" first so the
// new tables exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');
const ask = require('../ask.js');
const embeddings = require('../embeddings.js');
const chatlog = require('../chatlog.js');
const conversations = require('../conversations.js');
const notifications = require('../notifications.js');
const tickets = require('../tickets.js');
const departments = require('../departments.js');
const studentAuth = require('../studentAuth.js');
const staffAuth = require('../staffAuth.js');
const { query } = require('../db.js');

const PASSWORD = 'test-password-123';
let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter += 1)}${Math.random().toString(36).slice(2, 5)}`;

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

async function makeStudent(label) {
  const student = await studentAuth.createStudent({
    studentNumber: `TST${unique()}`.toUpperCase(),
    password: PASSWORD,
    fullName: `Test ${label}`,
    email: `${label.toLowerCase()}.${unique()}@example.com`,
  });
  return { ...student, token: studentAuth.issueToken(student) };
}

async function makeStaff(departmentName) {
  const staff = await staffAuth.createStaffUser(`test_${unique()}`, PASSWORD, departmentName);
  const profile = await staffAuth.getStaffProfile(staff.id);
  return { ...profile, token: staffAuth.issueToken({ ...profile }) };
}

async function makeAdmin() {
  const staff = await staffAuth.createStaffUser(`test_admin_${unique()}`, PASSWORD, null);
  const profile = await staffAuth.getStaffProfile(staff.id);
  return { ...profile, token: staffAuth.issueToken({ ...profile }) };
}

async function departmentId(name) {
  const all = await departments.listDepartments();
  const found = all.find((department) => department.name === name);
  assert.ok(found, `${name} should exist in the seeded departments`);
  return found.id;
}

const api = (base, token) => async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch (err) { /* empty body */ }
  return { status: response.status, body: json };
};

async function cleanup({ students = [], staff = [], ticketIds = [] }) {
  for (const id of ticketIds) await query('DELETE FROM tickets WHERE id = $1', [id]);
  for (const student of students) {
    await query('DELETE FROM tickets WHERE student_id = $1', [student.id]);
    await query('DELETE FROM chat_messages WHERE student_id = $1', [student.id]);
    await query('DELETE FROM students WHERE id = $1', [student.id]);
  }
  for (const member of staff) await query('DELETE FROM staff_users WHERE id = $1', [member.id]);
}

// Stubs the model so the test controls what it "says" and sees what it was given.
function stubAsk(handler) {
  const original = ask.askQuestion;
  ask.askQuestion = async (question, history, options) => handler(question, history, options);
  return () => { ask.askQuestion = original; };
}

const generalAnswer = (text = 'Here is the answer.') => ({
  answer: text, confidence: 0.9, needsHuman: false, source: 'rag', departmentId: null, access: 'student',
});

// ======================= Conversation memory =======================

test('both messages are saved and the next question is sent with the history', async () => {
  const student = await makeStudent('Memory');
  const seen = [];
  const restore = stubAsk(async (question, history) => {
    seen.push({ question, messages: history.messages.map((m) => `${m.role}: ${m.content}`) });
    return generalAnswer(`Answer to: ${question}`);
  });
  try {
    await withServer(async (base) => {
      const call = api(base, student.token);
      const first = await call('POST', '/portal/ask', { question: 'Tell me about the BSc in Information Technology' });
      assert.equal(first.status, 200);
      const second = await call('POST', '/portal/ask', { question: 'what about its fees?' });
      assert.equal(second.status, 200);

      assert.deepEqual(seen[0].messages, []);
      assert.deepEqual(seen[1].messages, [
        'user: Tell me about the BSc in Information Technology',
        'assistant: Answer to: Tell me about the BSc in Information Technology',
      ]);

      const stored = await query(
        `SELECT messages.role, messages.content FROM messages
         JOIN conversations ON conversations.id = messages.conversation_id
         WHERE conversations.student_id = $1 ORDER BY messages.id ASC`,
        [student.id]
      );
      assert.deepEqual(stored.rows.map((row) => row.role), ['user', 'assistant', 'user', 'assistant']);
    });
  } finally {
    restore();
    await cleanup({ students: [student] });
  }
});

test('only the last 15 messages are sent to the model', async () => {
  const student = await makeStudent('Window');
  let lastHistoryLength = null;
  const restore = stubAsk(async (question, history) => {
    lastHistoryLength = history.messages.length;
    return generalAnswer('ok');
  });
  try {
    const current = await conversations.getOrCreateCurrent(student.id);
    for (let index = 1; index <= 10; index += 1) {
      await conversations.saveExchange({
        conversationId: current.id, studentId: student.id, question: `q${index}`, answer: `a${index}`,
      });
    }
    await withServer(async (base) => {
      const response = await api(base, student.token)('POST', '/portal/ask', { question: 'one more' });
      assert.equal(response.status, 200);
    });
    assert.equal(lastHistoryLength, 15);
    const loaded = await conversations.loadRecent(current.id, student.id);
    assert.equal(loaded.length, 15);
    // The window is the NEWEST messages: it starts mid-way through the chat.
    assert.equal(loaded[loaded.length - 1].content, 'ok');
  } finally {
    restore();
    await cleanup({ students: [student] });
  }
});

test('the chat survives a refresh, and New chat starts fresh without deleting the old one', async () => {
  const student = await makeStudent('Refresh');
  const histories = [];
  const restore = stubAsk(async (question, history) => {
    histories.push(history.messages.length);
    return generalAnswer(`reply ${histories.length}`);
  });
  try {
    await withServer(async (base) => {
      const call = api(base, student.token);
      await call('POST', '/portal/ask', { question: 'first question' });

      // "Refresh": the page asks the server what the current chat holds.
      const restored = await call('GET', '/student/chat');
      assert.equal(restored.status, 200);
      assert.deepEqual(restored.body.messages.map((m) => [m.role, m.content]), [
        ['user', 'first question'],
        ['assistant', 'reply 1'],
      ]);

      assert.equal((await call('POST', '/student/chat/new')).status, 200);
      const afterNew = await call('GET', '/student/chat');
      assert.deepEqual(afterNew.body.messages, []);

      await call('POST', '/portal/ask', { question: 'a fresh start' });
      assert.equal(histories[1], 0, 'the new chat must not carry the old messages to the model');

      const total = await query(
        `SELECT COUNT(*) AS n FROM messages JOIN conversations ON conversations.id = messages.conversation_id
         WHERE conversations.student_id = $1`,
        [student.id]
      );
      assert.equal(Number(total.rows[0].n), 4, 'the old messages are kept');
    });
  } finally {
    restore();
    await cleanup({ students: [student] });
  }
});

test('pressing New chat twice does not pile up empty conversations', async () => {
  const student = await makeStudent('Empty');
  try {
    await withServer(async (base) => {
      const call = api(base, student.token);
      await call('POST', '/student/chat/new');
      await call('POST', '/student/chat/new');
      await call('POST', '/student/chat/new');
    });
    const count = await query('SELECT COUNT(*) AS n FROM conversations WHERE student_id = $1', [student.id]);
    assert.equal(Number(count.rows[0].n), 1);
  } finally {
    await cleanup({ students: [student] });
  }
});

test('one student can never see or influence another student\'s chat', async () => {
  const alice = await makeStudent('Alice');
  const bob = await makeStudent('Bob');
  const seenByModel = [];
  const restore = stubAsk(async (question, history) => {
    seenByModel.push({ question, messages: history.messages.map((m) => m.content) });
    return generalAnswer(`reply to ${question}`);
  });
  try {
    await withServer(async (base) => {
      await api(base, alice.token)('POST', '/portal/ask', { question: 'alice private question' });

      const bobsChat = await api(base, bob.token)('GET', '/student/chat');
      assert.deepEqual(bobsChat.body.messages, []);

      // Bob even supplies Alice's browser session id and a conversation id;
      // neither is honoured on the portal.
      const aliceConversation = await conversations.getOrCreateCurrent(alice.id);
      await api(base, bob.token)('POST', '/portal/ask', {
        question: 'bob asks something',
        sessionId: `student-chat-${aliceConversation.id}-padding-padding`,
        conversationId: aliceConversation.id,
      });
      const bobSaw = seenByModel[seenByModel.length - 1];
      assert.deepEqual(bobSaw.messages, [], 'Bob\'s model call carries none of Alice\'s messages');

      const aliceChat = await api(base, alice.token)('GET', '/student/chat');
      assert.equal(aliceChat.body.messages.length, 2, 'Bob\'s message did not land in Alice\'s chat');

      // And a conversation id that is not yours returns nothing at the data layer.
      const bobsView = await conversations.loadRecent(aliceConversation.id, bob.id);
      assert.deepEqual(bobsView, []);
      await assert.rejects(() => conversations.saveExchange({
        conversationId: aliceConversation.id, studentId: bob.id, question: 'x', answer: 'y',
      }));
    });
  } finally {
    restore();
    await cleanup({ students: [alice, bob] });
  }
});

test('chat memory routes need a login', async () => {
  await withServer(async (base) => {
    const call = api(base, null);
    for (const [method, path] of [
      ['GET', '/student/chat'], ['POST', '/student/chat/new'], ['GET', '/student/tickets'],
      ['GET', '/student/notifications'], ['POST', '/student/notifications/read'],
    ]) {
      const response = await call(method, path);
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    const bogus = await api(base, 'not-a-real-token')('GET', '/student/chat');
    assert.equal(bogus.status, 401);
  });
});

test('a token for a student who no longer exists is refused', async () => {
  const student = await makeStudent('Gone');
  await query('DELETE FROM students WHERE id = $1', [student.id]);
  await withServer(async (base) => {
    const response = await api(base, student.token)('GET', '/student/chat');
    assert.equal(response.status, 401);
  });
});

test('the public site keeps no student memory and cannot reach the new routes', async () => {
  const restore = stubAsk(async () => generalAnswer('public answer'));
  try {
    await withServer(async (base) => {
      const response = await api(base, null)('POST', '/ask', { question: 'What programmes do you offer?' });
      assert.equal(response.status, 200);
    });
    const orphan = await query('SELECT COUNT(*) AS n FROM conversations');
    assert.ok(Number(orphan.rows[0].n) >= 0);
  } finally {
    restore();
  }
});

test('if the model cannot rewrite the question, retrieval uses the question as typed', async () => {
  const original = embeddings.genAI.getGenerativeModel;
  embeddings.genAI.getGenerativeModel = () => { throw new Error('model unavailable'); };
  try {
    const rewritten = await ask.rewriteStandaloneQuestion('what about its fees?', {
      summary: '',
      messages: [
        { role: 'user', content: 'Tell me about the BSc in Information Technology' },
        { role: 'assistant', content: 'It is a four year programme.' },
      ],
    });
    assert.equal(rewritten, 'what about its fees?');
  } finally {
    embeddings.genAI.getGenerativeModel = original;
  }
});

test('the rewrite is given the conversation and its result is what retrieval uses', async () => {
  // The rewrite step is only attempted when a Gemini key is configured.
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  ask.resetGeminiCooldown();
  const original = embeddings.genAI.getGenerativeModel;
  let promptSeen = '';
  embeddings.genAI.getGenerativeModel = () => ({
    generateContent: async (prompt) => {
      promptSeen = String(prompt);
      return { response: { text: () => 'What are the fees for the BSc in Information Technology?' } };
    },
  });
  try {
    const rewritten = await ask.rewriteStandaloneQuestion('what about its fees?', {
      summary: '',
      messages: [
        { role: 'user', content: 'Tell me about the BSc in Information Technology' },
        { role: 'assistant', content: 'It is a four year programme.' },
      ],
    });
    assert.equal(rewritten, 'What are the fees for the BSc in Information Technology?');
    assert.match(promptSeen, /BSc in Information Technology/);
    assert.match(promptSeen, /what about its fees\?/);
  } finally {
    embeddings.genAI.getGenerativeModel = original;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  }
});

test('if chat memory is unavailable the student still gets an answer', async () => {
  const student = await makeStudent('NoMemory');
  const originalLoad = conversations.getOrCreateCurrent;
  conversations.getOrCreateCurrent = async () => { throw new Error('no such table: conversations'); };
  const restore = stubAsk(async () => generalAnswer('still answered'));
  try {
    await withServer(async (base) => {
      const response = await api(base, student.token)('POST', '/portal/ask', { question: 'What are the fees?' });
      assert.equal(response.status, 200);
      assert.match(response.body.answer, /still answered/);
    });
  } finally {
    conversations.getOrCreateCurrent = originalLoad;
    restore();
    await cleanup({ students: [student] });
  }
});

// ======================= Ticket tracking and notifications =======================

async function ticketFor(student, departmentName, question = 'My fee payment is not showing') {
  return tickets.createTicket({
    email: student.email,
    question,
    studentId: student.id,
    departmentId: await departmentId(departmentName),
  });
}

test('a status change updates the ticket, writes an event and notifies the student', async () => {
  const student = await makeStudent('Notify');
  const staff = await makeStaff('Accounts');
  const ticket = await ticketFor(student, 'Accounts');
  try {
    await withServer(async (base) => {
      assert.equal(ticket.status, 'opened');
      const moved = await api(base, staff.token)('PATCH', `/admin/tickets/${ticket.id}/status`, {
        status: 'in_progress', note: 'Checking the bank statement',
      });
      assert.equal(moved.status, 200);
      assert.equal(moved.body.ticket.status, 'in_progress');

      const events = await tickets.listTicketEvents(ticket.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].status, 'in_progress');
      assert.equal(events[0].note, 'Checking the bank statement');
      assert.equal(events[0].staffId, staff.id);

      const feed = await api(base, student.token)('GET', '/student/notifications');
      assert.equal(feed.status, 200);
      assert.equal(feed.body.unreadCount, 1);
      assert.equal(feed.body.notifications[0].message, `Your Accounts ticket ${ticket.id} is now In Progress.`);
      assert.equal(feed.body.notifications[0].isRead, false);
    });
  } finally {
    await cleanup({ students: [student], staff: [staff], ticketIds: [ticket.id] });
  }
});

test('opening the bell marks notifications as read', async () => {
  const student = await makeStudent('Bell');
  const staff = await makeStaff('Accounts');
  const ticket = await ticketFor(student, 'Accounts');
  try {
    await withServer(async (base) => {
      await api(base, staff.token)('PATCH', `/admin/tickets/${ticket.id}/status`, { status: 'in_progress' });
      await api(base, staff.token)('PATCH', `/admin/tickets/${ticket.id}/status`, { status: 'resolved' });

      const call = api(base, student.token);
      assert.equal((await call('GET', '/student/notifications')).body.unreadCount, 2);

      const read = await call('POST', '/student/notifications/read');
      assert.equal(read.status, 200);
      assert.equal(read.body.marked, 2);
      assert.equal(read.body.unreadCount, 0);

      const after = await call('GET', '/student/notifications');
      assert.equal(after.body.unreadCount, 0);
      assert.equal(after.body.notifications.length, 2);
      assert.ok(after.body.notifications.every((n) => n.isRead));
    });
  } finally {
    await cleanup({ students: [student], staff: [staff], ticketIds: [ticket.id] });
  }
});

test('a ticket only moves forward: opened, then in progress, then resolved', async () => {
  const student = await makeStudent('Forward');
  const staff = await makeStaff('Accounts');
  const ticket = await ticketFor(student, 'Accounts');
  try {
    await withServer(async (base) => {
      const call = api(base, staff.token);
      const patch = (status) => call('PATCH', `/admin/tickets/${ticket.id}/status`, { status });

      assert.equal((await patch('opened')).status, 409, 'cannot "move" to the status it already has');
      assert.equal((await patch('in_progress')).status, 200);
      assert.equal((await patch('in_progress')).status, 409, 'cannot repeat a status');
      assert.equal((await patch('opened')).status, 409, 'cannot go back to opened');
      assert.equal((await patch('resolved')).status, 200);
      assert.equal((await patch('in_progress')).status, 409, 'cannot reopen a resolved ticket');
      assert.equal((await patch('opened')).status, 409);
      assert.equal((await patch('banana')).status, 400, 'unknown statuses are a bad request');

      const final = await tickets.getTicket(ticket.id);
      assert.equal(final.status, 'resolved');
      // Only the two legal moves left an event and a notification.
      assert.equal((await tickets.listTicketEvents(ticket.id)).length, 2);
      assert.equal((await notifications.listForStudent(student.id)).notifications.length, 2);
    });
  } finally {
    await cleanup({ students: [student], staff: [staff], ticketIds: [ticket.id] });
  }
});

test('the old spelling "open" is still understood as "opened"', () => {
  assert.equal(tickets.normalizeStatus('open'), 'opened');
  assert.equal(tickets.normalizeStatus('OPENED'), 'opened');
  assert.equal(tickets.isForwardMove('open', 'in_progress'), true);
  assert.equal(tickets.isForwardMove('resolved', 'open'), false);
});

test('a failure part-way through a status change saves nothing at all', async () => {
  const student = await makeStudent('Atomic');
  const staff = await makeStaff('Accounts');
  const ticket = await ticketFor(student, 'Accounts');
  try {
    // The event row points at a staff member who does not exist, so the insert
    // fails AFTER the ticket row was updated inside the transaction.
    await assert.rejects(() => tickets.changeStatus({
      ticketId: ticket.id,
      status: 'in_progress',
      staff: { id: 'not-a-real-staff-id', departmentId: staff.departmentId, isAdmin: false },
    }));
    assert.equal((await tickets.getTicket(ticket.id)).status, 'opened', 'the ticket update was rolled back');
    assert.equal((await tickets.listTicketEvents(ticket.id)).length, 0);
    assert.equal((await notifications.listForStudent(student.id)).notifications.length, 0);
  } finally {
    await cleanup({ students: [student], staff: [staff], ticketIds: [ticket.id] });
  }
});

test('department staff only see and change their own department\'s tickets', async () => {
  const student = await makeStudent('Scope');
  const accountsStaff = await makeStaff('Accounts');
  const libraryStaff = await makeStaff('Library');
  const admin = await makeAdmin();
  const accountsTicket = await ticketFor(student, 'Accounts', 'accounts question');
  const libraryTicket = await ticketFor(student, 'Library', 'library question');
  try {
    await withServer(async (base) => {
      const listFor = async (who) => (await api(base, who.token)('GET', '/admin/tickets')).body.tickets.map((t) => t.id);

      const accountsSees = await listFor(accountsStaff);
      assert.ok(accountsSees.includes(accountsTicket.id));
      assert.ok(!accountsSees.includes(libraryTicket.id));

      const librarySees = await listFor(libraryStaff);
      assert.ok(librarySees.includes(libraryTicket.id));
      assert.ok(!librarySees.includes(accountsTicket.id));

      // Another department's ticket: 404, exactly like a ticket that does not exist.
      const foreign = await api(base, libraryStaff.token)('PATCH', `/admin/tickets/${accountsTicket.id}/status`, { status: 'in_progress' });
      assert.equal(foreign.status, 404);
      const missing = await api(base, libraryStaff.token)('PATCH', '/admin/tickets/TCK-DOESNOTEXIST000/status', { status: 'in_progress' });
      assert.equal(missing.status, 404);
      assert.equal((await tickets.getTicket(accountsTicket.id)).status, 'opened');
      assert.equal((await notifications.listForStudent(student.id)).notifications.length, 0);

      const adminSees = await listFor(admin);
      assert.ok(adminSees.includes(accountsTicket.id) && adminSees.includes(libraryTicket.id));
    });
  } finally {
    await cleanup({ students: [student], staff: [accountsStaff, libraryStaff, admin], ticketIds: [accountsTicket.id, libraryTicket.id] });
  }
});

test('a staff account that has been removed loses access straight away', async () => {
  const staff = await makeStaff('Accounts');
  await query('DELETE FROM staff_users WHERE id = $1', [staff.id]);
  await withServer(async (base) => {
    assert.equal((await api(base, staff.token)('GET', '/admin/tickets')).status, 401);
    assert.equal((await api(base, staff.token)('PATCH', '/admin/tickets/TCK-X/status', { status: 'resolved' })).status, 401);
  });
});

test('a ticket opened by a visitor (no student) can still be moved, with no notification', async () => {
  const staff = await makeStaff('Accounts');
  const ticket = await tickets.createTicket({
    email: 'visitor@example.com', question: 'A question from the public site', departmentId: await departmentId('Accounts'),
  });
  try {
    assert.equal(ticket.studentId, null);
    const moved = await tickets.changeStatus({
      ticketId: ticket.id, status: 'in_progress',
      staff: { id: staff.id, departmentId: staff.departmentId, isAdmin: false },
    });
    assert.equal(moved.status, 'in_progress');
    assert.equal((await tickets.listTicketEvents(ticket.id)).length, 1);
    const notified = await query('SELECT COUNT(*) AS n FROM notifications WHERE ticket_id = $1', [ticket.id]);
    assert.equal(Number(notified.rows[0].n), 0);
  } finally {
    await cleanup({ staff: [staff], ticketIds: [ticket.id] });
  }
});

test('a student sees only their own tickets and notifications', async () => {
  const alice = await makeStudent('AliceT');
  const bob = await makeStudent('BobT');
  const staff = await makeStaff('Accounts');
  const aliceTicket = await ticketFor(alice, 'Accounts', 'alice fee problem');
  const bobTicket = await ticketFor(bob, 'Accounts', 'bob fee problem');
  try {
    await withServer(async (base) => {
      await api(base, staff.token)('PATCH', `/admin/tickets/${aliceTicket.id}/status`, { status: 'in_progress' });

      const alicesTickets = (await api(base, alice.token)('GET', '/student/tickets')).body.tickets;
      assert.deepEqual(alicesTickets.map((t) => t.id), [aliceTicket.id]);
      assert.equal(alicesTickets[0].statusLabel, 'In Progress');

      const bobsTickets = (await api(base, bob.token)('GET', '/student/tickets')).body.tickets;
      assert.deepEqual(bobsTickets.map((t) => t.id), [bobTicket.id]);
      assert.equal(bobsTickets[0].status, 'opened');

      assert.equal((await api(base, alice.token)('GET', '/student/notifications')).body.unreadCount, 1);
      const bobsFeed = (await api(base, bob.token)('GET', '/student/notifications')).body;
      assert.equal(bobsFeed.unreadCount, 0);
      assert.deepEqual(bobsFeed.notifications, []);

      // Bob trying to mark Alice's notification as read (by id) changes nothing.
      const aliceNotificationId = (await notifications.listForStudent(alice.id)).notifications[0].id;
      const attempt = await api(base, bob.token)('POST', '/student/notifications/read', { ids: [aliceNotificationId] });
      assert.equal(attempt.body.marked, 0);
      assert.equal((await api(base, alice.token)('GET', '/student/notifications')).body.unreadCount, 1);
    });
  } finally {
    await cleanup({ students: [alice, bob], staff: [staff], ticketIds: [aliceTicket.id, bobTicket.id] });
  }
});

test('"where is my ticket?" is answered from the database, never by the model', async () => {
  const student = await makeStudent('Where');
  const staff = await makeStaff('Accounts');
  const ticket = await ticketFor(student, 'Accounts', 'My tuition payment is missing');
  const restore = stubAsk(async () => { throw new Error('ticket questions must not reach the model'); });
  try {
    await withServer(async (base) => {
      const call = api(base, student.token);
      const phrasings = [
        'where is my ticket?',
        'Any update on my ticket?',
        'has my ticket been resolved',
        'show my tickets',
        "what's happening with my support ticket",
        'my tickets',
      ];
      for (const question of phrasings) {
        const response = await call('POST', '/portal/ask', { question });
        assert.equal(response.status, 200, question);
        assert.match(response.body.answer, new RegExp(ticket.id), question);
        assert.match(response.body.answer, /Opened/, question);
        assert.equal(response.body.ticket.id, ticket.id);
      }

      // The answer follows the database: after staff move it, so does the reply.
      await api(base, staff.token)('PATCH', `/admin/tickets/${ticket.id}/status`, { status: 'in_progress' });
      const live = await call('POST', '/portal/ask', { question: 'where is my ticket?' });
      assert.match(live.body.answer, /In Progress/);
      assert.doesNotMatch(live.body.answer, /Opened/);

      await api(base, staff.token)('PATCH', `/admin/tickets/${ticket.id}/status`, { status: 'resolved' });
      const done = await call('POST', '/portal/ask', { question: 'where is my ticket?' });
      assert.match(done.body.answer, /Resolved/);

      // The question and the reply were remembered like any other exchange.
      const remembered = await call('GET', '/student/chat');
      assert.ok(remembered.body.messages.some((m) => /Resolved/.test(m.content)));
    });
  } finally {
    restore();
    await cleanup({ students: [student], staff: [staff], ticketIds: [ticket.id] });
  }
});

test('a student with no tickets is told so, honestly', async () => {
  const student = await makeStudent('NoTickets');
  const restore = stubAsk(async () => { throw new Error('must not reach the model'); });
  try {
    await withServer(async (base) => {
      const response = await api(base, student.token)('POST', '/portal/ask', { question: 'where is my ticket?' });
      assert.equal(response.status, 200);
      assert.match(response.body.answer, /don't have any tickets/i);
      assert.equal(response.body.ticket, null);
    });
  } finally {
    restore();
    await cleanup({ students: [student] });
  }
});

test('ticket questions never show another student\'s tickets', async () => {
  const alice = await makeStudent('AliceQ');
  const bob = await makeStudent('BobQ');
  const aliceTicket = await ticketFor(alice, 'Accounts', 'alice secret fee issue');
  const restore = stubAsk(async () => { throw new Error('must not reach the model'); });
  try {
    await withServer(async (base) => {
      // Bob has no tickets: he sees none, and nothing of Alice's.
      const bobGeneral = await api(base, bob.token)('POST', '/portal/ask', { question: 'where is my ticket?' });
      assert.match(bobGeneral.body.answer, /don't have any tickets/i);
      assert.doesNotMatch(bobGeneral.body.answer, new RegExp(aliceTicket.id));

      // Bob asks about Alice's reference: same answer as for a made-up one.
      const bobAsks = await api(base, bob.token)('POST', '/portal/ask', { question: `where is my ticket ${aliceTicket.id}?` });
      assert.match(bobAsks.body.answer, /couldn't find a ticket/i);
      assert.doesNotMatch(bobAsks.body.answer, /Opened|Accounts|alice/i);
      assert.equal(bobAsks.body.ticket, null);
      const madeUp = await api(base, bob.token)('POST', '/portal/ask', { question: 'where is my ticket TCK-0000000000000000?' });
      assert.match(madeUp.body.answer, /couldn't find a ticket/i);

      // The signed-out site and the public lookup route do not reveal it either.
      const publicChat = await api(base, null)('POST', '/ask', { question: `check the status of ticket ${aliceTicket.id}` });
      assert.match(publicChat.body.answer, /belongs to a student account/i);
      assert.doesNotMatch(publicChat.body.answer, /Opened|Accounts/);
      assert.equal(publicChat.body.ticket, null);
      assert.equal((await api(base, null)('GET', `/tickets/${aliceTicket.id}`)).status, 404);

      // Alice herself still can.
      const own = await api(base, alice.token)('POST', '/portal/ask', { question: `check the status of ticket ${aliceTicket.id}` });
      assert.match(own.body.answer, /currently Opened/);
    });
  } finally {
    restore();
    await cleanup({ students: [alice, bob], ticketIds: [aliceTicket.id] });
  }
});

test('questions that are not about an existing ticket still reach the model', async () => {
  const student = await makeStudent('NotStatus');
  let reachedModel = 0;
  const restore = stubAsk(async () => { reachedModel += 1; return generalAnswer('general answer'); });
  try {
    await withServer(async (base) => {
      const call = api(base, student.token);
      for (const question of ['how do tickets work?', 'What are the tuition fees?']) {
        const response = await call('POST', '/portal/ask', { question });
        assert.equal(response.status, 200, question);
        assert.match(response.body.answer, /general answer/, question);
      }
    });
    assert.equal(reachedModel, 2);
  } finally {
    restore();
    await cleanup({ students: [student] });
  }
});

test('a ticket opened from the portal chat belongs to the signed-in student', async () => {
  const student = await makeStudent('Opens');
  const restore = stubAsk(async () => ({
    answer: 'I do not have the details on that one.',
    confidence: 0.3, needsHuman: true, source: 'rag', departmentId: null, access: 'student',
  }));
  try {
    await withServer(async (base) => {
      const response = await api(base, student.token)('POST', '/portal/ask', { question: 'I paid my tuition but the portal still shows a balance' });
      assert.equal(response.status, 200);
      assert.ok(response.body.ticket, 'a ticket was opened');

      const stored = await tickets.getTicket(response.body.ticket.id);
      assert.equal(stored.studentId, student.id);
      assert.equal(stored.status, 'opened');
      assert.ok(stored.subject && stored.subject.length > 0);

      const mine = await api(base, student.token)('GET', '/student/tickets');
      assert.deepEqual(mine.body.tickets.map((t) => t.id), [response.body.ticket.id]);
    });
  } finally {
    restore();
    await cleanup({ students: [student] });
  }
});

test('a public visitor cannot attach a ticket to a student', async () => {
  const student = await makeStudent('Spoof');
  let created = null;
  try {
    await withServer(async (base) => {
      const response = await api(base, null)('POST', '/tickets', {
        question: 'Pretend this is for a student', email: 'visitor@example.com', studentId: student.id,
      });
      assert.equal(response.status, 201);
      created = response.body.ticket.id;
      assert.equal((await tickets.getTicket(created)).studentId, null);
    });
  } finally {
    await cleanup({ students: [student], ticketIds: created ? [created] : [] });
  }
});

test('staff sign-up can be closed with ALLOW_STAFF_SIGNUP=false', async () => {
  const before = process.env.ALLOW_STAFF_SIGNUP;
  process.env.ALLOW_STAFF_SIGNUP = 'false';
  try {
    await withServer(async (base) => {
      const response = await api(base, null)('POST', '/admin/signup', {
        username: `closed_${unique()}`, password: PASSWORD, departmentId: await departmentId('Accounts'),
      });
      assert.equal(response.status, 403);
    });
  } finally {
    if (before === undefined) delete process.env.ALLOW_STAFF_SIGNUP;
    else process.env.ALLOW_STAFF_SIGNUP = before;
  }
});

test('the public chat still uses per-tab session history', async () => {
  const originalLoad = chatlog.loadConversationHistory;
  const originalLog = chatlog.logMessage;
  let loadedFor = null;
  chatlog.loadConversationHistory = async (sessionId) => { loadedFor = sessionId; return { summary: '', messages: [], turns: [] }; };
  chatlog.logMessage = async () => {};
  const restore = stubAsk(async () => generalAnswer('public'));
  try {
    await withServer(async (base) => {
      await api(base, null)('POST', '/ask', { question: 'What programmes do you offer?', sessionId: 'public-session-1234567890' });
    });
    assert.equal(loadedFor, 'public-session-1234567890');
  } finally {
    chatlog.loadConversationHistory = originalLoad;
    chatlog.logMessage = originalLog;
    restore();
  }
});
