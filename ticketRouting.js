const DEFAULT_ROUTING_TERMS = {
  accounts: ['account', 'accounts', 'accounting', 'finance', 'financial', 'bursar', 'fee', 'fees', 'tuition', 'payment', 'payments', 'invoice', 'refund', 'balance'],
  it: ['ict', 'it support', 'it issue', 'it problem', 'technical', 'technology', 'computer', 'network', 'wifi', 'software', 'hardware', 'internet', 'login', 'password'],
  library: ['library', 'librarian', 'book', 'books', 'borrowing', 'student id', 'id card', 'identification card', 'student card', 'replacement card'],
  admissions: ['admission', 'admissions', 'application', 'applications', 'admissions office', 'admission letter', 'enrollment', 'enrolment'],
  academic: ['academic', 'programme', 'program', 'course', 'curriculum', 'study plan', 'exam', 'timetable', 'class schedule', 'lecturer', 'lecture'],
  postgraduate: ['postgraduate', 'postgrad', 'masters', 'master', 'phd', 'research', 'thesis', 'supervision'],
  registry: ['transcript', 'result', 'course registration', 'records', 'certificate', 'academic record', 'graduation'],
  studentAffairs: ['accommodation', 'housing', 'wellbeing', 'discipline', 'student support', 'campus life'],
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
  return new RegExp(`(^| )${pattern}( |$)`).test(text);
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

function isTicketRequest(question) {
  const text = normalizeText(question);
  if (/\b(check|track|find|look up|status|update)\b.*\bticket\b/.test(text)) return false;
  return /\b(?:create|creating|open|opening|raise|raising|submit|submitting|send|sending|make|making)\s+(?:me\s+)?(?:a\s+)?(?:support\s+)?ticket\b/.test(text)
    || /\b(?:need|want)\s+(?:you\s+to\s+)?(?:create|open|raise|submit|send|make)\s+(?:me\s+)?(?:a\s+)?(?:support\s+)?ticket\b/.test(text)
    || /\b(?:need|want)\s+(?:a\s+)?(?:support\s+)?ticket\b/.test(text)
    || /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:create|open|raise|submit|send|make)\s+(?:me\s+)?(?:a\s+)?(?:support\s+)?ticket\b/.test(text);
}

function resolveTicketDepartment(question, departments, preferredDepartmentId = null) {
  if (preferredDepartmentId) return preferredDepartmentId;
  const normalizedQuestion = normalizeText(question);

  const matchingDepartment = departments.find((department) => {
    const category = categoryForDepartment(department.name);
    const terms = [
      department.name,
      ...(department.routingKeywords || []),
      ...(category ? DEFAULT_ROUTING_TERMS[category] : []),
    ];
    return terms.some((term) => includesTerm(normalizedQuestion, term));
  });
  if (matchingDepartment) return matchingDepartment.id;

  return departments.find((department) => categoryForDepartment(department.name) === 'studentAffairs')?.id || null;
}

module.exports = { isTicketRequest, resolveTicketDepartment };