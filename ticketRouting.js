const DEFAULT_ROUTING_TERMS = {
  accounts: ['account', 'accounts', 'accounting', 'finance', 'financial', 'bursar', 'fee', 'fees', 'tuition', 'payment', 'payments', 'invoice', 'refund', 'balance'],
  it: ['ict', 'it support', 'it issue', 'it problem', 'technical', 'technology', 'computer', 'network', 'wifi', 'software', 'hardware', 'internet', 'login', 'password'],
  library: ['library', 'librarian', 'book', 'books', 'borrowing', 'student id', 'id card', 'identification card', 'student card', 'replacement card'],
  admissions: ['admission', 'admissions', 'application', 'applications', 'admissions office', 'admission letter', 'enrollment', 'enrolment'],
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
  return null;
}

function resolveTicketDepartment(question, departments, preferredDepartmentId = null) {
  if (preferredDepartmentId) return preferredDepartmentId;
  const normalizedQuestion = normalizeText(question);

  return departments.find((department) => {
    const category = categoryForDepartment(department.name);
    const terms = [
      department.name,
      ...(department.routingKeywords || []),
      ...(category ? DEFAULT_ROUTING_TERMS[category] : []),
    ];
    return terms.some((term) => includesTerm(normalizedQuestion, term));
  })?.id || null;
}

module.exports = { resolveTicketDepartment };