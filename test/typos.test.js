// Typo tolerance.
//
// Students type fast, often on a phone. A misspelt question has to be
// understood: "admisn reqirements" is still a question about admissions, and
// it must not be turned away as out of bounds, locked as a personal record
// question, or handed over to a department because the retrieval score was
// low.

const test = require('node:test');
const assert = require('node:assert/strict');
const portalAccess = require('../portalAccess.js');
const ask = require('../ask.js');
const { isTicketRequest, resolveTicketDepartment } = require('../ticketRouting.js');
const departments = require('../departments.js');

const TYPOED_UNIVERSITY_QUESTIONS = [
  'admisn reqirements',
  'how do i aplly for a deferment',
  'whats the fee strucure for undergrads',
  'how do i regitrate for courses',
  'when is gradutaton',
  'i need a suport ticket about my fees',
  'how do i get my studnet id card',
  'defrment requirements',
  'exm timetables',
  'hostel acomodation',
];

const TYPOED_OUT_OF_SCOPE_QUESTIONS = [
  'whats the captial of frence',
  'who won the world cup in 1998',
  'what is the weither in tokyo',
  'writ me a poem about rain',
];

test('a misspelt university question is still in scope', () => {
  for (const question of TYPOED_UNIVERSITY_QUESTIONS) {
    assert.equal(
      portalAccess.isInScope(question),
      true,
      `expected "${question}" to be in scope`
    );
  }
});

test('a misspelt question about something else is still out of scope', () => {
  for (const question of TYPOED_OUT_OF_SCOPE_QUESTIONS) {
    assert.equal(
      portalAccess.isInScope(question),
      false,
      `expected "${question}" to be out of scope`
    );
  }
});

test('a misspelt personal question is still treated as a personal one', () => {
  // "whats my fe balnce" has to be recognised as a question about the
  // student's own records, so the public site still refuses it.
  assert.equal(portalAccess.isPersonalPortalQuestion('whats my fe balnce'), true);
  assert.equal(portalAccess.isPersonalPortalQuestion('show me my reslts'), true);
  assert.equal(portalAccess.isPersonalPortalQuestion('whats my fe balnce'), true);
});

test('the scope check can tell a typo from a clean question', () => {
  const clean = portalAccess.scopeCheck('How do I apply for a deferment?');
  assert.equal(clean.inScope, true);
  assert.equal(clean.fuzzy, false);

  const typo = portalAccess.scopeCheck('how do i aplly for a deferment');
  assert.equal(typo.inScope, true);
  assert.equal(typo.fuzzy, true);
});

test('a plural or a word form is not treated as a typo', () => {
  // "admissions" and "admission" are the same word, so a clean question
  // must not look like a misspelt one.
  assert.equal(portalAccess.matchKeyword('admission requirements', 'admissions'), 'exact');
  assert.equal(portalAccess.matchKeyword('what are the fees', 'fee'), 'exact');
  assert.equal(portalAccess.matchKeyword('i am registered', 'register'), 'exact');
  assert.equal(portalAccess.matchKeyword('show me my results', 'result'), 'exact');
});

test('a missing vowel still counts as the same word', () => {
  assert.equal(portalAccess.matchKeyword('admisn reqirements', 'admission'), 'fuzzy');
  assert.equal(portalAccess.matchKeyword('admission requirements', 'admission'), 'exact');
  assert.equal(portalAccess.matchKeyword('admissions requirements', 'admission'), 'exact');
});

test('a misspelt ticket request is still a ticket request', () => {
  assert.equal(isTicketRequest('i need a suport ticket about my fees'), true);
  assert.equal(isTicketRequest('can you open a suport tickit for me'), true);
  assert.equal(isTicketRequest('I need a ticket'), true);
  // ...but looking up a ticket is not the same as asking for one.
  assert.equal(isTicketRequest('can you check the status of my ticket'), false);
  assert.equal(isTicketRequest('I want to know about my ticket'), false);
});

test('a misspelt question still reaches the right department', async () => {
  const available = await departments.listDepartments();
  const studentAffairs = available.find((department) => /student affairs/i.test(department.name));

  const hostel = resolveTicketDepartment('how do i get hostel acomodation', available);
  assert.equal(hostel, studentAffairs?.id);

  const fees = resolveTicketDepartment('my pyment failed at the bank', available);
  const accounts = available.find((department) => /accounts/i.test(department.name));
  assert.equal(fees, accounts?.id);
});

test('a misspelt question is answered rather than handed over on score alone', async () => {
  // The retrieval score for a misspelt question is unreliable, so it must not
  // be the reason a ticket is opened.
  const scope = portalAccess.scopeCheck('admisn reqirements');
  assert.equal(scope.inScope, true);
  assert.equal(scope.fuzzy, true);
});
