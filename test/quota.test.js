// A spent Gemini quota is not hammered again a minute later; a summary that
// cannot be written never fails a question; gpt-oss models are called the way
// they need to be.

const test = require('node:test');
const assert = require('node:assert/strict');
const ask = require('../ask.js');
const llm = require('../llm.js');
const chatlog = require('../chatlog.js');

const realFetch = global.fetch;
let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter += 1)}${Math.random().toString(36).slice(2, 5)}`;

test('the wait Gemini asks for is honoured, in either of the ways it says it', () => {
  assert.equal(ask.retryDelayFrom(new Error('Please retry in 1h5m30.4s. [{"retryDelay":"3930s"}]')), 3930000);
  assert.equal(ask.retryDelayFrom(new Error('Please retry in 58m59.6s.')), 3539600);
  assert.equal(ask.retryDelayFrom(new Error('Embed content requests per day limit exceeded')), 3600000);
  assert.equal(ask.retryDelayFrom(new Error('network down')), 0);
  assert.equal(ask.retryDelayFrom(new Error('{"retryDelay":"999999s"}')), 6 * 3600 * 1000, 'capped at six hours');
});

test('a chat whose older messages cannot be summarised still loads', async () => {
  const sessionId = `quota-${unique()}`.padEnd(20, 'x');
  for (let i = 0; i < 9; i += 1) {
    await chatlog.logMessage({ sessionId, question: `question ${i}`, answer: `answer ${i}`, confidence: 0.5, needsHuman: false, source: 'rag' });
  }
  let asked = 0;
  const history = await chatlog.loadConversationHistory(sessionId, async () => { asked += 1; throw new Error('No language model is available.'); });
  assert.ok(asked >= 1, 'a summary was attempted');
  assert.ok(history.turns.length > 0, 'the recent turns are still returned');
  assert.equal(history.summary, '');
});

async function withGroqModel(model, handler, run) {
  const saved = { GROQ_API_KEY: process.env.GROQ_API_KEY, GROQ_MODEL: process.env.GROQ_MODEL };
  process.env.GROQ_API_KEY = 'gsk_test_key_do_not_log_123456';
  if (model) process.env.GROQ_MODEL = model; else delete process.env.GROQ_MODEL;
  llm.resetGroqCooldown();
  const bodies = [];
  global.fetch = async (url, init) => {
    if (!String(url).includes('api.groq.com')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    bodies.push(body);
    return handler(body, bodies.length);
  };
  try { return await run(bodies); } finally {
    global.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    llm.resetGroqCooldown();
  }
}

const ok = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

test('gpt-oss gets low reasoning effort and room to think; other models are untouched', async () => {
  await withGroqModel('openai/gpt-oss-120b', () => ok('fine'), async (bodies) => {
    assert.equal(await llm.groqGenerate('hello'), 'fine');
    assert.equal(bodies[0].model, 'openai/gpt-oss-120b');
    assert.equal(bodies[0].reasoning_effort, 'low');
    assert.equal(bodies[0].max_tokens, 2048);
  });
  await withGroqModel(null, () => ok('fine'), async (bodies) => {
    await llm.groqGenerate('hello');
    assert.equal(bodies[0].model, 'llama-3.3-70b-versatile');
    assert.equal('reasoning_effort' in bodies[0], false);
    assert.equal(bodies[0].max_tokens, 1024);
  });
});

test('if the API refuses the reasoning setting, the call is repeated without it', async () => {
  await withGroqModel('openai/gpt-oss-120b', (body) => (body.reasoning_effort
    ? new Response(JSON.stringify({ error: { message: 'reasoning_effort is not supported' } }), { status: 400 })
    : ok('second try worked')), async (bodies) => {
    assert.equal(await llm.groqGenerate('hello'), 'second try worked');
    assert.equal(bodies.length, 2);
    assert.equal('reasoning_effort' in bodies[1], false);
  });
});

test('the key and model can also be set as LLM_API_KEY and LLM_MODEL', async () => {
  const saved = { GROQ_API_KEY: process.env.GROQ_API_KEY, LLM_API_KEY: process.env.LLM_API_KEY, GROQ_MODEL: process.env.GROQ_MODEL, LLM_MODEL: process.env.LLM_MODEL };
  delete process.env.GROQ_API_KEY; delete process.env.GROQ_MODEL;
  process.env.LLM_API_KEY = 'gsk_alias_key_value_123456';
  process.env.LLM_MODEL = 'openai/gpt-oss-120b';
  llm.resetGroqCooldown();
  const seen = [];
  global.fetch = async (url, init) => {
    if (!String(url).includes('api.groq.com')) return realFetch(url, init);
    seen.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return ok('via alias');
  };
  try {
    assert.equal(llm.groqAvailable(), true);
    assert.equal(await llm.groqGenerate('hi'), 'via alias');
    assert.equal(seen[0].auth, 'Bearer gsk_alias_key_value_123456');
    assert.equal(seen[0].body.model, 'openai/gpt-oss-120b');
    // The Groq names win when both are set.
    process.env.GROQ_API_KEY = 'gsk_primary_key_value_123456';
    await llm.groqGenerate('hi');
    assert.equal(seen[1].auth, 'Bearer gsk_primary_key_value_123456');
  } finally {
    global.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    llm.resetGroqCooldown();
  }
});
