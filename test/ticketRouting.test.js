const test = require('node:test');
const assert = require('node:assert/strict');
const { isTicketRequest, resolveTicketDepartment } = require('../ticketRouting.js');

const departments = [
  { id: 'accounts-id', name: 'Accounts' },
  { id: 'it-id', name: 'IT Department' },
  { id: 'library-id', name: 'Library' },
  { id: 'admissions-id', name: 'Admissions', routingKeywords: ['application', 'admission letter'] },
];

test('routes finance and fee questions to Accounts', () => {
  assert.equal(resolveTicketDepartment('I need help paying my tuition fees', departments), 'accounts-id');
});

test('routes technical questions to IT', () => {
  assert.equal(resolveTicketDepartment('The campus wifi is not working', departments), 'it-id');
});

test('does not route on the ordinary pronoun "it" alone', () => {
  assert.equal(resolveTicketDepartment('It is not what I expected', departments), null);
});

test('routes ID card requests to the Library', () => {
  assert.equal(resolveTicketDepartment('I need a replacement student ID card', departments), 'library-id');
});

test('routes other departments using configured keywords', () => {
  assert.equal(resolveTicketDepartment('When will I receive my admission letter?', departments), 'admissions-id');
});

test('routes additional department keywords case-insensitively', () => {
  const otherDepartments = [{ id: 'registry-id', name: 'Registry', routingKeywords: ['transcripts', 'course registration'] }];
  assert.equal(resolveTicketDepartment('How do I get my TRANSCRIPT?', otherDepartments), 'registry-id');
});

test('prefers the department assigned by a matching FAQ', () => {
  assert.equal(resolveTicketDepartment('I have a fee issue', departments, 'library-id'), 'library-id');
});

test('leaves unrelated questions unassigned', () => {
  assert.equal(resolveTicketDepartment('What is the weather today?', departments), null);
});

test('routes unmatched tickets to Student Affairs when available', () => {
  const departmentsWithSupport = [
    ...departments,
    { id: 'student-affairs-id', name: 'Student Affairs' },
  ];
  assert.equal(resolveTicketDepartment('Where can I get help on campus?', departmentsWithSupport), 'student-affairs-id');
});

test('recognizes direct requests to create a staff ticket', () => {
  assert.equal(isTicketRequest('I want to create a ticket'), true);
  assert.equal(isTicketRequest('Can you send me a support ticket?'), true);
  assert.equal(isTicketRequest('Please open a ticket'), true);
  assert.equal(isTicketRequest('I need a ticket'), true);
});

test('does not treat ticket status lookups as ticket creation requests', () => {
  assert.equal(isTicketRequest('How do I check my ticket status?'), false);
  assert.equal(isTicketRequest('Can I track my support ticket?'), false);
});