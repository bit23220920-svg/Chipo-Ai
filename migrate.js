// migrate.js
//
// Applies the schema matching the configured database in .env.
// Safe to run repeatedly.
//
// Usage: node migrate.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, executeMultiple, query, useTurso } = require('./db.js');

async function main() {
  const schemaFile = useTurso ? 'schema.turso.sql' : 'schema.sql';
  const sql = fs.readFileSync(path.join(__dirname, schemaFile), 'utf-8');

  if (useTurso) {
    console.log(`Applying ${schemaFile} to the configured Turso database.`);
    await executeMultiple(sql);

    const compatibilityColumns = [
      ['staff_users', 'department_id', 'TEXT NULL'],
      ['staff_users', 'is_admin', 'INTEGER NOT NULL DEFAULT 1'],
      ['departments', 'routing_keywords', 'TEXT NULL'],
      ['tickets', 'phone', 'TEXT NULL'],
      ['tickets', 'conversation_summary', 'TEXT NULL'],
      ['tickets', 'student_id', 'TEXT NULL'],
      ['tickets', 'subject', 'TEXT NULL'],
      ['tickets', 'priority', "TEXT NOT NULL DEFAULT 'medium'"],
      ['tickets', 'conversation_history', 'TEXT NULL'],
      ['chat_messages', 'student_id', 'TEXT NULL'],
      ['chat_messages', 'student_number', 'TEXT NULL'],
    ];

    for (const [table, column, definition] of compatibilityColumns) {
      const { rows } = await query(`PRAGMA table_info(${table})`);
      if (!rows.some((row) => row.name === column)) {
        await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_staff_users_department ON staff_users(department_id)',
      'CREATE INDEX IF NOT EXISTS idx_faqs_active ON faqs(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_faqs_department ON faqs(department_id)',
      'CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)',
      'CREATE INDEX IF NOT EXISTS idx_tickets_student ON tickets(student_id)',
      'CREATE INDEX IF NOT EXISTS idx_conversations_student ON conversations(student_id, id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id)',
      'CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id, id)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_student ON notifications(student_id, is_read, id)',
      'CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)',
      'CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_chat_messages_student ON chat_messages(student_id)',
      'CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_announcements_published ON announcements(published_at)',
    ];
    for (const indexSql of indexes) await query(indexSql);
    // Tickets used to start as "open"; the status is now "opened".
    await query("UPDATE tickets SET status = 'opened' WHERE status = 'open'");
  } else {
    console.log(`Applying ${schemaFile} to ${process.env.MYSQL_DATABASE || 'chipo'} on ${process.env.MYSQL_HOST || 'localhost'}:${process.env.MYSQL_PORT || '3306'}`);
    await executeMultiple(sql);
    const [columns] = await pool.query("SHOW COLUMNS FROM staff_users LIKE 'department_id'");
    if (!columns.length) {
      await pool.query('ALTER TABLE staff_users ADD COLUMN department_id CHAR(36) NULL, ADD INDEX idx_staff_users_department (department_id)');
    }
    const [adminColumns] = await pool.query("SHOW COLUMNS FROM staff_users LIKE 'is_admin'");
    if (!adminColumns.length) {
      await pool.query('ALTER TABLE staff_users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT TRUE');
    }
    const [routingKeywordColumns] = await pool.query("SHOW COLUMNS FROM departments LIKE 'routing_keywords'");
    if (!routingKeywordColumns.length) {
      await pool.query('ALTER TABLE departments ADD COLUMN routing_keywords JSON NULL');
    }
    const [ticketPhoneColumns] = await pool.query("SHOW COLUMNS FROM tickets LIKE 'phone'");
    if (!ticketPhoneColumns.length) {
      await pool.query('ALTER TABLE tickets ADD COLUMN phone VARCHAR(40) NULL AFTER email');
    }
    const [ticketSummaryColumns] = await pool.query("SHOW COLUMNS FROM tickets LIKE 'conversation_summary'");
    if (!ticketSummaryColumns.length) {
      await pool.query('ALTER TABLE tickets ADD COLUMN conversation_summary TEXT NULL AFTER question');
    }
    const [ticketStudentColumns] = await pool.query("SHOW COLUMNS FROM tickets LIKE 'student_id'");
    if (!ticketStudentColumns.length) {
      await pool.query('ALTER TABLE tickets ADD COLUMN student_id CHAR(36) NULL, ADD INDEX idx_tickets_student (student_id)');
    }
    const [ticketSubjectColumns] = await pool.query("SHOW COLUMNS FROM tickets LIKE 'subject'");
    if (!ticketSubjectColumns.length) {
      await pool.query('ALTER TABLE tickets ADD COLUMN subject VARCHAR(255) NULL');
    }
    const [ticketPriorityColumns] = await pool.query("SHOW COLUMNS FROM tickets LIKE 'priority'");
    if (!ticketPriorityColumns.length) {
      await pool.query("ALTER TABLE tickets ADD COLUMN priority VARCHAR(10) NOT NULL DEFAULT 'medium'");
    }
    const [ticketHistoryColumns] = await pool.query("SHOW COLUMNS FROM tickets LIKE 'conversation_history'");
    if (!ticketHistoryColumns.length) {
      await pool.query('ALTER TABLE tickets ADD COLUMN conversation_history MEDIUMTEXT NULL');
    }
    // Tickets used to start as "open"; the status is now "opened".
    await pool.query("ALTER TABLE tickets ALTER COLUMN status SET DEFAULT 'opened'");
    await pool.query("UPDATE tickets SET status = 'opened' WHERE status = 'open'");
    const [chatStudentColumns] = await pool.query("SHOW COLUMNS FROM chat_messages LIKE 'student_id'");
    if (!chatStudentColumns.length) {
      await pool.query('ALTER TABLE chat_messages ADD COLUMN student_id CHAR(36) NULL AFTER source, ADD COLUMN student_number VARCHAR(50) NULL AFTER student_id, ADD INDEX idx_chat_messages_student (student_id)');
    }
  }
  console.log('Schema applied successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.code || '', err.message || err);
  process.exit(1);
});
