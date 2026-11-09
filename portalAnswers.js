// portalAnswers.js
//
// Direct answers to "my ..." questions from a signed-in student's own portal
// records: courses, fees and balance, payments, programme and year, contact
// details, graduation, appeals, class passes, timetable links and notices.
//
// This needs no language model, so a student gets the right figures even when
// Groq and Gemini are unavailable, and the numbers come straight from the
// records, not from a model's reading of them. It only ever runs for a
// signed-in student, with that student's own payload; the public site never
// reaches it.
//
// It answers only when the question is clearly about the student's own record
// (a personal marker next to a topic). General questions - "what are the fees
// for BSc IT", "how do I apply" - return null and go to the documents.

const { containsFuzzy, isPersonalPortalQuestion } = require('./portalAccess.js');

const has = (text, ...words) => words.some((word) => containsFuzzy(text, word));
const rx = (text, pattern) => pattern.test(text);

function service(payload, key) {
  const found = (payload.services || []).find((s) => s.key === key);
  return found && found.sample ? found.sample : null;
}

const money = (value) => (value === undefined || value === null || value === '' ? '' : String(value));

function table(columns, rows) {
  if (!rows || !rows.length) return [];
  return rows.map((row) => `- ${row.map((cell) => String(cell)).join(' | ')}`);
}

function fact(sample, label) {
  if (!sample || !sample.facts) return null;
  const key = Object.keys(sample.facts).find((k) => k.toLowerCase() === label.toLowerCase());
  return key ? sample.facts[key] : null;
}

const MISSING = "I can't see that on your portal record yet. The Registry can confirm or update it for you.";

// What each topic says, built from the records. Each returns an array of lines or null.
const TOPICS = [
  {
    name: 'lecturer',
    match: (t) => rx(t, /\b(lecturer|lecturers|teacher|teachers|taught|teaches|instructor)\b/),
    build(t, payload) {
      const sample = service(payload, 'elearning');
      if (!sample) return null;
      const named = sample.rows.filter((row) => t.includes(String(row[1]).toLowerCase()) || t.includes(String(row[0]).toLowerCase()));
      if (named.length) return named.map((row) => `${row[1]} (${row[0]}) is taught by ${row[2]}.`);
      return ['Your lecturers this semester:', ...sample.rows.map((row) => `- ${row[1]} (${row[0]}): ${row[2]}`)];
    },
  },
  {
    name: 'materials',
    match: (t) => rx(t, /\b(materials?|notes|slides|files|e-?learning)\b/),
    build(t, payload) {
      const sample = service(payload, 'elearning');
      if (!sample) return null;
      return [sample.intro, ...sample.rows.map((row) => `- ${row[1]} (${row[0]}): ${row[3]}`)];
    },
  },
  {
    name: 'credits',
    match: (t) => rx(t, /\bcredits?\b/),
    build(t, payload) {
      const sample = service(payload, 'course-registration');
      const total = fact(sample, 'Total credits');
      return total ? [`You are registered for ${total} credits this semester.`] : null;
    },
  },
  {
    name: 'courses',
    match: (t) => rx(t, /\b(courses?|modules?|subjects?|units?|registered|registration|enrolled|enrolment|taking)\b/) && !rx(t, /\b(programme|program|degree|study|studying|faculty)\b.*\bwhat\b.*\bam i\b/),
    build(t, payload) {
      const sample = service(payload, 'course-registration');
      if (!sample) return null;
      const lines = [sample.intro];
      lines.push(...sample.rows.map((row) => `- ${row[1]} (${row[0]}), ${row[2]} credits: ${row[3]}`));
      const credits = fact(sample, 'Total credits');
      if (credits) lines.push(`Total credits: ${credits}.`);
      const updated = fact(sample, 'Last updated');
      if (updated) lines.push(`Last updated: ${updated}.`);
      return lines;
    },
  },
  {
    name: 'payments',
    match: (t) => rx(t, /\b(paid|payments?|receipts?|paying|pay)\b/) && !rx(t, /\bhow\s+(?:do|can|to)\b/) && !rx(t, /\b(owe|balance|outstanding)\b/),
    build(t, payload) {
      const sample = service(payload, 'payments');
      if (!sample) return null;
      const lines = [sample.intro];
      lines.push(...sample.rows.map((row) => `- ${row[1]} (${row[0]}), ${row[2]}: ZMW ${row[3]}`));
      const paid = fact(sample, 'Total paid');
      const owing = fact(sample, 'Total outstanding');
      if (paid) lines.push(`Total paid: ZMW ${paid.replace(/\s*ZMW$/i, '')}.`);
      if (owing) lines.push(`Still outstanding: ZMW ${owing.replace(/\s*ZMW$/i, '')}.`);
      return lines;
    },
  },
  {
    name: 'balance',
    match: (t) => rx(t, /\b(owe|owing|balance|outstanding|arrears|debt|fees?|tuition|quotation|charges?|billed|bill|invoice|due)\b/),
    build(t, payload) {
      const sample = service(payload, 'quotations');
      if (!sample) return null;
      const total = sample.rows.find((row) => /outstanding/i.test(row[0]));
      const lines = [];
      if (total) lines.push(`Your outstanding balance is ZMW ${total[1]} (${String(total[2]).toLowerCase()}).`);
      lines.push('What you have been billed this semester:');
      lines.push(...sample.rows.filter((row) => row !== total).map((row) => `- ${row[0]}: ZMW ${row[1]} (${row[2]})`));
      const pay = service(payload, 'payments');
      const paid = fact(pay, 'Total paid');
      if (paid) lines.push(`Payments received so far: ZMW ${paid.replace(/\s*ZMW$/i, '')}.`);
      return lines;
    },
  },
  {
    name: 'profile',
    match: (t) => rx(t, /\b(programme|program|degree|faculty|school|year|level|semester|studying|study|major|role|status|standing|active)\b/)
      && rx(t, /\b(my|am i|i am|do i|what\s+(?:year|programme|program|faculty|level))\b/)
      && !rx(t, /\b(graduat|appeal|class pass|deferment|exemption|clearance)\w*/),
    build(t, payload) {
      const s = payload.student || {};
      // Identity comes from this student's own record only, never from the
      // portal's sample data.
      const wanted = [];
      if (/programme|program|degree|studying|study|major/.test(t)) wanted.push(['Programme', s.programme], ['Faculty', s.faculty], ['Year of study', s.yearOfStudy]);
      else {
        if (/faculty|school/.test(t)) wanted.push(['Faculty', s.faculty]);
        if (/year|level|semester/.test(t)) wanted.push(['Year of study', s.yearOfStudy]);
        if (/status|active|standing/.test(t)) wanted.push(['Account status', s.status]);
        if (/\brole\b/.test(t)) wanted.push(['Role', s.role]);
      }
      if (!wanted.length) wanted.push(['Programme', s.programme], ['Faculty', s.faculty], ['Year of study', s.yearOfStudy], ['Account status', s.status]);
      const lines = wanted.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
      return lines.length ? lines : [MISSING];
    },
  },
  {
    name: 'contact',
    match: (t) => rx(t, /\b(email|e-mail|phone|mobile|number|contact|name|student number|student id|details|information)\b/)
      && rx(t, /\b(my|i)\b/) && !rx(t, /\b(email|phone|number)\s+(?:is|to be|should)\b/) && !rx(t, /\b(ticket|reference|fee|receipt)\b/),
    build(t, payload) {
      const s = payload.student || {};
      const lines = [];
      const add = (label, value) => { if (value) lines.push(`${label}: ${value}`); };
      const wantsAll = /details|information|profile|record/.test(t) && !/email|phone|mobile/.test(t);
      if (wantsAll || /name/.test(t)) add('Full name', s.fullName);
      if (wantsAll || /student (?:number|id)|\bnumber\b/.test(t) && !/phone|mobile/.test(t)) add('Student number', s.studentNumber);
      if (wantsAll || /e-?mail/.test(t)) add('Email', s.email);
      if (wantsAll || /phone|mobile|contact|number/.test(t)) add('Phone', s.phone);
      if (wantsAll) { add('Programme', s.programme); add('Faculty', s.faculty); add('Year of study', s.yearOfStudy); add('Account status', s.status); }
      if (!lines.length) return [MISSING];
      lines.push('To correct any of these, contact the Registry.');
      return lines;
    },
  },
  {
        name: 'graduation',
    match: (t) => rx(t, /\b(graduat\w*|ceremony|clearance|cleared|convocation)\b/),
    build(t, payload) {
      const confirm = service(payload, 'graduation-confirmation');
      const clearance = service(payload, 'graduation-clearance');
      const lines = [];
      if (confirm) {
        const status = fact(confirm, 'Confirmation status');
        const expected = fact(confirm, 'Expected graduation');
        const ceremony = fact(confirm, 'Ceremony');
        if (expected) lines.push(`Expected graduation: ${expected}.`);
        if (ceremony) lines.push(`Ceremony: ${ceremony}.`);
        if (status) lines.push(`Your graduation confirmation is: ${status}.`);
      }
      if (clearance && (/clear/.test(t) || !lines.length || /status|graduat/.test(t))) {
        lines.push('Clearance by unit:');
        lines.push(...clearance.rows.map((row) => `- ${row[0]}: ${row[1]}${row[2] && row[2] !== '—' ? ` (${row[2]})` : ''}`));
        const open = clearance.rows.filter((row) => /outstanding/i.test(row[1])).map((row) => row[0]);
        if (open.length) lines.push(`Still to clear: ${open.join(', ')}.`);
      }
      return lines.length ? lines : null;
    },
  },
  {
    name: 'appeals',
    match: (t) => rx(t, /\bappeals?\b/) && rx(t, /\b(my|i|have|any|status)\b/),
    build(t, payload) {
      const sample = service(payload, 'student-appeal');
      if (!sample) return null;
      return [sample.intro, ...sample.rows.map((row) => `- ${row[0]}: ${row[1]} (submitted ${row[2]}) - ${row[3]}`)];
    },
  },
  {
    name: 'classpass',
    match: (t) => rx(t, /\bclass\s*pass(es)?\b/),
    build(t, payload) {
      const sample = service(payload, 'class-pass');
      if (!sample) return null;
      return [sample.intro, ...sample.rows.map((row) => `- ${row[0]}: ${row[1]}, ${row[2]} - ${row[3]}`)];
    },
  },
  {
    name: 'deferment',
    match: (t) => rx(t, /\b(deferment|deferral|defer|deferred)\b/) && rx(t, /\b(my|i|status|applied)\b/) && !rx(t, /\bhow\s+(?:do|can|to)\b/),
    build(t, payload) {
      const sample = service(payload, 'deferment');
      if (!sample) return null;
      const lines = [];
      for (const label of ['Application status', 'Current intake', 'Proposed intake', 'Deadline for applications']) {
        const value = fact(sample, label);
        if (value) lines.push(`${label}: ${value}`);
      }
      return lines.length ? lines : null;
    },
  },
  {
    name: 'accounts',
    match: (t) => rx(t, /\b(other|linked|switch)\s+accounts?\b|\bmy\s+accounts\b/),
    build(t, payload) {
      const sample = service(payload, 'accounts-switch');
      if (!sample) return null;
      return [sample.intro, ...sample.rows.map((row) => `- ${row[0]}: ${row[1]}, ${row[2]} (${row[3]})`)];
    },
  },
  {
    name: 'timetable',
    match: (t) => rx(t, /\btime\s*tables?\b/) && rx(t, /\b(my|i)\b/),
    build(t, payload) {
      const list = payload.timetables || [];
      if (!list.length) return null;
      const s = payload.student || {};
      const hint = [s.programme, s.faculty].filter(Boolean).join(' ').toLowerCase();
      const lines = ['Timetables are published per school or programme. Open the Timetable section of the portal and pick yours.'];
      const likely = list.filter((item) => hint && item.name.toLowerCase().split(/\W+/).some((w) => w.length > 3 && hint.includes(w)));
      const shown = (likely.length ? likely : list).slice(0, 8);
      lines.push(`${likely.length ? 'Likely yours' : 'Published timetables'}: ${shown.map((i) => i.name).join('; ')} (semester ${shown[0].semester}, ${shown[0].academicYear}).`);
      return lines;
    },
  },
  {
    name: 'notices',
    match: (t) => rx(t, /\b(announcements?|notices?|news)\b/) && !rx(t, /\bhow\s+(?:do|can|to)\b/),
    build(t, payload) {
      const list = payload.announcements || [];
      if (!list.length) return null;
      return ['Latest notices on the portal:', ...list.slice(0, 5).map((a) => `- ${a.title}${a.publishedAt ? ` (${String(a.publishedAt).slice(0, 10)})` : ''}`)];
    },
  },
];

/** Topics the question is about, in the order above, at most three. */
function topicsFor(text) {
  return TOPICS.filter((topic) => topic.match(text)).slice(0, 3);
}

/**
 * @param {string} question
 * @param {object} payload  studentPortal.getContextPayload(student)
 * @returns {{answer: string, topics: string[]}|null}
 */
function answerFromRecords(question, payload) {
  if (!payload || !payload.student) return null;
  const text = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text || text.length > 400) return null;

  // Only a question that is plainly about the student's own record.
  const personal = isPersonalPortalQuestion(question)
    || /\b(?:what|which|show|tell|give|list|how many|how much|when|who|do|am|have|is|are)\b.*\b(?:my|mine|i am|am i|do i|have i|i have|i owe)\b/.test(text)
    || /^\s*(?:my|show my|check my)\b/.test(text);
  if (!personal) return null;
  // A how-to or general question that merely mentions "my".
  if (/\bhow\s+(?:do|can|should|would)\s+i\s+(?:apply|register|pay|change|reset|get|submit|appeal|defer|find|access|log)/.test(text)) return null;
  if (/\b(?:is|are)\s+(?:my|the)\s+(?:email|phone|number)\s+(?:is|correct)\b/.test(text)) return null;

  const topics = topicsFor(text);
  const sections = [];
  const used = [];
  for (const topic of topics) {
    let lines = null;
    try { lines = topic.build(text, payload); } catch (err) { lines = null; }
    if (lines && lines.length) { sections.push(lines.join('\n')); used.push(topic.name); }
  }
  if (!sections.length) return null;
  return { answer: sections.join('\n\n'), topics: used };
}

module.exports = { answerFromRecords, topicsFor };
