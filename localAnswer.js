// localAnswer.js
//
// Answers a question with no AI model at all. It finds the best passages with
// localSearch.js, then reads them the way a person would skim a document:
// it picks the lines that actually answer the question, keeps the numbers
// and dates they contain, labels table rows with their column headings, and
// says plainly when the documents do not hold the answer.
//
// ask.js uses this when GEMINI_API_KEY is missing or Gemini cannot be
// reached, so Chipo still answers instead of showing an error.

const localSearch = require('./localSearch.js');

const MAX_ANSWER_CHARS = 620;

const CAPABILITIES = 'I can help with admissions, programmes, fees and payments, registration, results, examinations, '
  + 'the code of conduct, campus locations and the student portal.';

const NOT_FOUND = "I can't find that in my records, so it is best answered by the right office.";

// ------------------------------------------------------------ small replies

function conversationalReply(question) {
  const text = String(question || '').trim().toLowerCase();
  if (/\b(?:thanks|thank you|cheers|ta|appreciate)\b/.test(text)) {
    return "You're welcome. Ask me anything else about UNILUS.";
  }
  if (/\b(?:bye|goodbye|see you|cya)\b/.test(text)) {
    return 'Goodbye, and good luck with your studies.';
  }
  if (/\b(?:who are you|what are you|your name)\b/.test(text)) {
    return `I'm Chipo, the University of Lusaka student assistant. ${CAPABILITIES}`;
  }
  if (/\b(?:what can you|how can you|can you help|help me|what do you)\b/.test(text)) {
    return CAPABILITIES;
  }
  return `Hello, I'm Chipo, the University of Lusaka student assistant. ${CAPABILITIES}`;
}

// ------------------------------------------------------------- query building

const FOLLOW_UP = /^(?:and|what about|how about|also|then|so|what of|ok(?:ay)?|but)\b|\b(?:it|its|that|this|they|them|those|these|there|he|she)\b/i;

/**
 * "what about its fees?" means nothing alone. When a question is short or
 * points back at something ("it", "that"), the key words of the previous
 * question are added so retrieval knows what "it" is.
 */
function buildQuery(question, turns) {
  const own = localSearch.tokenize(question);
  const last = turns && turns.length ? turns[turns.length - 1] : null;
  if (!last) return question;
  const vague = own.length <= 2 || (own.length <= 5 && FOLLOW_UP.test(question));
  if (!vague) return question;
  return `${question} ${last.question}`;
}

// ------------------------------------------------------------- unit scoring

const MONTHS = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

const NUMBER_ROW = /(?:\d[\d,.]*\s+){4,}/;
const LIST_START = /^(?:\d+(?:\.\d+)*[.)]\s|[•·\-–]\s|\([a-z0-9]{1,3}\)\s|[A-Z][A-Z &/,'-]{6,}$|Q:|A:)/;

/**
 * PDFs break a sentence across several lines. Join the lines of a paragraph
 * back together (keeping table rows, list items and headings separate), then
 * split the paragraph into sentences.
 */
function splitUnits(chunk) {
  const lines = String(chunk.text).split('\n').map((line) => line.trim()).filter(Boolean);
  const paragraphs = [];
  let current = '';
  let heading = null;
  const push = () => {
    if (current) paragraphs.push({ text: current, heading });
    current = '';
  };
  for (const line of lines) {
    const isRow = NUMBER_ROW.test(line) || /\b\d[\d,]{3,}\b.*\b\d[\d,]{3,}\b/.test(line)
      || /\b\d[\d,]*\.\d{2}\b/.test(line);
    const isHeading = !isRow && /^[A-Z][A-Z0-9 &/,'()-]{7,}$/.test(line) && !/\d[\d,]{3,}/.test(line.replace(/\b20\d\d\b/g, ''));
    if (isHeading) {
      push();
      heading = line;
      paragraphs.push({ text: line, heading: line, isHeading: true });
      continue;
    }
    if (isRow || LIST_START.test(line)) {
      push();
      current = line;
      if (isRow) push();
      continue;
    }
    if (!current) { current = line; continue; }
    // Hard-wrapped continuation of the same sentence.
    if (!/[.!?:;]$/.test(current) || /^[a-z(]/.test(line)) {
      current = `${current} ${line}`;
    } else {
      push();
      current = line;
    }
  }
  push();

  const units = [];
  for (const paragraph of paragraphs) {
    const text = paragraph.text;
    if (text.length > 240 && !NUMBER_ROW.test(text)) {
      for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)) {
        if (sentence.trim()) units.push({ text: sentence.trim(), heading: paragraph.heading });
      }
    } else {
      units.push({ text, heading: paragraph.heading, isHeading: paragraph.isHeading });
    }
  }
  return units;
}

function questionKind(question) {
  const q = String(question).toLowerCase();
  return {
    money: /\b(?:fee|fees|cost|costs|price|how much|pay|payment|tuition|charge|zmw|kwacha)\b/.test(q),
    date: /\b(?:when|date|deadline|start|begin|open|close|intake|due)\b/.test(q),
    count: /\bhow many\b|\bnumber of\b/.test(q),
    contact: /\b(?:phone|email|contact|call|reach|address|where|located|location)\b/.test(q),
  };
}

function scoreUnit(unitObj, weights, index, kind, typed, mass) {
  const unit = unitObj.text;
  const tokens = new Set(localSearch.tokenize(unit));
  // The section a line sits under ("JANUARY 2026 INTAKE") counts, at half weight.
  const headingTokens = unitObj.heading && !unitObj.isHeading
    ? new Set(localSearch.tokenize(unitObj.heading))
    : new Set();
  let score = 0;
  let matched = 0;
  const total = mass;
  for (const [term, weight] of weights) {
    const termIdf = localSearch.idf(index, term);
    if (tokens.has(term)) {
      score += termIdf * weight;
      if (weight >= 0.9) matched += termIdf;
    } else if (headingTokens.has(term)) {
      score += termIdf * weight * 0.5;
      if (weight >= 0.9) matched += termIdf * 0.5;
    }
  }
  if (score === 0) return { score: 0, coverage: 0 };
  // Reward lines that carry most of the question, and do not let a long
  // rambling line beat a short exact one just by having more words.
  score *= 0.4 + 0.6 * (total ? Math.min(1, matched / total) : 0);
  const wordCount = tokens.size;
  score /= 1 + Math.max(0, wordCount - 14) / 20;

  const hasNumber = /\d/.test(unit);
  if (kind.money && /\d[\d,]{2,}/.test(unit)) {
    score *= 1.35;
    // A fee table row never repeats the word "fees": its column heading did.
    if (NUMBER_ROW.test(unit)) {
      for (const term of typed) {
        if (MONEY_WORDS.has(term) && !tokens.has(term) && weights.has(term)) {
          matched += localSearch.idf(index, term);
        }
      }
      score *= 1 + Math.min(1, matched / total) * 0.2;
    }
    // A fee table row for the programme that was named is the answer.
    const nonMoney = typed.filter((term) => tokens.has(term) && !MONEY_WORDS.has(term));
    if (nonMoney.length && NUMBER_ROW.test(unit)) score *= 1.9;
  }
  if (kind.date && (MONTHS.test(unit) || /\b\d{1,2}(?:st|nd|rd|th)\b/.test(unit))) score *= 1.3;
  if (kind.count && hasNumber) score *= 1.2;
  if (kind.contact && /(?:@|\+?\d[\d\s-]{6,}|plot|road|street|campus)/i.test(unit)) score *= 1.2;
  // Navigation noise: contents pages, page numbers and dotted leaders.
  if (/\.{6,}/.test(unit) || /^page \d+/i.test(unit) || /^[\d\s]+$/.test(unit)) score *= 0.2;
  if (unit.length < 14) score *= 0.5;
  // A line that starts in the middle of a sentence is a poor opening.
  if (/^[a-z]/.test(unit)) score *= 0.75;
  // A heading that merely repeats the question is not the answer; its answer
  // is the paragraph underneath, which is handled when the text is built.
  if (/^Q:/.test(unit)) score *= 1.6;
  else if (/\?$/.test(unit)) score *= 0.9;
  return { score, coverage: total ? Math.min(1, matched / total) : 0 };
}

const MONEY_WORDS = new Set(['fee', 'cost', 'price', 'tuition', 'charge', 'pay', 'payment', 'amount', 'kwacha', 'zmw', 'much', 'semest', 'semester', 'year', 'local', 'student']);

// ------------------------------------------------------------- table rows

const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2}|\d{4,6}/g;

/** "BACHELOR OF LAWS 12,600 12,600 ..." + header -> a readable sentence. */
function explainTableRow(unit, header) {
  if (!header) return null;
  const labels = header.match(/\d\/\d/g);
  const numbers = unit.match(NUMBER);
  if (!labels || !numbers || numbers.length < 4) return null;
  const firstNumber = unit.search(NUMBER);
  const name = unit.slice(0, firstNumber).replace(/\s+/g, ' ').trim();
  if (name.length < 4) return null;
  const parts = [];
  for (let i = 0; i < Math.min(labels.length, numbers.length); i += 1) {
    const [year, semester] = labels[i].split('/');
    parts.push(`Year ${year} Semester ${semester}: ZMW ${numbers[i]}`);
  }
  const title = name.toLowerCase().replace(/\b(?:bsc|ba|bba)\b/g, (m) => m.toUpperCase())
    .replace(/(^|\s)([a-z])/g, (m, space, ch) => space + ch.toUpperCase());
  return `${title}, total fees per semester (local and SADC students): ${parts.join('; ')}.`;
}

// ----------------------------------------------------------------- the answer

function tidy(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s*[•·]\s*/g, '; ')
    .replace(/^[;\s]+/, '')
    .trim();
}

function clip(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (stop > limit * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')) + (stop > limit * 0.5 ? '' : '...');
}

/**
 * @param {object} args
 * @param {string} args.question
 * @param {Array<{question:string,answer:string}>} [args.turns] earlier turns
 * @param {Array<object>} args.chunks every chunk that may hold the answer
 * @returns {{answer:string, confidence:number, topChunks:Array<object>, usedIndexes:number[], found:boolean}}
 */
function answerFromChunks({ question, turns = [], chunks }) {
  const index = localSearch.buildIndex(chunks);
  const query = buildQuery(question, turns);
  const found = localSearch.search(index, query, 7);
  const { terms, mass } = found;
  let results = found.results;

  if (!results.length) {
    return { answer: NOT_FOUND, confidence: 0.1, topChunks: [], usedIndexes: [], found: false };
  }

  const best = results[0];

  // A staff-written FAQ that matches is the university's own answer. Use it
  // word for word instead of picking lines out of it.
  if (best.source === 'faq' && best.coverage >= 0.55) {
    const [, ...rest] = String(best.text).split('\n');
    return {
      answer: tidy(rest.join(' ')) || tidy(best.text),
      confidence: Math.min(0.95, 0.55 + best.coverage * 0.4),
      topChunks: results,
      usedIndexes: [0],
      found: true,
    };
  }

  const kind = questionKind(question);
  const typed = localSearch.tokenize(query, { query: true });

  // A fee question about a named programme must see the fee tables even when
  // longer passages about that programme outrank them.
  if (kind.money) {
    const named = typed.filter((term) => !MONEY_WORDS.has(term) && terms.has(term));
    if (named.length) {
      const have = new Set(results.map((chunk) => chunk.filename));
      for (const doc of index.docs) {
        if (have.has(doc.chunk.filename)) continue;
        if (!doc.chunk.header) continue;
        if (named.some((term) => doc.counts.has(term))) results.push({ ...doc.chunk, score: 0, coverage: 0.5 });
      }
    }
  }
  const candidates = [];
  results.forEach((chunk, chunkIndex) => {
    const units = splitUnits(chunk);
    units.forEach((unit, unitIndex) => {
      if (unit.isHeading) return;
      const { score, coverage } = scoreUnit(unit, terms, index, kind, typed, mass);
      if (score > 0) {
        // Results ranked higher keep a small edge, so equal lines fall to the
        // better chunk.
        candidates.push({
          unit, unitIndex, units, chunkIndex, chunk, coverage,
          score: score * (1 + (results.length - chunkIndex) * 0.04),
        });
      }
    });
  });
  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    return { answer: NOT_FOUND, confidence: 0.15, topChunks: results, usedIndexes: [], found: false };
  }

  const top = candidates[0];
  const picked = [top];
  const seen = new Set([top.unit.text]);
  // Supporting lines come from the same passage as the best line only, so
  // the answer never stitches together unrelated parts of a document.
  for (const candidate of candidates.slice(1)) {
    if (picked.length >= 3) break;
    if (candidate.chunkIndex !== top.chunkIndex) continue;
    if (candidate.score < top.score * 0.6 || seen.has(candidate.unit.text)) continue;
    if (candidate.coverage < 0.34) continue;
    picked.push(candidate);
    seen.add(candidate.unit.text);
  }
  const rest = picked.slice(1).sort((a, b) => a.unitIndex - b.unitIndex);
  const ordered = [top, ...rest];

  const sentences = [];
  for (const item of ordered) {
    const row = explainTableRow(item.unit.text, item.chunk.header);
    if (row) { sentences.push(row); continue; }
    let text = item.unit.text;
    const next = item.units[item.unitIndex + 1];
    // A heading that is just the question ("1. Overview: how many campuses?"),
    // or a label with its value underneath ("Application Fees"), is followed
    // by the actual answer.
    if (next && !next.isHeading && (/\?$/.test(text) || (text.length < 50 && !/[.!?]$/.test(text)))) {
      text = /\?$/.test(text) ? next.text : `${text} ${next.text}`;
    }
    // Drop a leading list number such as "5. " from the answer text.
    text = text.replace(/^\d+(?:\.\d+)*[.)]\s+/, '').replace(/^(?:Q|A):\s*/, '');
    // Say which section a dated line belongs to ("JANUARY 2026 INTAKE").
    if (kind.date && item.unit.heading && !item.unit.isHeading && /\d/.test(text)) {
      const label = item.unit.heading.toLowerCase().replace(/(^|\s)([a-z])/g, (m, sp, ch) => sp + ch.toUpperCase());
      if (!text.toLowerCase().includes(item.unit.heading.toLowerCase())) text = `${label}: ${text}`;
    }
    sentences.push(tidy(text));
  }

  let answer = clip(sentences.join(' '), MAX_ANSWER_CHARS);
  if (!/[.!?]$/.test(answer)) answer += '.';

  const confidence = Math.max(0.1, Math.min(0.93,
    0.2 + 0.75 * (0.6 * top.coverage + 0.4 * best.coverage)));

  const usedIndexes = [...new Set(ordered.map((item) => item.chunkIndex))];
  return { answer, confidence, topChunks: results, usedIndexes, found: confidence >= 0.55 };
}

module.exports = {
  answerFromChunks,
  conversationalReply,
  buildQuery,
  explainTableRow,
  splitUnits,
  scoreUnit,
  questionKind,
  NOT_FOUND,
  CAPABILITIES,
};
