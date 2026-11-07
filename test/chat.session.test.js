const test = require('node:test');
const assert = require('node:assert/strict');
const chatlog = require('../chatlog.js');
const ask = require('../ask.js');
const { app } = require('../server.js');

test('campus follow-ups resolve "it" to the programme in the previous answer', () => {
  const history = [{
    question: 'How much is law?',
    answer: 'Tuition for the Bachelor of Laws is 12,600 ZMW per semester.',
  }];

  assert.equal(
    ask.rewriteCampusFollowUp('Which campus is it at?', history),
    'Which campus is the Bachelor of Laws located at?'
  );
  assert.equal(ask.rewriteCampusFollowUp('Where are they located?', history), null);
  assert.equal(ask.rewriteCampusFollowUp('Which campus is it at?', []), null);
});

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

test('chat requests persist each turn and load history from the same session', async () => {
  const originalLoadHistory = chatlog.loadConversationHistory;
  const originalLogMessage = chatlog.logMessage;
  const originalAsk = ask.askQuestion;
  const sessions = new Map();
  const historiesSeenByAsk = [];
  const questions = [
    'how many campuses does unilus have',
    'where are they located',
    'which one has the law school',
    'tell me more about it',
  ];
  const answers = [
    'UNILUS has three campuses.',
    'Pioneer, Law and Silverest campuses are in Lusaka.',
    'The Law Campus has the law school.',
    'The Law Campus supports the university law programmes.',
  ];

  chatlog.loadConversationHistory = async (sessionId) => {
    const turns = (sessions.get(sessionId) || []).map((turn) => ({ ...turn }));
    return {
      summary: '',
      messages: turns.slice(-6).flatMap((turn) => [
        { role: 'user', content: turn.question },
        { role: 'assistant', content: turn.answer },
      ]),
      turns,
    };
  };
  chatlog.logMessage = async ({ sessionId, question, answer }) => {
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    sessions.get(sessionId).push({ question, answer });
  };
  ask.askQuestion = async (question, history) => {
    historiesSeenByAsk.push({ question, history });
    return {
      answer: answers[questions.indexOf(question)],
      confidence: 0.9,
      needsHuman: false,
      source: 'rag',
      sources: ['UNILUS Prospectus'],
      departmentId: null,
      access: 'public',
    };
  };

  try {
    await withServer(async (base) => {
      const sessionId = 'test-chat-session-0001';
      for (const question of questions) {
        const response = await fetch(`${base}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, sessionId }),
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.sessionId, sessionId);
        assert.equal(body.sources[0], 'UNILUS Prospectus');
      }

      assert.deepEqual(historiesSeenByAsk.map(({ history }) => history.messages.length), [0, 2, 4, 6]);
      assert.equal(historiesSeenByAsk[3].history.turns.length, 3);
      assert.equal(sessions.get(sessionId).length, 4);
      assert.deepEqual(sessions.get(sessionId).map(({ question }) => question), questions);
      assert.equal(historiesSeenByAsk[3].question, questions[3]);
    });
  } finally {
    chatlog.loadConversationHistory = originalLoadHistory;
    chatlog.logMessage = originalLogMessage;
    ask.askQuestion = originalAsk;
  }
});

test('chat requests reject malformed explicit session IDs', async () => {
  const originalLoadHistory = chatlog.loadConversationHistory;
  let loaded = false;
  chatlog.loadConversationHistory = async () => {
    loaded = true;
    return { summary: '', messages: [], turns: [] };
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Hello', sessionId: 'invalid id' }),
      });
      assert.equal(response.status, 400);
      assert.equal(loaded, false);
    });
  } finally {
    chatlog.loadConversationHistory = originalLoadHistory;
  }
});

test('campus location questions use document search and return campus map links', async () => {
  const originalLoadHistory = chatlog.loadConversationHistory;
  const originalLogMessage = chatlog.logMessage;
  const originalAsk = ask.askQuestion;
  let modelCalled = false;
  let loggedAnswer = '';
  let historySeen = [];

  chatlog.loadConversationHistory = async () => ({
    summary: '',
    messages: [],
    turns: [{ question: 'How many campuses does UNILUS have?', answer: 'UNILUS has three campuses.' }],
  });
  chatlog.logMessage = async ({ answer }) => {
    loggedAnswer = answer;
  };
  ask.askQuestion = async (question, history) => {
    modelCalled = true;
    assert.equal(question, 'Where are they located?');
    historySeen = history.turns;
    return {
      answer: 'The campus locations are in the campus locations guide.',
      confidence: 0.9,
      needsHuman: false,
      source: 'rag',
      sources: ['UNILUS_Campus_Locations.pdf'],
      departmentId: null,
      access: 'public',
    };
  };

  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Where are they located?', sessionId: 'test-campus-session-0001' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.answer, 'The campus locations are in the campus locations guide.');
      assert.deepEqual(body.sources, ['UNILUS_Campus_Locations.pdf']);
      assert.deepEqual(body.campusMaps.map(({ name }) => name), [
        'Pioneer Campus (Main/Administration)',
        'Leopards Hill Campus (Law Campus)',
        'Silverest Campus',
      ]);
      assert.equal(
        body.campusMaps[0].mapUrl,
        'https://www.google.com/maps/search/?api=1&query=University+of+Lusaka+Pioneer+Campus+Plot+37413+Alick+Nkhata+Road+Mass+Media+Lusaka'
      );
      assert.equal(body.needsHuman, false);
      assert.equal(loggedAnswer, body.answer);
      assert.equal(modelCalled, true);
      assert.equal(historySeen.length, 1);
    });
  } finally {
    chatlog.loadConversationHistory = originalLoadHistory;
    chatlog.logMessage = originalLogMessage;
    ask.askQuestion = originalAsk;
  }
});
