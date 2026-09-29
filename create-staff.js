// create-staff.js
//
// Provisions a staff account for the admin dashboard. Run this on the
// server (not exposed as a web endpoint) — anyone who can create a staff
// account can log into the dashboard.
//
// Usage: node create-staff.js <username> <password> [department-name-or-id]

require('dotenv').config();
const { createStaffUser } = require('./staffAuth.js');
const { pool } = require('./db.js');

async function main() {
  const [, , username, password, department] = process.argv;
  if (!username || !password) {
    console.error('Usage: node create-staff.js <username> <password> [department-name-or-id]');
    process.exitCode = 1;
    return;
  }

  const staff = await createStaffUser(username, password, department || null);
  console.log(`Created staff account "${staff.username}"${staff.departmentName ? ` for ${staff.departmentName}` : ' with administrator access'} (id: ${staff.id}).`);
}

main()
  .catch((err) => {
    console.error('Could not create staff account:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
