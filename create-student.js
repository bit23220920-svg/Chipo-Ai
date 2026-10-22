// create-student.js
//
// Provisions a student account for the student portal. Run this on the
// server (not exposed as a web endpoint) — anyone who can create a student
// account can read that student's portal.
//
// Usage: node create-student.js <student-number> <password> <full-name> [programme] [faculty] [year-of-study] [email] [phone]
//
// The email address and phone number matter: when Chipo cannot answer a
// question and the student is signed in, it opens a ticket to the right
// department using these details instead of asking the student to type them
// in again.

require('dotenv').config();
const { createStudent } = require('./studentAuth.js');
const { pool } = require('./db.js');

async function main() {
  const [, , studentNumber, password, fullName, programme, faculty, yearOfStudy, email, phone] = process.argv;
  if (!studentNumber || !password || !fullName) {
    console.error('Usage: node create-student.js <student-number> <password> <full-name> [programme] [faculty] [year-of-study] [email] [phone]');
    process.exitCode = 1;
    return;
  }

  const student = await createStudent({
    studentNumber,
    password,
    fullName,
    programme: programme || null,
    faculty: faculty || null,
    yearOfStudy: yearOfStudy || null,
    email: email || null,
    phone: phone || null,
  });
  console.log(`Created student account ${student.studentNumber} for ${student.fullName} (id: ${student.id}).`);
}

main()
  .catch((err) => {
    console.error('Could not create student account:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
