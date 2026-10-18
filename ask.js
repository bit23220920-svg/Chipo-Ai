require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { genAI, embedText, cosineSimilarity } = require('./embeddings.js');
const { getActiveFaqChunks } = require('./faqs.js');

// Bulletproof import to handle Node.js module packaging quirks
const pdfParseModule = require('pdf-parse');

// Smart resolver to locate the parser function across Node.js versions
let pdfParse;
if (typeof pdfParseModule === 'function') {
  pdfParse = pdfParseModule;
} else if (pdfParseModule && typeof pdfParseModule.default === 'function') {
  pdfParse = pdfParseModule.default;
} else if (pdfParseModule && typeof pdfParseModule.pdfParse === 'function') {
  pdfParse = pdfParseModule.pdfParse;
} else if (pdfParseModule && typeof pdfParseModule.parse === 'function') {
  pdfParse = pdfParseModule.parse;
} else {
  // Fallback for constructor wrappers
  pdfParse = async (buffer) => {
    return new pdfParseModule(buffer);
  };
}

// Below this top-match similarity score, we treat the retrieval as too weak
// to trust and flag the exchange for human follow-up. Cosine similarity from
// gemini-embedding-001 for a genuinely relevant chunk tends to sit well above
// this; tune via .env if that doesn't match what you see in practice.
const ESCALATION_THRESHOLD = Number(process.env.ESCALATION_THRESHOLD) || 0.55;

// Second signal, independent of the similarity score: Chipo's own system
// prompt tells it to say so plainly when it doesn't know something, so we
// watch for that instead of relying on the score alone.
const UNCERTAINTY_PATTERNS = [
  /i don'?t have (that|this) information/i,
  /i'?m not able to find/i,
  /don'?t have (any )?(specific )?(details|information) (about|on)/i,
  /contact the admissions office/i,
  /reach out to (?:the )?admissions office/i,
  /i don'?t know/i,
  /i'?m not sure/i,
  /i'?m not quite sure what you mean/i,
  /can'?t confirm/i,
  /not something i (can|have)/i,
];

function looksUncertain(answerText) {
  return UNCERTAINTY_PATTERNS.some((re) => re.test(answerText));
}

function splitIntoChunks(text, maxChars = 1500) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += para + "\n\n";
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

const CACHE_FILE = path.join(__dirname, 'embeddings-cache.json');

async function loadContent() {
  const contentDir = path.join(__dirname, 'content');
  const files = fs.readdirSync(contentDir);

  const fileStats = files.map(f => {
    const stat = fs.statSync(path.join(contentDir, f));
    return `${f}:${stat.mtimeMs}`;
  }).join('|');

  if (fs.existsSync(CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (cache.fingerprint === fileStats) {
      console.log("Using cached embeddings (content unchanged).");
      return cache.chunks;
    }
  }

  console.log("Content changed — rebuilding embeddings (this may take a moment)...");
  const chunks = [];
  for (const file of files) {
    const filepath = path.join(contentDir, file);
    let text;
    if (file.endsWith('.pdf')) {
      const buffer = fs.readFileSync(filepath);
      
      // Safety check in case the PDF parser fails to load properly
      if (typeof pdfParse !== 'function') {
        throw new Error("PDF parser failed to initialize. Check your node_modules.");
      }
      
      const data = await pdfParse(buffer);
      text = data.text;
    } else {
      text = fs.readFileSync(filepath, 'utf-8');
    }

    const pieces = splitIntoChunks(text).filter((piece) => piece.trim().length > 0);
    for (let i = 0; i < pieces.length; i++) {
      const embedding = await embedText(pieces[i]);
      chunks.push({
        filename: `${file} (part ${i + 1}/${pieces.length})`,
        text: pieces[i],
        embedding,
      });
    }
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify({ fingerprint: fileStats, chunks }));
  return chunks;
}

async function askQuestion(question, history = []) {
  const pdfChunks = await loadContent();

  let faqChunks = [];
  try {
    faqChunks = await getActiveFaqChunks();
  } catch (err) {
    // FAQ table might be empty or the DB might be briefly unavailable —
    // don't let that take down the whole RAG pipeline, just fall back to
    // PDF-only retrieval for this question.
    console.error('Could not load FAQ chunks, continuing with PDF content only:', err.message);
  }

  const chunks = [...faqChunks, ...pdfChunks];

  const questionEmbedding = await embedText(question);
  const scored = chunks.map((chunk) => ({
    ...chunk,
    score: cosineSimilarity(questionEmbedding, chunk.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);

  const topChunks = scored.slice(0, 2);
  const context = topChunks.map(c => c.text).join('\n\n---\n\n');
  const topScore = topChunks.length ? topChunks[0].score : 0;
  const topSource = topChunks.length ? (topChunks[0].source || 'rag') : 'rag';

  console.log("Using context from:", topChunks.map(c => c.filename), `(top score: ${topScore.toFixed(3)})`);

  const recentHistory = history.slice(-3);
  const historyText = recentHistory.length
    ? `Previous conversation (use this only to understand what the student is referring to, e.g. "that" or "it" — do not treat it as a source of facts):\n` +
      recentHistory.map(h => `Student: ${h.question}\nAssistant: ${h.answer}`).join('\n\n') +
      `\n\n`
    : '';

    const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite",
    generationConfig: { temperature: 0.8 },
  });

  const prompt = `You are Chipo, a friendly student assistant at the University of Lusaka. You talk to students and people outside the university  the way a helpful, experienced advisor would — warm, natural, and direct.

Rules for how you respond:
- Answer only using the information given to you below. Never make anything up.
- If the information isn't there, say so plainly and suggest the student contact the Admissions Office — don't guess.
- Put things in your own words. Don't lift sentences directly from the source material, and don't mirror its structure or bullet points unless a list genuinely makes the answer clearer.
- Never say phrases like "based on the context," "according to the document," or "the provided information states" — just answer as if you simply know it.
- Keep your tone conversational, like you're speaking to the student, not reading them a policy. Short, clear sentences beat long formal ones.

${historyText}Here's what you know:
${context}

Student's question: ${question}

Chipo's answer:`;
  
  let result;
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await model.generateContent(prompt);
      break;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitTime = attempt * 5000;
      console.log(`  Model busy, retry ${attempt}/${maxRetries} (waiting ${waitTime / 1000}s)...`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  const answerText = result.response.text();
  const needsHuman = topScore < ESCALATION_THRESHOLD || looksUncertain(answerText);

  return {
    answer: answerText,
    confidence: topScore,
    needsHuman,
    source: topSource, // 'faq' if a staff-curated FAQ was the strongest match, else 'rag'
    departmentId: topChunks.length && topChunks[0].source === 'faq'
      ? topChunks[0].departmentId
      : null,
  };
}

async function main() {
  const question = process.argv[2] || "What are the admission requirements?";
  console.log(`Question: "${question}"\n`);

  const { answer, confidence, needsHuman, source } = await askQuestion(question);
  console.log("\nAnswer:", answer);
  console.log(`\n(confidence: ${confidence.toFixed(3)}, source: ${source}, needs human follow-up: ${needsHuman})`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("ERROR:");
    console.error(err.cause || err);
  });
}

module.exports = { askQuestion };