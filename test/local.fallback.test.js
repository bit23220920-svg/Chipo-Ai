// The local (no API key) engine: search, answers, and the switch-over from
// Gemini. None of these tests needs the network or a Gemini key.

const test = require('node:test');
const assert = require('node:assert/strict');
const localSearch = require('../localSearch.js');
const localAnswer = require('../localAnswer.js');
const ask = require('../ask.js');
const faqs = require('../faqs.js');
const { query } = require('../db.js');

let chunksPromise = null;
const documents = () => {
  if (!chunksPromise) chunksPromise = localSearch.loadDocumentChunks();
  return chunksPromise;
};

async function answer(question, turns = []) {
  return localAnswer.answerFromChunks({ question, turns, chunks: await documents() });
}

// Run a block with the Gemini key removed (or replaced), then put it back.
async function withEnv(vars, run) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ask.resetGeminiCooldown();
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    ask.resetGeminiCooldown();
  }
}

// ------------------------------------------------------------------ search

test('stemming and synonyms: "cost" finds the fees pages', async () => {
  const index = localSearch.buildIndex(await documents());
  const { results } = localSearch.search(index, 'what is the cost of studying law', 5);
  assert.ok(results.some((chunk) => /FEES/i.test(chunk.filename)), 'a fee document should be among the matches');
});

test('typos are repaired before searching', async () => {
  const index = localSearch.buildIndex(await documents());
  const typo = localSearch.search(index, 'accomodation hostle', 3).results;
  const clean = localSearch.search(index, 'accommodation hostel', 3).results;
  assert.ok(typo.length > 0, 'a misspelt question still finds something');
  assert.ok(clean.length > 0);
  assert.ok(typo.some((chunk) => /accommodation|hostel/i.test(chunk.text)),
    'the repaired words must lead to passages about accommodation');
});

test('abbreviations expand: "bsc" matches "Bachelor of Science"', () => {
  assert.deepEqual(localSearch.tokenize('BSc', { query: true }), ['bachelor', 'science']);
  assert.ok(localSearch.tokenize('BSc').includes('bsc'));
});

test('edit distance counts a swapped pair of letters as one mistake', () => {
  assert.equal(localSearch.editDistance('admisison', 'admission'), 1);
  assert.equal(localSearch.editDistance('fees', 'fees'), 0);
  assert.ok(localSearch.editDistance('fees', 'campus') > 3);
});

// ----------------------------------------------------------------- answers

test('a fee question returns the programme\'s own row, labelled by year and semester', async () => {
  const result = await answer('how much are the fees for bsc information technology');
  assert.equal(result.found, true);
  assert.match(result.answer, /Information Technology/i);
  assert.match(result.answer, /Year 1 Semester 1: ZMW 12,000/);
  assert.match(result.answer, /Year 3 Semester 1: ZMW 15,050/);
  assert.doesNotMatch(result.answer, /Public Health/i, 'the row of another programme must not leak in');
});

test('"fees for law" finds the Bachelor of Laws row', async () => {
  const result = await answer('fees for law');
  assert.match(result.answer, /Laws/i);
  assert.match(result.answer, /ZMW 12,600/);
});

test('a one-line fact is answered with that line, not a page', async () => {
  const result = await answer('how many campuses does unilus have');
  assert.match(result.answer, /three campuses/i);
  assert.ok(result.answer.length < 400);
});

test('a Q-and-A line is answered with its answer', async () => {
  const result = await answer('which campus is the law school at');
  assert.match(result.answer, /Leopards Hill/i);
});

test('the bank deposit rule is found', async () => {
  const result = await answer('how do i pay fees at the bank');
  assert.match(result.answer, /deposit|bank/i);
});

test('a follow-up uses the earlier question to know what "it" is', async () => {
  const turns = [{ question: 'Tell me about the BSc in Information Technology', answer: 'It is a four-year degree.' }];
  const result = await answer('what about its fees?', turns);
  assert.match(result.answer, /Information Technology/i);
  assert.match(result.answer, /ZMW/);
});

test('a follow-up asking about something specific is answered with that, not the earlier answer again', async () => {
  const turns = [{ question: 'how much are the fees for bsc information technology', answer: 'Year 1 Semester 1: ZMW 12,000 ...' }];
  const result = await answer('what about the practical fee', turns);
  assert.match(result.answer, /Practical Fee/i);
  assert.match(result.answer, /200\.00/);
  assert.doesNotMatch(result.answer, /Year 1 Semester 1/);
});

test('without the earlier question the same follow-up is not guessed', async () => {
  const result = await answer('what about its fees?');
  assert.doesNotMatch(result.answer, /Information Technology/i);
});

test('a question the documents do not cover is not answered with a guess', async () => {
  const result = await answer('what is the capital of france');
  assert.equal(result.found, false);
  assert.ok(result.confidence < 0.55, 'low confidence sends it to a department');
});

test('table rows are turned into sentences only when the column labels are known', () => {
  const row = 'BACHELOR OF LAWS 12,600  12,600  12,600  12,600  13,400  16,100  18,800  18,800';
  assert.match(localAnswer.explainTableRow(row, '1/1 1/2 2/1 2/2 3/1 3/2 4/1 4/25/15/2'), /Year 4 Semester 2: ZMW 18,800/);
  assert.equal(localAnswer.explainTableRow(row, null), null);
});

test('greetings and thanks get a short reply', () => {
  assert.match(localAnswer.conversationalReply('hello'), /Chipo/);
  assert.match(localAnswer.conversationalReply('thanks!'), /welcome/i);
  assert.match(localAnswer.conversationalReply('what can you do?'), /admissions/i);
});

// ------------------------------------------------- the switch-over in ask.js

test('with no Gemini key, Chipo answers from the local engine', async () => {
  await withEnv({ GEMINI_API_KEY: undefined }, async () => {
    const result = await ask.askQuestion('how much are the fees for bsc information technology', { summary: '', messages: [] });
    assert.equal(result.engine, 'local');
    assert.match(result.answer, /ZMW 12,000/);
    assert.deepEqual(result.sources, ['UNDERGRADUATE-FEES-ZMW.pdf']);
    assert.equal(result.needsHuman, false);
  });
});

test('with no key, a question the documents cannot answer still goes to a department', async () => {
  await withEnv({ GEMINI_API_KEY: undefined }, async () => {
    const result = await ask.askQuestion('what is the dress code for the graduation gala dinner', { summary: '', messages: [] });
    assert.equal(result.engine, 'local');
    assert.equal(result.needsHuman, true);
    assert.match(result.answer, /can't find that in my records/i);
  });
});

test('with no key, the university-only boundary still applies', async () => {
  await withEnv({ GEMINI_API_KEY: undefined }, async () => {
    const result = await ask.askQuestion('what is the capital of france', { summary: '', messages: [] });
    assert.equal(result.source, 'out_of_scope');
  });
});

test('with no key, a signed-out visitor still cannot read personal records', async () => {
  await withEnv({ GEMINI_API_KEY: undefined }, async () => {
    const result = await ask.askQuestion('what is my fee balance', { summary: '', messages: [] });
    assert.equal(result.source, 'portal_locked');
  });
});

test('with no key, greetings never need a department', async () => {
  await withEnv({ GEMINI_API_KEY: undefined }, async () => {
    const result = await ask.askQuestion('hello', { summary: '', messages: [] });
    assert.equal(result.needsHuman, false);
    assert.equal(result.engine, 'local');
  });
});

test('CHIPO_ENGINE=local forces the local engine even when a key is set', async () => {
  await withEnv({ GEMINI_API_KEY: 'a-key-that-must-not-be-used', CHIPO_ENGINE: 'local' }, async () => {
    assert.equal(ask.hasGeminiKey(), false);
    const result = await ask.askQuestion('how many campuses does unilus have', { summary: '', messages: [] });
    assert.equal(result.engine, 'local');
    assert.match(result.answer, /three campuses/i);
  });
});

test('a key Gemini rejects falls back to the local engine, then stays local for a while', async () => {
  await withEnv({ GEMINI_API_KEY: 'not-a-real-key', GEMINI_COOLDOWN_MS: '60000' }, async () => {
    const first = await ask.askQuestion('how many campuses does unilus have', { summary: '', messages: [] });
    assert.equal(first.engine, 'local');
    assert.match(first.answer, /three campuses/i);

    // The failure was remembered, so the next student is not made to wait again.
    assert.equal(ask.hasGeminiKey(), false);
    const started = Date.now();
    const second = await ask.askQuestion('which campus is the law school at', { summary: '', messages: [] });
    assert.equal(second.engine, 'local');
    assert.ok(Date.now() - started < 2000, 'the second answer must not wait on Gemini');
  });
});

test('a FAQ saved without an embedding is still used by the local engine', async () => {
  await withEnv({ GEMINI_API_KEY: undefined }, async () => {
    let faq = null;
    try {
      faq = await faqs.createFaq({
        question: 'Where do I collect my graduation gown?',
        answer: 'Collect your graduation gown from the Student Affairs office at the Pioneer Campus the week before graduation.',
        departmentId: null,
      });
      assert.ok(faq, 'saving a FAQ must not need Gemini');

      const result = await ask.askQuestion('where do i collect the graduation gown', { summary: '', messages: [] });
      assert.equal(result.engine, 'local');
      assert.match(result.answer, /Student Affairs office at the Pioneer Campus/);
    } finally {
      if (faq) await query('DELETE FROM faqs WHERE id = $1', [faq.id]);
    }
  });
});
