// migrate.js
//
// Applies schema.sql to the MariaDB database configured in .env.
// Safe to run repeatedly — every statement in schema.sql uses
// CREATE TABLE/INDEX IF NOT EXISTS.
//
// Usage: node migrate.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db.js');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  console.log(`Applying schema.sql to ${process.env.MYSQL_DATABASE || 'chipo'} on ${process.env.MYSQL_HOST || 'localhost'}:${process.env.MYSQL_PORT || '3306'}`);
  await pool.query(sql);
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
  console.log('Schema applied successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.code || '', err.message || err);
  process.exit(1);
});
