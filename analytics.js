// analytics.js
//
// Numbers for the admin dashboard. Counting is done in SQL where that is
// portable; per-day and resolution-time figures are worked out in JS so the
// same code runs on MySQL and on Turso/SQLite.

const { query } = require('./db.js');

function sqlTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toDate(value) {
  if (value instanceof Date) return value;
  const s = String(value || '');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

async function counts(sql, params) {
  const { rows } = await query(sql, params);
  const out = {};
  for (const row of rows) out[row.label === null || row.label === undefined ? 'unknown' : String(row.label)] = Number(row.total);
  return out;
}

async function overview({ days = 30 } = {}) {
  const span = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const since = new Date(Date.now() - span * 24 * 3600 * 1000);
  const sinceSql = sqlTime(since);

  const [totalRow, humanRow, avgRow] = await Promise.all([
    query('SELECT COUNT(*) AS total FROM chat_messages WHERE created_at >= $1', [sinceSql]),
    query('SELECT COUNT(*) AS total FROM chat_messages WHERE created_at >= $1 AND needs_human = $2', [sinceSql, 1]),
    query('SELECT AVG(confidence) AS average FROM chat_messages WHERE created_at >= $1 AND confidence IS NOT NULL', [sinceSql]),
  ]);
  const questions = Number(totalRow.rows[0]?.total || 0);
  const escalated = Number(humanRow.rows[0]?.total || 0);

  const bySource = await counts('SELECT source AS label, COUNT(*) AS total FROM chat_messages WHERE created_at >= $1 GROUP BY source', [sinceSql]);
  const signedIn = await query('SELECT COUNT(*) AS total FROM chat_messages WHERE created_at >= $1 AND student_id IS NOT NULL', [sinceSql]);

  // Questions per day.
  const perDayRows = await query('SELECT created_at, needs_human FROM chat_messages WHERE created_at >= $1 ORDER BY created_at ASC LIMIT 50000', [sinceSql]);
  const perDay = {};
  for (let i = 0; i < Math.min(span, 90); i++) {
    perDay[dayKey(new Date(Date.now() - i * 24 * 3600 * 1000))] = { questions: 0, escalated: 0 };
  }
  for (const row of perDayRows.rows) {
    const d = toDate(row.created_at);
    if (!d) continue;
    const bucket = perDay[dayKey(d)];
    if (!bucket) continue;
    bucket.questions += 1;
    if (Number(row.needs_human)) bucket.escalated += 1;
  }

  // Tickets.
  const ticketsTotal = await query('SELECT COUNT(*) AS total FROM tickets WHERE created_at >= $1', [sinceSql]);
  const byStatus = await counts('SELECT status AS label, COUNT(*) AS total FROM tickets WHERE created_at >= $1 GROUP BY status', [sinceSql]);
  const byPriority = await counts('SELECT priority AS label, COUNT(*) AS total FROM tickets WHERE created_at >= $1 GROUP BY priority', [sinceSql]);
  const byReason = await counts('SELECT reason AS label, COUNT(*) AS total FROM tickets WHERE created_at >= $1 GROUP BY reason', [sinceSql]);
  const byDepartment = await counts(
    `SELECT COALESCE(departments.name, 'Unassigned') AS label, COUNT(*) AS total
     FROM tickets LEFT JOIN departments ON departments.id = tickets.department_id
     WHERE tickets.created_at >= $1 GROUP BY COALESCE(departments.name, 'Unassigned')`, [sinceSql]);
  const openNow = await query(`SELECT COUNT(*) AS total FROM tickets WHERE status <> 'resolved'`);

  const resolved = await query(`SELECT created_at, updated_at FROM tickets WHERE status = 'resolved' AND created_at >= $1 LIMIT 5000`, [sinceSql]);
  const hours = resolved.rows
    .map((row) => {
      const a = toDate(row.created_at); const b = toDate(row.updated_at);
      return a && b ? (b - a) / 3600000 : null;
    })
    .filter((h) => h !== null && h >= 0);
  const avgResolutionHours = hours.length ? Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 10) / 10 : null;

  // Feedback.
  const fbRows = await query('SELECT kind, rating, COUNT(*) AS total FROM feedback WHERE created_at >= $1 GROUP BY kind, rating', [sinceSql]);
  const feedbackCounts = {};
  for (const row of fbRows.rows) feedbackCounts[`${row.kind}:${row.rating || 'none'}`] = Number(row.total);
  const up = feedbackCounts['feedback:up'] || 0;
  const down = feedbackCounts['feedback:down'] || 0;
  const complaints = Object.entries(feedbackCounts).filter(([k]) => k.startsWith('complaint:')).reduce((s, [, v]) => s + v, 0);

  const students = await query('SELECT COUNT(*) AS total FROM students');

  return {
    days: span,
    questions: {
      total: questions,
      escalated,
      answeredDirectly: Math.max(questions - escalated, 0),
      escalationRate: questions ? Math.round((escalated / questions) * 1000) / 10 : 0,
      averageConfidence: avgRow.rows[0]?.average === null || avgRow.rows[0]?.average === undefined ? null : Math.round(Number(avgRow.rows[0].average) * 100) / 100,
      signedIn: Number(signedIn.rows[0]?.total || 0),
      bySource,
      perDay: Object.entries(perDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    },
    tickets: {
      created: Number(ticketsTotal.rows[0]?.total || 0),
      openNow: Number(openNow.rows[0]?.total || 0),
      byStatus, byPriority, byReason, byDepartment,
      averageResolutionHours: avgResolutionHours,
    },
    feedback: {
      helpful: up,
      notHelpful: down,
      satisfaction: up + down ? Math.round((up / (up + down)) * 100) : null,
      complaints,
    },
    students: Number(students.rows[0]?.total || 0),
  };
}

module.exports = { overview };
