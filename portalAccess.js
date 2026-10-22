// portalAccess.js
//
// Access control for Chipo's portal context.
//
// Chipo runs in one of two modes:
//
//   - student session: the request carries a valid student token, so the
//     chatbot receives that student's portal records and can answer account
//     questions in full (profile, fees, courses, results, announcements).
//
//   - public: there is no student session, so the chatbot receives no student
//     records at all. It keeps answering general university questions, but a
//     question about somebody's own account is refused with a pointer to the
//     student portal.
//
// The switch is the endpoint: /portal/ask requires a student session and
// reads that student's portal records, while /ask is the public entry point
// and never returns account data - not even for a signed-in student. The
// public site stays public, and the portal stays personal.
//
// This module is deliberately free of database access so the rules can be
// unit tested on their own — server.js and studentPortal.js load the records
// and hand them over.

/* ------------------------------------------------------------------ *
 * Typo tolerance
 * ------------------------------------------------------------------ */

// Students type fast, often on a phone, and a misspelt question must still
// be understood. The rules below match a word even when it is a letter or two
// out: "defrment" is still "deferment", "admisn" is still "admission".

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein distance. Only ever run on short words, so the quadratic
// cost does not matter.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

// How wrong a word is allowed to be and still count as the same word.
function toleranceFor(word) {
  if (word.length >= 9) return 2;
  if (word.length >= 5) return 1;
  return 0;
}

// The plain form of a word: "admissions" and "admission" are the same word,
// "registered" and "register" are the same word. That is not a typo.
function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1);
  else if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ion')) w = w.slice(0, -3);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

// A missing or doubled vowel is the most common mistake, so the vowels are
// taken out and what is left is compared: "admisn" is "admission" without
// the vowels.
function skeleton(word) {
  if (word.length < 4) return word;
  return word[0] + word.slice(1).replace(/[aeiou]/g, '');
}

/**
 * How well does the token match the word?
 * @returns {'exact'|'fuzzy'|null}
 */
function matchWord(token, word) {
  if (token === word) return 'exact';
  // The same word in a different form: "admissions" and "admission",
  // "graduates" and "graduate". Not a typo.
  if (stem(token) === stem(word)) return 'exact';

  const tolerance = toleranceFor(word);
  if (!tolerance) return null;
  const lengthGap = Math.abs(token.length - word.length);
  if (lengthGap <= tolerance && editDistance(token, word) <= tolerance) return 'fuzzy';

  // The vowel rule, only for the long words, where the consonants are
  // distinctive enough to be worth comparing on their own, and only when the
  // word starts the same way.
  if (word.length >= 8 && lengthGap <= 3 && token[0] === word[0]) {
    return editDistance(skeleton(token), skeleton(word)) <= 1 ? 'fuzzy' : null;
  }
  return null;
}

function fuzzyWordMatch(token, word) {
  return matchWord(token, word) !== null;
}

/**
 * Does the text contain the keyword, allowing for a typo or two?
 *
 * @param {string} text
 * @param {string} keyword
 * @returns {'exact'|'fuzzy'|null} how it matched, or null when it did not
 */
function matchKeyword(text, keyword) {
  const haystack = normalizeForMatch(text);
  const needle = normalizeForMatch(keyword);
  if (!haystack || !needle) return null;
  if (haystack.includes(needle)) return 'exact';

  const words = needle.split(' ');
  const tokens = haystack.split(' ');

  if (words.length === 1) {
    let best = null;
    for (const token of tokens) {
      const match = matchWord(token, words[0]);
      if (match === 'exact') return 'exact';
      if (match === 'fuzzy') best = 'fuzzy';
    }
    return best;
  }

  // A phrase: every word has to be there, in any order, within a typo or two.
  const used = new Array(tokens.length).fill(false);
  let allExact = true;
  for (const word of words) {
    let found = null;
    for (let i = 0; i < tokens.length; i++) {
      if (used[i]) continue;
      const match = matchWord(tokens[i], word);
      if (match) {
        used[i] = true;
        found = match;
        break;
      }
    }
    if (!found) return null;
    if (found === 'fuzzy') allExact = false;
  }
  return allExact ? 'exact' : 'fuzzy';
}

/**
 * True when the text contains the keyword, typos and all.
 * @param {string} text
 * @param {string} keyword
 * @returns {boolean}
 */
function containsFuzzy(text, keyword) {
  return matchKeyword(text, keyword) !== null;
}

/* ------------------------------------------------------------------ *
 * Deciding whether a question is about somebody's own records
 * ------------------------------------------------------------------ */

// Words that point at a record that only exists for one student.
const PERSONAL_TOPICS = [
  'account status', 'account balance', 'account', 'profile', 'personal information',
  'personal details', 'student number', 'student id', 'student record', 'academic record',
  'fee balance', 'fee statement', 'fee', 'fees', 'balance', 'outstanding', 'owed', 'owe',
  'payment', 'payments', 'receipt', 'receipts', 'quotation', 'invoice', 'debt',
  'registration status', 'course registration', 'registered', 'registration',
  'courses', 'course', 'credits', 'credit', 'results', 'result', 'ca marks', 'marks', 'grade',
  'grades', 'gpa', 'cgpa', 'transcript', 'exam', 'examination', 'exam slip', 'timetable',
  'class schedule', 'lecture schedule', 'schedule', 'subject', 'subjects', 'withdrawal',
  'e-learning', 'assignments', 'materials', 'lectures',
  'graduation clearance', 'graduation confirmation', 'graduation status', 'graduation',
  'deferment', 'deferral', 'exemption', 'exemptions', 'appeal', 'appeals',
  'class pass', 'clearance', 'certification', 'progress',
];

// The topics that are personal on their own: a student record, a private
// result, a personal deferment. A question about one of these is about *this*
// student as soon as it says "mine" anywhere.
const PERSONAL_TOPICS_STRONG = [
  'account status', 'account balance', 'profile', 'personal information',
  'personal details', 'student number', 'student id', 'student record', 'academic record',
  'fee balance', 'fee statement', 'results', 'result', 'ca marks', 'marks', 'grade',
  'grades', 'gpa', 'cgpa', 'transcript', 'exam slip', 'class pass', 'clearance',
  'certification', 'graduation clearance', 'graduation confirmation', 'graduation status',
  'deferment', 'deferral', 'exemption', 'exemptions', 'appeal', 'appeals',
  'e-learning', 'assignments', 'course registration', 'registration status',
];

// The topics that are personal only when the student says so next to them:
// "my fee balance" is about the student, "the fee schedule, my email is jane@..."
// is not.
const PERSONAL_TOPICS_WEAK = [
  'fee', 'fees', 'balance', 'outstanding', 'owed', 'owe', 'payment', 'payments',
  'receipt', 'receipts', 'quotation', 'invoice', 'debt', 'account', 'registered',
  'registration', 'courses', 'course', 'credits', 'credit', 'exam', 'examination',
  'timetable', 'class schedule', 'lecture schedule', 'schedule', 'subject', 'subjects',
  'withdrawal', 'materials', 'lectures', 'graduation', 'progress',
];

// Words that make the question about *this* person rather than the university.
// Deliberately narrow: "do i" on its own is not enough, otherwise a general
// question like "How do I apply for a deferment?" would be treated as a
// request for somebody's private record.
const PERSONAL_MARKERS = [
  /\bmy\b/, /\bmine\b/, /\bi\s+(?:have|owe|am|was|got|paid|registered|applied)\b/,
  /\bam\s+i\b/, /\bhave\s+i\b/, /\bdid\s+i\b/, /\bfor\s+me\b/,
  /\bshow\s+me\b/, /\bwhat(?:'s| is| are)\s+my\b/, /\bhow\s+much\s+(?:do|will|did)\s+i\b/,
  /\bmy\s+own\b/, /\bunder\s+my\b/, /\bin\s+my\b/, /\bon\s+my\b/,
];

// How far the marker may sit from the topic before the question stops being
// about the student: "show me my results" and "how much do i owe" are both
// about the student, "my email is jane@example.com" is not.
const PERSONAL_MARKER_WINDOW = 5;

// How many words may sit between the topic and a marker that comes after it:
// "what courses am i taking" - the marker is right there.
const PERSONAL_MARKER_AFTER = 2;

/**
 * Where a topic word sits in the question, allowing for a typo.
 * @param {string[]} tokens
 * @param {string} topic
 * @returns {number[]} the token index of every match
 */
function topicTokenIndexes(tokens, topic) {
  const words = topic.split(' ').filter(Boolean);
  const indexes = [];
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((word, offset) => matchWord(tokens[i + offset], word))) indexes.push(i);
  }
  return indexes;
}

/**
 * True when the question is asking about a specific student's own portal
 * records rather than general university information.
 * @param {string} question
 * @returns {boolean}
 */
function isPersonalPortalQuestion(question) {
  const text = String(question || '').toLowerCase();
  if (!text.trim()) return false;

  const hasMarker = PERSONAL_MARKERS.some((marker) => marker.test(text));

  // A private record: a result, a transcript, a deferment. A marker anywhere
  // in the question is enough.
  if (hasMarker && PERSONAL_TOPICS_STRONG.some((topic) => containsFuzzy(text, topic))) {
    return true;
  }

  // A subject that is only private when the student says so: "my fee balance"
  // is about the student, "the fee schedule - my email is jane@example.com"
  // is a general question with contact details in it.
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
  for (const topic of PERSONAL_TOPICS_WEAK) {
    for (const index of topicTokenIndexes(tokens, topic)) {
      // The marker has to sit next to the topic, close enough to belong to
      // it: in front of it ("my fee balance", "how much do i owe") or right
      // after it ("what courses am i taking"). The topic itself is part of
      // the text that is checked, so "the fees I owe" still reads as personal.
      const window = tokens
        .slice(Math.max(0, index - PERSONAL_MARKER_WINDOW), index + topic.split(' ').length)
        .join(' ');
      if (PERSONAL_MARKERS.some((marker) => marker.test(window))) return true;
      const after = tokens
        .slice(index + topic.split(' ').length, index + topic.split(' ').length + PERSONAL_MARKER_AFTER)
        .join(' ');
      if (PERSONAL_MARKERS.some((marker) => marker.test(after))) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Questions the portal itself can answer
 * ------------------------------------------------------------------ */

// Subjects the portal context covers — notices, and the how-to of each
// service. When one of these comes in, the portal context is the right
// source, so the answer is kept even if the document retrieval scored low.
const PORTAL_TOPIC_PATTERNS = [
  /\bannouncements?\b/, /\bnotices?\b/, /\bnews\b/,
  /\bgraduation\b/, /\bceremony\b/, /\bgraduating\b/,
  /\bdeferment\b/, /\bdeferral\b/, /\bexemption/, /\bclass pass\b/,
  /\bappeal/, /\bclearance\b/, /\be-?learning\b/, /\bregistration\b/,
  /\btimetable\b/, /\bpayments?\b/, /\bquotation\b/, /\bpersonal information\b/,
  /\bcourse registration\b/, /\baccounts switch\b/, /\bsuspension of classes\b/,
  /\bdeferral of studies\b/,
];

// The same subjects as single words, so a misspelt one still counts.
const PORTAL_TOPIC_WORDS = [
  'announcement', 'notice', 'news', 'graduation', 'ceremony', 'graduating',
  'deferment', 'deferral', 'exemption', 'appeal', 'clearance', 'e-learning',
  'registration', 'timetable', 'payment', 'quotation', 'class pass',
];

/**
 * True when the question is about something the portal context carries
 * (a published notice, or how one of the services works).
 * @param {string} question
 * @returns {boolean}
 */
function matchesPortalTopic(question) {
  const text = String(question || '').toLowerCase();
  if (!text.trim()) return false;
  if (PORTAL_TOPIC_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return PORTAL_TOPIC_WORDS.some((word) => containsFuzzy(text, word));
}

/* ------------------------------------------------------------------ *
 * The refusal used when there is no student session
 * ------------------------------------------------------------------ */

const LOCKED_ANSWER = [
  "I can't reach any student records from here — I can only answer general university questions while nobody is signed in.",
  'Sign in to the student portal and ask me again: as soon as you are signed in I can read your profile, fees, courses, results, exemptions and announcements.',
].join(' ');

// The answer for someone who has no portal account yet. Applications, the
// application fee and admission letters are not linked to a student record, so
// asking them to sign in would be a dead end — the hand-off form is the way in.
const PRE_ACCOUNT_ANSWER = [
  "I can't check applications, application fee payments or admission letters from the public site, because those records aren't linked to a portal account.",
  'The Admissions Office handles them, and they will need a way to reach you.',
].join(' ');

const PRE_ACCOUNT_PATTERNS = [
  /\b(?:admission|offer|acceptance)\s+(?:letter|status|outcome)\b/,
  /\bapplication\s+(?:status|outcome)\b/,
  /\b(?:i|we)\s+(?:have\s+)?applied\b(?!\s+(?:for|to)\s+(?:a\s+|an\s+|the\s+)?(?:deferment|deferral|exemption|appeal|accommodation|hostel|scholarship|bursary|job|vacancy|library)\b)/,
  /\bhave\s+(?:i|we)\s+been\s+(?:accepted|admitted)\b/,
  /\b(?:am|was)\s+i\s+(?:accepted|admitted)\b/,
];

/**
 * True when the question is about an application, an application fee payment
 * or an admission letter — things a person can ask about before they have any
 * portal account.
 * @param {string} question
 * @returns {boolean}
 */
function isPreAccountQuestion(question) {
  const text = String(question || '').toLowerCase();
  if (!text.trim()) return false;
  if (PRE_ACCOUNT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  const aboutFee = /\bapplication\s+fees?\b/.test(text);
  const aboutPayment = /\b(?:paid|pay|paying|payment|receipt|receipts|refund|refunded|charged|reversed|deducted|double|twice)\b/.test(text);
  return aboutFee && aboutPayment;
}

// A student who is struggling needs a warm reply and Student Affairs, not a
// routine hand-off. These are deliberately the clear signals only: stress
// about an exam is not a crisis.
const WELLBEING_PATTERNS = [
  /\b(?:overwhelmed|cannot cope|can'?t cope|hopeless|worthless)\b/,
  /\b(?:suicid(?:e|al)|self[-\s]?harm|kill(?:ing)? myself|end(?:ing)? my life|take my own life|hurt(?:ing)? myself)\b/,
  /\b(?:want to die|better off dead|don'?t want to (?:live|be here)|no reason to live)\b/,
];

/**
 * True when the message is a wellbeing crisis that needs a warm reply and an
 * urgent hand-off to Student Affairs.
 * @param {string} question
 * @returns {boolean}
 */
function isWellbeingConcern(question) {
  const text = String(question || '').toLowerCase();
  if (!text.trim()) return false;
  return WELLBEING_PATTERNS.some((pattern) => pattern.test(text));
}

// A short "I have a problem" only means something in a conversation that is
// already about the university. On its own it is not a university question.
const VAGUE_FOLLOW_UPS = [
  /^(?:i have|i'?ve got|i got) (?:a |an )?(?:problem|issue|question|concern)\b/,
  /^(?:i'?m|i am) (?:stuck|confused|lost|not sure|struggling)\b/,
  /^(?:help|help me|i need help|can you help|something is wrong|it'?s not working|not working)\b/,
  /^(?:what about|and|also|what if|another thing)\b/,
];

/**
 * True when a short message is a follow-up to an earlier university question
 * rather than a new, unrelated subject.
 * @param {string} question
 * @returns {boolean}
 */
function isVagueFollowUp(question) {
  const text = String(question || '').trim().toLowerCase();
  if (!text) return false;
  return VAGUE_FOLLOW_UPS.some((pattern) => pattern.test(text));
}

/* ------------------------------------------------------------------ *
 * What Chipo is allowed to talk about
 * ------------------------------------------------------------------ */

// Chipo is a University of Lusaka assistant, so anything that has nothing to
// do with the university is out of bounds. The list is deliberately wide:
// it is better to answer a question that happens to be about the university
// than to refuse a question that was.
const SCOPE_KEYWORDS = [
  'unilus', 'university of lusaka', 'university', 'universities', 'campus',
  'student', 'students', 'student portal', 'portal', 'school', 'faculty', 'department',
  'admission', 'admissions', 'admit', 'programme', 'programmes', 'program', 'programs',
  'course', 'courses', 'module', 'modules', 'credit', 'credits', 'semester', 'academic year',
  'fee', 'fees', 'tuition', 'payment', 'payments', 'pay', 'paying', 'quotation', 'invoice', 'refund',
  'bursary', 'scholarship', 'sponsorship', 'financial aid', 'deadline', 'deadlines', 'penalty', 'penalties',
  'result', 'results', 'grade', 'grades', 'gpa', 'cgpa', 'transcript', 'exam', 'examination',
  'exam slip', 'mark', 'marks', 'supplementary', 'sit',
  'registration', 'register', 'registered', 'enrol', 'enroll', 'enrolment', 'enrollment',
  'timetable', 'schedule', 'lecture', 'lecturer', 'e-learning', 'assignment', 'assignments',
  'material', 'materials', 'subject', 'subjects', 'class pass', 'library',
  'graduation', 'graduating', 'graduates', 'ceremony', 'clearance', 'certification',
  'deferment', 'deferral', 'defer', 'exemption', 'exemptions', 'exempt', 'waiver',
  'appeal', 'appeals', 'complaint', 'disciplinary', 'misconduct', 'code of conduct',
  'hostel', 'accommodation', 'residence', 'id card', 'identity card',
  'withdrawal', 'readmission', 'readmit', 'suspension', 'calendar', 'timetable',
  'dean', 'registrar', 'vice chancellor', 'bursar', 'provost', 'rector', 'council',
  'apply', 'application', 'applications', 'requirements', 'procedure', 'process', 'policy',
  'form', 'forms', 'document', 'documents', 'certificate', 'transcript request',
  'readmission', 'academic progress', 'class list', 'books', 'textbook',
];

// Questions that clearly belong to somebody else's world. If one of these
// turns up and nothing university-ish is also in the question, it is out of
// bounds — otherwise "what is my bitcoin balance" would look like a question
// about a fee balance.
const OUT_OF_SCOPE_HINTS = [
  'bitcoin', 'crypto', 'cryptocurrency', 'forex', 'wallet', 'stock price', 'share price',
  'bank balance', 'savings account', 'movie', 'film', 'recipe', 'weather', 'joke', 'poem',
  'lyrics', 'capital of', 'football', 'world cup', 'nba', 'formula one', 'horoscope',
];

// ...unless the question is about the university as well, in which case it is
// in scope after all.
const STRONG_UNILUS_HINTS = [
  'unilus', 'university', 'student portal', 'campus', 'faculty', 'programme', 'course',
  'module', 'exam', 'semester', 'graduation', 'deferment', 'exemption', 'appeal',
  'timetable', 'scholarship', 'bursary', 'hostel', 'lecturer', 'registry', 'student',
  'school', 'department', 'admissions', 'faculties',
];

// Just chat. A greeting, a thank you, or "what can you do?" is not a question
// about anything in particular, so it is never out of bounds — Chipo should
// answer it like a person would.
const CONVERSATIONAL_PATTERNS = [
  /^\s*(hi|hey|hello|yo|sup|hiya|hola|molo|howdy|greetings|good\s+(morning|afternoon|evening|day))\b/i,
  /^\s*(how\s+are\s+you|how'?s\s+it\s+going|how\s+you\s+doing|how\s+have\s+you\s+been|you\s+ok|howz)\b/i,
  /^\s*(thanks|thank\s+you|cheers|many\s+thanks|ta)\b/i,
  /^\s*(bye|goodbye|see\s+you|good\s+night|talk\s+later)\b/i,
  /\b(what\s+can\s+you\s+(?:do|help|assist|tell)|what\s+do\s+you\s+(?:do|help|know|tell)|how\s+can\s+you\s+help|how\s+do\s+you\s+help|what\s+help\s+can\s+you\s+(?:give|offer)|what\s+are\s+you\s+able\s+to\s+do)\b/i,
  /\b(who\s+are\s+you|what\s+are\s+you|tell\s+me\s+about\s+yourself|introduce\s+yourself)\b/i,
  /\b(what\s+do\s+you\s+know|do\s+you\s+know\s+about)\b/i,
  /\b(anything\s+(?:you|i)\s+can\s+help|what\s+can\s+i\s+ask\s+you)\b/i,
  /^\s*(help|hi\s+chipo|hello\s+chipo)\b/i,
];

/**
 * True when the question is just conversation - a greeting, a thank you, or
 * a question about what Chipo can do.
 *
 * @param {string} question
 * @returns {boolean}
 */
function isConversational(question) {
  const text = String(question || '').trim();
  if (!text) return false;
  return CONVERSATIONAL_PATTERNS.some((pattern) => pattern.test(text));
}

// The answer used when the question has nothing to do with the university.
const BOUNDARY_ANSWER = [
  "That's not really my area - I'm Chipo, the University of Lusaka student assistant, so I only cover UNILUS.",
  "Ask me about admissions, fees, programmes, results or the student portal and I'll help right away.",
].join(' ');

/**
 * Work out whether the question is something Chipo should answer rather
 * than refuse as out of bounds, and how confident that decision is.
 *
 * A file the user attached is always in scope - they handed it over on
 * purpose, and reading it is the whole point. A misspelt university
 * question is in scope too, as long as the misspelling is close enough to
 * one of the university words.
 *
 * @param {string} question
 * @param {{attachments?: Array<object>}} [options]
 * @returns {{inScope: boolean, fuzzy: boolean}} `fuzzy` is true when the
 *   question only matched after allowing for a typo
 */
function scopeCheck(question, options = {}) {
  if (Array.isArray(options.attachments) && options.attachments.length) {
    return { inScope: true, fuzzy: false };
  }

  const text = String(question || '').toLowerCase();
  if (!text.trim()) return { inScope: false, fuzzy: false };

  // A wellbeing crisis is never out of bounds, even when no university word
  // appears in it.
  if (isWellbeingConcern(question)) return { inScope: true, fuzzy: false };

  // Something clearly from another world, with nothing university in it.
  const otherWorld = OUT_OF_SCOPE_HINTS.some((hint) => text.includes(hint));
  const aboutUs = STRONG_UNILUS_HINTS.some((hint) => containsFuzzy(text, hint));
  if (otherWorld && !aboutUs) return { inScope: false, fuzzy: false };

  // Just chat - a greeting, a thank you, "what can you do?". Never out of
  // bounds, and Chipo answers it like a person would.
  if (isConversational(question)) return { inScope: true, fuzzy: false };

  // Every keyword is checked, not just up to the first hit, because a typo
  // can sit in a word that is not the keyword itself: "how do i aplly for a
  // deferment" matches "deferment" exactly, but "aplly" is still a typo.
  let fuzzy = false;
  let exact = false;
  for (const keyword of SCOPE_KEYWORDS) {
    const match = matchKeyword(text, keyword);
    if (match === 'exact') exact = true;
    else if (match === 'fuzzy') fuzzy = true;
  }
  if (exact || fuzzy) return { inScope: true, fuzzy };

  if (isPersonalPortalQuestion(question)) return { inScope: true, fuzzy: false };
  if (isPreAccountQuestion(question)) return { inScope: true, fuzzy: false };
  if (matchesPortalTopic(question)) return { inScope: true, fuzzy: false };

  return { inScope: false, fuzzy: false };
}

/**
 * True when the question is something Chipo should answer rather than
 * refuse as out of bounds.
 *
 * @param {string} question
 * @param {{attachments?: Array<object>}} [options]
 * @returns {boolean}
 */
function isInScope(question, options = {}) {
  return scopeCheck(question, options).inScope;
}

/* ------------------------------------------------------------------ *
 * Prompt rules
 * ------------------------------------------------------------------ */

const PUBLIC_RULES = [
  '- You have NO access to any student account or portal record right now. Never reveal personal records — student numbers, fee balances, payment history, registration status, results, timetables, exemption or appeal status — and never guess at them.',
  '- If the student asks about their OWN account or records — their fees, their results, their registration, their own exemption or appeal, their own timetable — say plainly that you need them to sign in to the student portal, invite them to ask again from there, and still answer any general part of the question you can.',
  '- For general questions about how the university works, just answer. Do not tell them to sign in unless it is really about their own records.',
  '- University-wide notices, published timetables and the general rules of each service are public and you may share them.',
].join('\n');

const STUDENT_RULES = [
  '- The student you are talking to IS signed in to the student portal. The portal records below are theirs, so answer questions about their profile, account status, fees, payments, courses, results, exemptions, appeals, class passes, graduation clearance and announcements using exactly that data.',
  '- Quote their own figures accurately. If a record is not in the context below, say you cannot see it and point them to the matching portal page or the Registry — never invent a number.',
  '- You may still answer general university questions in the usual warm, conversational tone.',
].join('\n');

// Both audiences get the same instruction: give the most useful answer the
// material allows, then be honest about the part you cannot cover.
const SCOPE_RULES = [
  '- You only know about the University of Lusaka. If the question is about something else entirely, say so briefly and naturally - one short, friendly sentence, no lecture and no list of everything you do - then offer to help with anything about the university instead.',
  '- Work out who you are talking to and answer for that person: a signed-in student wants their own records and figures, anyone else wants general guidance about how the university works. Use the rules below to tell them apart.',
  '- Give the most useful answer you can from what you actually have, then be straight about the part you cannot help with. Do not refuse outright when you can still answer part of the question.',
  '- If the user is just greeting you, thanking you, saying goodbye, or asking what you can do or what you know, reply the way a friendly person would - warmly and briefly. Say hello, tell them in a sentence or two what you can help with, and invite the question. Do not refuse, do not list every service, and do not quote documents at someone who has only said hello.',
].join('\n');

/* ------------------------------------------------------------------ *
 * Context builders
 * ------------------------------------------------------------------ */

// A short, factual overview so questions like "what do you know about the
// school?" or "what can you do?" can be answered from real material instead
// of the model either inventing details or saying it has none.
const UNIVERSITY_OVERVIEW = [
  'About the university:',
  '- The University of Lusaka (UNILUS) is a private university in Lusaka, Zambia.',
  '- Teaching is organised into faculties and schools, and the university awards undergraduate, postgraduate and professional qualifications.',
  '- The Admissions Office handles applications, and the registry keeps the academic records.',
  '- The student portal is where a student registers for courses, sees results, pays fees, applies for exemptions, appeals and deferments, and follows graduation clearance.',
].join('\n');

function formatFacts(facts) {
  const entries = Object.entries(facts || {});
  if (!entries.length) return [];
  return entries.map(([label, value]) => `- ${label}: ${value}`);
}

function formatRows(columns, rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const header = (columns && columns.length ? columns : Object.keys(rows[0])).join(' | ');
  const lines = [`  | ${header} |`];
  for (const row of rows) {
    lines.push(`  | ${row.join(' | ')} |`);
  }
  return lines;
}

/**
 * The context handed to the model when the visitor has no student session.
 * Only public material ends up here — notices, published timetable links and
 * a short description of what each portal service does.
 * @param {{announcements?: any[], timetables?: any[], services?: any[]}} payload
 * @returns {string}
 */
function buildPublicContext(payload = {}) {
  const { announcements = [], timetables = [], services = [] } = payload;
  const lines = [UNIVERSITY_OVERVIEW, ''];

  if (announcements.length) {
    lines.push('University notices currently published on the student portal:');
    for (const item of announcements) {
      const date = item.publishedAt ? String(item.publishedAt).slice(0, 10) : '';
      const body = String(item.body || '').replace(/\s+/g, ' ').trim();
      lines.push(`- [${item.category || 'Notice'}${date ? `, ${date}` : ''}] ${item.title}`);
      if (body) lines.push(`  ${body.slice(0, 600)}`);
    }
    lines.push('');
  }

  if (timetables.length) {
    lines.push('Published timetable documents (links are available on the portal):');
    lines.push(timetables.map((item) => item.name).join('; '));
    lines.push('');
  }

  if (services.length) {
    lines.push('What each student portal service is for:');
    for (const service of services) {
      const sample = service.sample || {};
      const intro = sample.intro || 'The student home dashboard.';
      lines.push(`- ${service.label}: ${intro}`);
      // General guidance (what evidence is needed, which units have to clear
      // a record) is policy, not personal data, so it stays visible.
      if (sample.publicGuide) {
        lines.push(...formatRows(sample.publicGuide.columns, sample.publicGuide.rows));
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * The context handed to the model when the visitor is signed in: everything
 * from the public context plus that student's own portal records.
 * @param {{student?: any, services?: any[], announcements?: any[], timetables?: any[]}} payload
 * @returns {string}
 */
function buildStudentContext(payload = {}) {
  const { student = null, services = [], announcements = [], timetables = [] } = payload;
  const lines = [UNIVERSITY_OVERVIEW, ''];

  if (student) {
    lines.push(`Signed-in student: ${student.fullName} (student number ${student.studentNumber}).`);
    const details = [
      ['Role', student.role],
      ['Programme', student.programme],
      ['Faculty', student.faculty],
      ['Year of study', student.yearOfStudy],
      ['Email', student.email],
      ['Phone', student.phone],
      ['Account status', student.status],
    ].filter(([, value]) => value);
    if (details.length) {
      lines.push(details.map(([label, value]) => `- ${label}: ${value}`).join('\n'));
    }
    lines.push('');
  }

  for (const service of services) {
    const sample = service.sample;
    if (!sample) continue;
    lines.push(`${service.label}: ${sample.intro || ''}`.trim());
    const facts = formatFacts(sample.facts);
    if (facts.length) lines.push(...facts);
    lines.push(...formatRows(sample.columns, sample.rows));
    lines.push('');
  }

  if (announcements.length) {
    lines.push('Notices published on the student portal:');
    for (const item of announcements) {
      const date = item.publishedAt ? String(item.publishedAt).slice(0, 10) : '';
      const body = String(item.body || '').replace(/\s+/g, ' ').trim();
      lines.push(`- [${item.category || 'Notice'}${date ? `, ${date}` : ''}] ${item.title}`);
      if (body) lines.push(`  ${body.slice(0, 600)}`);
    }
    lines.push('');
  }

  if (timetables.length) {
    lines.push('Timetable documents linked on the portal:');
    for (const item of timetables) {
      lines.push(`- ${item.name} (academic year ${item.academicYear}, semester ${item.semester})`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/* ------------------------------------------------------------------ *
 * Safety net
 * ------------------------------------------------------------------ */

// Student numbers and similar identifiers must never appear in a public
// answer. The context gate already prevents them from reaching the model;
// this scrubs anything that slips through (for example from the RAG corpus).
const IDENTIFIER_PATTERN = /\b[A-Z]{2,4}\d{6,}\b/g;

function scrubIdentifiers(text) {
  if (!text) return text;
  return String(text).replace(IDENTIFIER_PATTERN, '[withheld]');
}

module.exports = {
  isPersonalPortalQuestion,
  matchesPortalTopic,
  isInScope,
  scopeCheck,
  isConversational,
  matchKeyword,
  containsFuzzy,
  editDistance,
  LOCKED_ANSWER,
  PRE_ACCOUNT_ANSWER,
  isPreAccountQuestion,
  isWellbeingConcern,
  isVagueFollowUp,
  BOUNDARY_ANSWER,
  PUBLIC_RULES,
  STUDENT_RULES,
  SCOPE_RULES,
  buildPublicContext,
  buildStudentContext,
  scrubIdentifiers,
  PERSONAL_TOPICS,
  PERSONAL_MARKERS,
  PORTAL_TOPIC_PATTERNS,
  SCOPE_KEYWORDS,
};
