// db.js
//
// Shared MariaDB connection pool for XAMPP. Configure MYSQL_HOST,
// MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE in .env.
//
// XAMPP defaults are localhost, root, an empty password, and database chipo.

require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'chipo',
  waitForConnections: true,
  connectionLimit: 10,
  multipleStatements: true,
});

async function query(text, params = []) {
  const values = [];
  const sql = text.replace(/\$(\d+)/g, (_, position) => {
    values.push(params[Number(position) - 1]);
    return '?';
  });
  const [result] = await pool.execute(sql, values);
  if (Array.isArray(result)) return { rows: result, rowCount: result.length };
  return { rows: [], rowCount: result.affectedRows || 0, insertId: result.insertId };
}

module.exports = { pool, query };
