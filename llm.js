// llm.js
//
// Groq: the first language model Chipo asks. If Groq is not set up, is busy,
// or fails, ask.js moves on to Gemini, and after that to the local engine, so
// a student always gets an answer.
//
// Groq speaks the same chat-completions format as OpenAI, so this is a plain
// HTTPS call with no extra package. Groq has no embeddings endpoint: finding
// the right passages is still done by Gemini's embeddings when a Gemini key
// exists, and by the local search when it does not.
//
// Settings (all optional except the key):
//   GROQ_API_KEY        the key from console.groq.com. Never logged.
//   GROQ_MODEL          default llama-3.3-70b-versatile
//   GROQ_TIMEOUT_MS     give up and move on after this long (default 25000)
//   GROQ_COOLDOWN_MS    after a failure, skip Groq for this long (default 60000)
//   CHIPO_ENGINE=local  turns off every outside model

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

let groqDownUntil = 0;

function groqModel() {
  return String(process.env.GROQ_MODEL || '').trim() || DEFAULT_MODEL;
}

function groqKey() {
  return String(process.env.GROQ_API_KEY || '').trim();
}

function cooldownMs() {
  return Number(process.env.GROQ_COOLDOWN_MS) || 60 * 1000;
}

function markGroqDown(ms = cooldownMs()) {
  groqDownUntil = Date.now() + ms;
}

function resetGroqCooldown() {
  groqDownUntil = 0;
}

function groqAvailable() {
  if (String(process.env.CHIPO_ENGINE || '').toLowerCase() === 'local') return false;
  if (Date.now() < groqDownUntil) return false;
  return Boolean(groqKey());
}

/**
 * Ask Groq one question and return its text. Any failure throws an Error with
 * `.status` (the HTTP status, when there was one) and, for a busy Groq,
 * `.retryAfterMs`, so the caller can step aside for the right length of time.
 */
async function groqGenerate(prompt, { temperature = 0.4, maxTokens = 1024 } = {}) {
  const timeout = Number(process.env.GROQ_TIMEOUT_MS) || 25000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: groqModel(),
        messages: [{ role: 'user', content: String(prompt) }],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const failure = new Error(err && err.name === 'AbortError'
      ? `Groq did not answer within ${timeout} ms`
      : `Groq could not be reached: ${err && err.message}`);
    failure.status = 0;
    throw failure;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body && body.error && body.error.message ? body.error.message : '';
    } catch (err) { /* no JSON body */ }
    const failure = new Error(`Groq ${response.status}${detail ? `: ${detail}` : ''}`);
    failure.status = response.status;
    const retryAfter = Number(response.headers.get('retry-after'));
    if (retryAfter > 0) failure.retryAfterMs = Math.min(retryAfter * 1000, 5 * 60 * 1000);
    throw failure;
  }

  const data = await response.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '').trim()
    : '';
  if (!text) {
    const failure = new Error('Groq returned an empty answer');
    failure.status = 200;
    throw failure;
  }
  return text;
}

module.exports = {
  groqAvailable,
  groqGenerate,
  groqModel,
  markGroqDown,
  resetGroqCooldown,
};
