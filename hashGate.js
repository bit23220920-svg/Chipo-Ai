// hashGate.js
//
// Checking a password is deliberately slow (bcrypt, about a third of a second
// of CPU). If hundreds of sign-ins arrive at once they all queue behind each
// other and the whole site stalls. This lets a few checks run at a time, lets
// a short line wait, and answers "busy, try again" to the rest straight away.

const bcrypt = require('bcryptjs');

const MAX_ACTIVE = Number(process.env.HASH_CONCURRENCY) || 4;
const MAX_WAITING = Number(process.env.HASH_QUEUE) || 30;
let active = 0;
const waiting = [];

function run(job) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      job()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          const next = waiting.shift();
          if (next) next();
        });
    };
    if (active < MAX_ACTIVE) return start();
    if (waiting.length < MAX_WAITING) {
      waiting.push(start);
      return undefined;
    }
    const busy = new Error('The server is busy signing people in. Please try again in a moment.');
    busy.statusCode = 503;
    return reject(busy);
  });
}

const compare = (password, hash) => run(() => bcrypt.compare(password, hash));

module.exports = { compare };
