// priority.js
//
// Ticket priority: low, medium, high or critical. The system picks one when a
// ticket is opened (from the wording of the question and why it was escalated)
// and staff can change it afterwards.

const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

const CRITICAL = [
  /\b(suicid|kill myself|end my life|self[- ]?harm|hurt myself|want to die)\b/i,
  /\b(sexual(ly)? (assault|harass)|rape[ds]?\b|assault|abus(e|ed|ive)\b|stalk|threat(en|ened|ening)\b|unsafe\b|in danger\b|emergency\b)/i,
  /\b(bleeding|unconscious|overdose)\b/i,
];

const HIGH = [
  /\b(urgent|urgently|asap|immediately|right now)\b/i,
  /\b(exam|test|assessment|paper)s?\b.*\b(tomorrow|today|this week|next week|tonight|blocked|barred|cannot sit|can'?t sit)\b/i,
  /\b(deadline|due)\b.*\b(tomorrow|today|tonight|this week)\b/i,
  /\b(locked out|cannot (log ?in|access)|can'?t (log ?in|access)|account (locked|blocked|suspended))\b/i,
  /\b(deregistered|de-registered|expelled|suspended|barred|blocked from)\b/i,
  /\b(missing|wrong|incorrect|failed to) (result|grade|mark)s?\b/i,
  /\b(complain|complaint|discriminat|bully|bullied|harass)/i,
];

const LOW = [
  /\b(just (wondering|curious)|general (question|information)|no rush|whenever|not urgent)\b/i,
  /\b(opening hours|office hours|where is|how do i find|library hours)\b/i,
];

function normalizePriority(value) {
  const priority = String(value || '').trim().toLowerCase();
  return PRIORITIES.includes(priority) ? priority : null;
}

/** Decide a priority from the question text and why it was escalated. */
function detectPriority({ question, reason, conversationSummary } = {}) {
  if (reason === 'wellbeing') return 'critical';
  const text = `${question || ''}`.slice(0, 4000);
  if (CRITICAL.some((pattern) => pattern.test(text))) return 'critical';
  if (HIGH.some((pattern) => pattern.test(text))) return 'high';
  if (LOW.some((pattern) => pattern.test(text))) return 'low';
  return 'medium';
}

// For sorting: most urgent first.
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

module.exports = { PRIORITIES, PRIORITY_LABELS, PRIORITY_RANK, normalizePriority, detectPriority };
