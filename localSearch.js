// localSearch.js
//
// Search that needs no network and no API key. It reads the same prospectus
// PDFs and staff FAQs as the Gemini pipeline and ranks them with BM25, a
// well-tested keyword scoring method, helped by three things that make plain
// keyword search behave much more like a "smart" one:
//
//   - stemming:     "fees" / "fee", "applying" / "application" meet in the middle
//   - synonyms:     "cost", "price" and "tuition" all find the fees tables
//   - typo repair:  "admisn reqirements" is matched to "admission requirements"
//
// It is the engine behind localAnswer.js, which ask.js falls back to when the
// Gemini key is missing or Gemini cannot be reached.

const fs = require('fs');
const path = require('path');

let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch { /* PDFs are skipped if the parser is missing */ }

// ---------------------------------------------------------------- text tools

const STOPWORDS = new Set((
  'a about above after again all also am an and any are as at be because been before being below between both but by ' +
  'can could did do does doing down during each few for from further had has have having he her here hers him his how i ' +
  'if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours out over own ' +
  'same she should so some such than that the their theirs them then there these they this those through to too under until up ' +
  'very was we were what when where which while who whom why will with would you your yours yourself ' +
  'please tell give need want know get got like also kindly chipo hi hello hey thanks thank'
).split(/\s+/));

// Words that mean the same thing in a university. Each group is expanded for
// the question only, at a lower weight than the word the person actually typed.
const SYNONYM_GROUPS = [
  ['fee', 'cost', 'price', 'tuition', 'charge', 'pay', 'payment', 'amount', 'kwacha', 'zmw', 'much'],
  ['apply', 'application', 'admission', 'enrol', 'enroll', 'enrolment', 'enrollment', 'join', 'intake'],
  ['requirement', 'qualification', 'eligibility', 'entry', 'criteria', 'prerequisite', 'need'],
  ['course', 'programme', 'program', 'degree', 'diploma', 'major', 'study', 'qualification'],
  ['exam', 'examination', 'test', 'assessment', 'paper'],
  ['result', 'grade', 'mark', 'score', 'transcript', 'gpa'],
  ['hostel', 'accommodation', 'residence', 'dorm', 'dormitory', 'housing', 'lodging', 'boarding'],
  ['deadline', 'due', 'closing', 'cutoff', 'date', 'when'],
  ['campus', 'location', 'address', 'situated', 'directions', 'map', 'where'],
  ['contact', 'phone', 'email', 'call', 'reach', 'telephone', 'number'],
  ['refund', 'reimburse', 'reimbursement', 'money'],
  ['discipline', 'misconduct', 'offence', 'offense', 'penalty', 'punishment', 'sanction', 'conduct'],
  ['library', 'book', 'borrow', 'borrowing', 'librarian'],
  ['register', 'registration', 'enrol', 'enroll'],
  ['password', 'login', 'signin', 'credential', 'account'],
  ['graduate', 'graduation', 'convocation', 'ceremony'],
  ['postgraduate', 'masters', 'master', 'mba', 'phd', 'doctorate', 'research'],
  ['scholarship', 'bursary', 'sponsorship', 'funding', 'financial', 'aid'],
  ['timetable', 'schedule', 'calendar', 'term', 'semester'],
  ['defer', 'deferment', 'postpone', 'suspend', 'leave'],
  ['cheat', 'plagiarism', 'plagiarize', 'copying'],
];

const SYNONYMS = new Map();

// A light suffix stripper: not a full Porter stemmer, but it brings the
// common university words ("fees", "applying", "registered") to one root.
function stem(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) {
    w = w.slice(0, -3);
    if (/([^aeiou])\1$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  if (w.endsWith('ed') && w.length > 4) {
    w = w.slice(0, -2);
    if (/([^aeiou])\1$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  if (w.endsWith('ation') && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('ment') && w.length > 6) return w.slice(0, -4);
  if (w.endsWith('ly') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length > 3) return w.slice(0, -1);
  return w;
}

for (const group of SYNONYM_GROUPS) {
  const stems = group.map((word) => stem(word));
  for (const root of stems) {
    if (!SYNONYMS.has(root)) SYNONYMS.set(root, new Set());
    for (const other of stems) if (other !== root) SYNONYMS.get(root).add(other);
  }
}

function rawTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

// Abbreviations a student types that the documents spell out (and the other
// way round): "BSc IT" has to find "Bachelor of Science in Information Technology".
const ABBREVIATIONS = {
  bsc: ['bachelor', 'science'],
  bba: ['bachelor', 'business', 'administration'],
  llb: ['bachelor', 'laws'],
  llm: ['master', 'laws'],
  msc: ['master', 'science'],
  mba: ['master', 'business', 'administration'],
  ict: ['information', 'communication', 'technology'],
};

function tokenize(text, { keepStopwords = false, query = false } = {}) {
  const out = [];
  const expanded = [];
  for (const token of rawTokens(text)) {
    // In a question, an abbreviation is replaced by its long form, because a
    // document that spells it out will not contain the abbreviation itself.
    if (!(query && ABBREVIATIONS[token])) expanded.push(token);
    if (ABBREVIATIONS[token]) expanded.push(...ABBREVIATIONS[token]);
  }
  for (const token of expanded) {
    if (!keepStopwords && STOPWORDS.has(token)) continue;
    if (token.length === 1 && !/\d/.test(token)) continue;
    out.push(stem(token));
  }
  return out;
}

// Edit distance that also counts a swapped pair of letters as one mistake.
function editDistance(a, b, limit = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows[i] = [i];
  }
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

// --------------------------------------------------------------- the content

// A table's column labels ("1/1 1/2 2/1 ...") appear once, far above the rows
// that need them, so a chunk of rows would otherwise lose its meaning. Each
// chunk remembers the most recent label line so answers can say which column
// is which.
const TABLE_HEADER = /(?:\b\d\/\d\b\s*){4,}/;

function splitIntoChunks(text, maxChars = 900, withHeaders = false) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const chunks = [];
  const headers = [];
  let current = [];
  let size = 0;
  let lastHeader = null;
  let chunkHeader = null;
  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined.length > 40) {
      chunks.push(joined);
      headers.push(chunkHeader);
    }
    current = [];
    size = 0;
    chunkHeader = lastHeader;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    // A heading-like line (numbered section, or ALL CAPS) starts a fresh chunk
    // once the current one has some body, so a section stays in one piece.
    const heading = /^(?:\d+(?:\.\d+)*\.?\s+[A-Z]|[A-Z][A-Z &/,'-]{6,}$)/.test(trimmed);
    if (current.length && ((size + trimmed.length > maxChars) || (heading && size > 300))) {
      // Keep the last two lines as an overlap so a fact that straddles two
      // chunks is still found whole.
      const tail = current.slice(-2);
      flush();
      current = tail.slice();
      size = current.join('\n').length;
    }
    if (trimmed) {
      if (TABLE_HEADER.test(trimmed) && !/[A-Za-z]{4,}/.test(trimmed.replace(/(?:\d\/\d)/g, ''))) {
        lastHeader = trimmed;
        if (!current.length) chunkHeader = lastHeader;
        else chunkHeader = chunkHeader || lastHeader;
      }
      current.push(trimmed);
      size += trimmed.length + 1;
    }
  }
  flush();
  return withHeaders ? chunks.map((text2, i) => ({ text: text2, header: headers[i] || null })) : chunks;
}

const CONTENT_DIR = path.join(__dirname, 'content');
const CACHE_FILE = path.join(__dirname, 'local-search-cache.json');

let pdfChunkCache = null;
let pdfChunkFingerprint = null;

function contentFingerprint() {
  if (!fs.existsSync(CONTENT_DIR)) return 'none';
  return fs.readdirSync(CONTENT_DIR)
    .map((file) => `${file}:${fs.statSync(path.join(CONTENT_DIR, file)).mtimeMs}`)
    .join('|');
}

/**
 * The prospectus and policy documents as plain-text chunks. Parsed once,
 * then kept in memory and on disk, so a restart does not re-read the PDFs.
 */
async function loadDocumentChunks() {
  const fingerprint = contentFingerprint();
  if (pdfChunkCache && pdfChunkFingerprint === fingerprint) return pdfChunkCache;

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (cached.fingerprint === fingerprint && Array.isArray(cached.chunks)) {
        pdfChunkCache = cached.chunks;
        pdfChunkFingerprint = fingerprint;
        return pdfChunkCache;
      }
    }
  } catch { /* a damaged cache is simply rebuilt */ }

  const chunks = [];
  if (fs.existsSync(CONTENT_DIR)) {
    for (const file of fs.readdirSync(CONTENT_DIR)) {
      const filepath = path.join(CONTENT_DIR, file);
      let text = '';
      try {
        if (/\.pdf$/i.test(file)) {
          if (!pdfParse) continue;
          text = (await pdfParse(fs.readFileSync(filepath))).text;
        } else if (/\.(?:txt|md)$/i.test(file)) {
          text = fs.readFileSync(filepath, 'utf-8');
        } else {
          continue;
        }
      } catch (err) {
        console.error(`Local search could not read ${file}:`, err.message);
        continue;
      }
      const pieces = splitIntoChunks(text, 900, true);
      pieces.forEach((piece, index) => {
        chunks.push({
          filename: `${file} (part ${index + 1}/${pieces.length})`,
          text: piece.text,
          header: piece.header,
          source: 'rag',
        });
      });
    }
  }

  pdfChunkCache = chunks;
  pdfChunkFingerprint = fingerprint;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ fingerprint, chunks })); } catch { /* read-only disks are fine */ }
  return chunks;
}

// --------------------------------------------------------------------- index

/**
 * Build a BM25 index. The index is cheap to make (a few thousand chunks), so
 * it is rebuilt when the set of chunks changes rather than kept up to date.
 */
function buildIndex(chunks) {
  const docs = chunks.map((chunk) => {
    // A FAQ's question is worth more than its answer, and a chunk's first
    // line is usually its heading, so those words are counted twice.
    const firstLine = String(chunk.text).split('\n')[0];
    const boosted = chunk.source === 'faq'
      ? `${String(chunk.text).split('\n')[0]} ${chunk.text}`
      : `${firstLine} ${chunk.text} ${chunk.filename || ''}`;
    const tokens = tokenize(boosted);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    // A short first line is a heading ("Application Process"). A question that
    // only reaches it through a synonym ("how do I apply") still means it.
    const headTokens = tokenize(firstLine);
    const headTerms = firstLine.trim().split(/\s+/).length <= 6 ? new Set(headTokens) : new Set();
    return { chunk, counts, length: tokens.length || 1, headTerms };
  });

  const documentFrequency = new Map();
  for (const doc of docs) {
    for (const term of doc.counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);
  return { docs, documentFrequency, averageLength, size: docs.length };
}

function idf(index, term) {
  const df = index.documentFrequency.get(term) || 0;
  return Math.log(1 + (index.size - df + 0.5) / (df + 0.5));
}

/**
 * Turn a question into weighted search terms: the stems of what was typed
 * (weight 1), typo repairs (0.9) and synonyms (0.45).
 */
function expandQuery(index, question) {
  const weights = new Map();
  const typed = tokenize(question, { query: true });
  const add = (term, weight) => {
    if (weight > (weights.get(term) || 0)) weights.set(term, weight);
  };

  for (const term of typed) {
    if (index.documentFrequency.has(term) || /\d/.test(term)) {
      add(term, 1);
    } else if (term.length >= 4) {
      // Not a word the documents use: look for a near miss ("admisn").
      const limit = term.length >= 8 ? 2 : 1;
      let best = null;
      let bestDistance = limit + 1;
      for (const known of index.documentFrequency.keys()) {
        if (Math.abs(known.length - term.length) > limit) continue;
        const distance = editDistance(term, known, limit);
        if (distance < bestDistance) { best = known; bestDistance = distance; }
      }
      if (best) add(best, 0.9);
    }
    for (const synonym of SYNONYMS.get(term) || []) {
      if (index.documentFrequency.has(synonym)) add(synonym, 0.45);
    }
  }
  return { weights, typed: [...new Set(typed)] };
}

/**
 * Rank the chunks for a question. Returns the best `k`, each with its BM25
 * `score` and `coverage` - the share of the question's meaning (weighted by
 * how rare each word is) that the chunk actually contains.
 */
function search(index, question, k = 4) {
  const { weights, typed } = expandQuery(index, question);
  if (!weights.size) return { results: [], terms: weights, typed, mass: 1 };

  const k1 = 1.4;
  const b = 0.72;
  // A word the documents have never used (and that no typo repair rescued)
  // still counts against coverage - "capital of France" must not look like a
  // well-covered question just because "capital" appears somewhere.
  const rareIdf = Math.log(1 + (index.size + 0.5) / 1.5);
  const typedMass = typed.reduce((sum, term) => sum + (weights.has(term) ? idf(index, term) : (/\d/.test(term) ? 0 : rareIdf)), 0)
    || [...weights.entries()].reduce((sum, [term, weight]) => sum + idf(index, term) * weight, 0)
    || 1;

  const results = [];
  for (const doc of index.docs) {
    let score = 0;
    let matched = 0;
    for (const [term, rawWeight] of weights) {
      const frequency = doc.counts.get(term);
      if (!frequency) continue;
      const weight = rawWeight < 0.9 && doc.headTerms && doc.headTerms.has(term) ? 0.9 : rawWeight;
      const termIdf = idf(index, term);
      const norm = frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * doc.length / index.averageLength));
      score += termIdf * norm * weight;
      if (typed.includes(term) || weight >= 0.9) matched += termIdf;
    }
    if (score > 0) {
      results.push({
        ...doc.chunk,
        score,
        coverage: Math.min(1, matched / typedMass),
      });
    }
  }
  results.sort((a, b2) => b2.score - a.score);
  return { results: results.slice(0, k), terms: weights, typed, mass: typedMass };
}

module.exports = {
  STOPWORDS,
  tokenize,
  stem,
  editDistance,
  splitIntoChunks,
  loadDocumentChunks,
  buildIndex,
  expandQuery,
  search,
  idf,
};
