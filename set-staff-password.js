// Reset a staff account password without exposing or storing it in plain text.
// Usage: node set-staff-password.js <username> <new-password>

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, pool } = require('./db.js');

async function main() {
  const [, , username, password] = process.argv;
  if (!username || !password || password.length < 8) {
    console.error('Usage: node set-staff-password.js <username> <new-password-at-least-8-characters>');
    process.exitCode = 1;
    return;
  }

  const { rows } = await query('SELECT id FROM staff_users WHERE username = $1', [username.trim()]);
  if (!rows[0]) {
    console.error(`No staff account named "${username}" exists.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await query('UPDATE staff_users SET password_hash = $1 WHERE id = $2', [passwordHash, rows[0].id]);
  console.log(`Password updated for staff account "${username.trim()}".`);
}

main()
  .catch((error) => {
    console.error('Could not update staff password:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
