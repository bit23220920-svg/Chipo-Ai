const { containsFuzzy, editDistance } = require('./portalAccess.js');

const DEFAULT_ROUTING_TERMS = {
  accounts: ['account', 'accounts', 'accounting', 'finance', 'financial', 'bursar', 'fee', 'fees', 'tuition', 'payment', 'payments', 'invoice', 'refund', 'balance'],
  it: ['ict', 'it support', 'it issue', 'it problem', 'technical', 'technology', 'computer', 'network', 'wifi', 'software', 'hardware', 'internet', 'login', 'password'],
  library: ['library', 'librarian', 'book', 'books', 'borrowing', 'student id', 'id card', 'identification card', 'student card', 'replacement card'],
  admissions: ['admission', 'admissions', 'application', 'applications', 'admissions office', 'admission letter', 'enrollment', 'enrolment'],
  academic: ['academic', 'programme', 'program', 'course', 'curriculum', 'study plan', 'exam', 'timetable', 'class schedule', 'lecturer', 'lecture', 'deferment', 'deferral'],
  postgraduate: ['postgraduate', 'postgrad', 'masters', 'master', 'phd', 'research', 'thesis', 'supervision'],
  registry: ['transcript', 'result', 'exam results', 'exam slip', 'course registration', 'records', 'certificate', 'academic record', 'graduation'],
  studentAffairs: ['accommodation', 'housing', 'hostel', 'hostel accommodation', 'hostel application', 'residence', 'room allocation', 'matron', 'patron', 'wellbeing', 'discipline', 'student support', 'campus life'],
};

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function includesTerm(text, term) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  const pattern = normalizedTerm
    .split(' ')
    .map((word) => {
      const singular = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
      return singular.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (singular.length > 3 ? 's?' : '');
    })
    .join(' ');
  if (new RegExp(`(^| )${pattern}( |$)`).test(text)) return true;

  // A misspelt word is still the same word: "regitration" still belongs to
  // the registry, "acomodation" still belongs to student affairs.
  return containsFuzzy(text, normalizedTerm);
}

function categoryForDepartment(name) {
  const normalizedName = normalizeText(name);
  if (/(^| )(accounts?|accounting|finance|financial|bursar)( |$)/.test(normalizedName)) return 'accounts';
  if (/(^| )(it|ict|technical|technology|computer|information technology)( |$)/.test(normalizedName)) return 'it';
  if (/(^| )(library|libraries)( |$)/.test(normalizedName)) return 'library';
  if (/(^| )(admissions?|enrollment|enrolment)( |$)/.test(normalizedName)) return 'admissions';
  if (/(^| )(academic|academics|academic office)( |$)/.test(normalizedName)) return 'academic';
  if (/(^| )(postgraduate|postgrad)( |$)/.test(normalizedName)) return 'postgraduate';
  if (/(^| )(registry|registrar)( |$)/.test(normalizedName)) return 'registry';
  if (/(^| )(student affairs|student services)( |$)/.test(normalizedName)) return 'studentAffairs';
  return null;
}

// Words that mean "I want a person to look at this". A misspelt one still
// counts - "i need a suport ticket" is still a ticket request.
const TICKET_ACTION_WORDS = ['create', 'open', 'raise', 'submit', 'make', 'need', 'want'];

function closeTo(token, word, tolerance = 1) {
  if (token === word) return true;
  if (Math.abs(token.length - word.length) > tolerance) return false;
  return editDistance(token, word) <= tolerance;
}

/**
 * The same question as the patterns above, but typed with a mistake:
 * "i need a suport ticket about my fees" still asks for a ticket.
 */
function asksForATicketWithATypo(text) {
  const tokens = text.split(' ');
  const ticketIndex = tokens.findIndex((token) => closeTo(token, 'ticket'));
  if (ticketIndex === -1) return false;

  for (let offset = 1; offset <= 3; offset++) {
    const index = ticketIndex - offset;
    if (index < 0) break;
    const token = tokens[index];
    // "open a support ticket" - the action sits just in front of it, with
    // "a" and "support" in between.
    if (offset <= 3 && ['create', 'open', 'raise', 'submit', 'make'].some((word) => closeTo(token, word))) {
      return true;
    }
    // "need a ticket" / "want a ticket" - one short word may sit in between.
    if (offset <= 3 && ['need', 'want'].some((word) => closeTo(token, word))) {
      return true;
    }
  }
  return false;
}

// "I need to speak to someone" is a request for a person, not for a ticket -
// but the effect is the same: Chipo cannot help and a human has to take over.
const CONTACT_VERBS = ['speak', 'talk', 'chat', 'call', 'ring', 'whatsapp'];

// A person, not a department. "How do I contact the accounts office?" is a
// question Chipo can answer, so an office name on its own is not enough.
const PERSON_TARGETS = [
  'someone', 'somebody', 'person', 'human', 'officer', 'administrator', 'staff',
  'registrar', 'dean', 'bursar', 'matron', 'tutor', 'lecturer', 'counsellor',
  'counselor', 'advisor', 'adviser', 'representative',
];

function asksForAHuman(text) {
  // "put me through", "get me a human", "arrange for someone to call me".
  if (/\bput me through\b/.test(text)) return true;
  if (/\b(?:get|give) me (?:a |an )?(?:human|person|somebody|someone|live|real)\b/.test(text)) return true;
  if (/\barrange (?:for )?someone to (?:call|contact|reach) me\b/.test(text)) return true;
  if (/\b(?:real|live|actual) (?:human|person)\b/.test(text)) return true;

  const tokens = text.split(' ');
  for (let i = 0; i < tokens.length; i++) {
    if (!CONTACT_VERBS.includes(tokens[i])) continue;
    // "speak to someone", "talk to the registrar", "call a member of staff".
    for (let offset = 1; offset <= 3; offset++) {
      const token = tokens[i + offset];
      if (!token) break;
      if (PERSON_TARGETS.some((target) => closeTo(token, target))) return true;
    }
  }
  return false;
}

function isTicketRequest(question) {
  const text = normalizeText(question);
  if (/\b(check|track|find|look up|status|update)\b.*\bticket\b/.test(text)) return false;
  const asked = /\b(?:create|creating|open|opening|raise|raising|submit|submitting|send|sending|make|making)\s+(?:me\s+)?(?:a\s+)?(?:support\s+)?ticket\b/.test(text)
    || /\b(?:need|want)\s+(?:you\s+to\s+)?(?:create|open|raise|submit|send|make)\s+(?:me\s+)?(?:a\s+)?(?:support\s+)?ticket\b/.test(text)
    || /\b(?:need|want)\s+(?:a\s+)?(?:support\s+)?ticket\b/.test(text)
    || /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:create|open|raise|submit|send|make)\s+(?:me\s+)?(?:a\s+)?(?:support\s+)?ticket\b/.test(text);
  if (asked) return true;
  if (asksForAHuman(text)) return true;
  return asksForATicketWithATypo(text);
}

function matchingDepartmentForText(text, departments) {
  // "Scholarship application" or "hostel application" is not an admissions
  // application, so drop the extra word before scoring. Otherwise Admissions
  // ties with the office that actually owns the subject.
  const normalizedText = normalizeText(text).replace(
    /\b(scholarship|bursary|hostel|accommodation|deferment|deferral|exemption|appeal|job)\s+applications?\b/g,
    '$1'
  );
  // The department that matches the most words wins, so "my hostel
  // application" goes to Student Affairs and not to Admissions, which also
  // hears about applications.
  let best = null;
  let bestScore = 0;
  for (const department of departments) {
    const category = categoryForDepartment(department.name);
    const terms = [
      department.name,
      ...(department.routingKeywords || []),
      ...(category ? DEFAULT_ROUTING_TERMS[category] : []),
    ];
    // The same word can be listed twice - once by the department and once by
    // the defaults, and "application" and "applications" are the same word.
    // Count each one only once, but keep every spelling of it, so a typo
    // still finds the word it was meant to be.
    const wordGroups = new Map();
    for (const term of terms) {
      const clean = normalizeText(term);
      if (!clean) continue;
      const key = clean.length > 3 && clean.endsWith('s') ? clean.slice(0, -1) : clean;
      if (!wordGroups.has(key)) wordGroups.set(key, []);
      wordGroups.get(key).push(clean);
    }
    const score = [...wordGroups.values()]
      .filter((variants) => variants.some((variant) => includesTerm(normalizedText, variant)))
      .length;
    if (score > bestScore) {
      best = department;
      bestScore = score;
    }
  }
  return best;
}

// Questions about the university itself - how many campuses, how many
// programmes - are Admissions' business, even though the words themselves are
// common ones that would otherwise send the question to the wrong office.
const GENERAL_INFO = /\b(?:how many|list|name of|which|what)\b[^?]{0,60}\b(?:campus|campuses|programme|programmes|program|programs|faculty|faculties|schools?)\b/;

function resolveTicketDepartment(question, departments, preferredDepartmentId = null, routingContext = []) {
  if (GENERAL_INFO.test(normalizeText(question))) {
    const admissions = departments.find((department) => categoryForDepartment(department.name) === 'admissions');
    if (admissions) return admissions.id;
  }

  const currentQuestionMatch = matchingDepartmentForText(question, departments);
  if (currentQuestionMatch) return currentQuestionMatch.id;

  for (const previousQuestion of [...routingContext].reverse()) {
    const contextMatch = matchingDepartmentForText(previousQuestion, departments);
    if (contextMatch) return contextMatch.id;
  }

  if (preferredDepartmentId) return preferredDepartmentId;

  return departments.find((department) => categoryForDepartment(department.name) === 'studentAffairs')?.id
    || null;
}

module.exports = { isTicketRequest, asksForAHuman, resolveTicketDepartment };