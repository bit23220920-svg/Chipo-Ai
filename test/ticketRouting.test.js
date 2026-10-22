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

test('routes ID card requests to the Library', () => {
  assert.equal(resolveTicketDepartment('I need a replacement student ID card', departments), 'library-id');
});

test('routes other departments using configured keywords', () => {
  assert.equal(resolveTicketDepartment('When will I receive my admission letter?', departments), 'admissions-id');
});

test('a missing result goes to Registry even when a scholarship application is mentioned', () => {
  const offices = [
    { id: 'admissions-id', name: 'Admissions', routingKeywords: ['application', 'admission letter'] },
    { id: 'registry-id', name: 'Registry' },
  ];
  assert.equal(
    resolveTicketDepartment('My results are missing from the portal and I need them for a scholarship application', offices),
    'registry-id'
  );
});

test('routes additional department keywords case-insensitively', () => {
  const otherDepartments = [{ id: 'registry-id', name: 'Registry', routingKeywords: ['transcripts', 'course registration'] }];
  assert.equal(resolveTicketDepartment('How do I get my TRANSCRIPT?', otherDepartments), 'registry-id');
});

test('routes by the current question before a preferred FAQ department', () => {
  assert.equal(resolveTicketDepartment('I have a fee issue', departments, 'library-id'), 'accounts-id');
});

test('uses the FAQ department when the current question has no routing topic', () => {
  assert.equal(resolveTicketDepartment('Can someone help me with this?', departments, 'library-id'), 'library-id');
});

test('uses recent conversation context when the current question is vague', () => {
  assert.equal(
    resolveTicketDepartment('It still is not working', departments, null, ['My campus wifi is not working']),
    'it-id'
  );
});

test('uses the most recent matching conversation turn', () => {
  assert.equal(
    resolveTicketDepartment('Please send it to staff', departments, null, [
      'I need help paying tuition fees',
      'The campus wifi also stopped working',
    ]),
    'it-id'
  );
});

test('routes unmatched tickets to Student Affairs when available', () => {
  const departmentsWithSupport = [
    ...departments,
    { id: 'student-affairs-id', name: 'Student Affairs' },
  ];
  assert.equal(resolveTicketDepartment('Where can I get help on campus?', departmentsWithSupport), 'student-affairs-id');
});

test('does not misroute unmatched tickets to the first department when Student Affairs is absent', () => {
  assert.equal(resolveTicketDepartment('Where can I get help on campus?', departments), null);
});

test('leaves tickets unassigned only if no departments or matching context exist', () => {
  assert.equal(resolveTicketDepartment('Where can I get help on campus?', []), null);
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

test('a request for a person is a request for a human to take over', () => {
  assert.equal(isTicketRequest('I need to speak to someone about my hostel application'), true);
  assert.equal(isTicketRequest('can I talk to the registrar about my graduation'), true);
  assert.equal(isTicketRequest('please call someone about my fees'), true);
  assert.equal(isTicketRequest('put me through to the bursar'), true);
  assert.equal(isTicketRequest('get me a human please'), true);
  assert.equal(isTicketRequest('I want to whatsapp the hostel matron'), true);
});

test('asking how to reach a department is a question Chipo can answer', () => {
  // The student is not asking for a person to handle it right now, they are
  // asking for the contact details.
  assert.equal(isTicketRequest('How do I contact the accounts office?'), false);
  assert.equal(isTicketRequest('What is the phone number of the library?'), false);
  assert.equal(isTicketRequest('Where is the library?'), false);
});

test('questions about the university itself go to Admissions', () => {
  const withAdmissions = [...departments, { id: 'admissions-id', name: 'Admissions' }];

  assert.equal(resolveTicketDepartment('How many campuses are there?', withAdmissions), 'admissions-id');
  assert.equal(resolveTicketDepartment('How many programmes does the school offer?', withAdmissions), 'admissions-id');
  assert.equal(resolveTicketDepartment('Which faculties are there?', withAdmissions), 'admissions-id');
});

test('a hostel question goes to Student Affairs, even when it mentions an application', () => {
  const withSupport = [...departments, { id: 'student-affairs-id', name: 'Student Affairs' }];

  assert.equal(resolveTicketDepartment('my hostel application', withSupport), 'student-affairs-id');
  assert.equal(resolveTicketDepartment('I need to speak to someone about my accommodation', withSupport), 'student-affairs-id');
});

test('exam results go to the Registry', () => {
  const withRegistry = [...departments, { id: 'registry-id', name: 'Registry' }];

  assert.equal(resolveTicketDepartment('my exam results', withRegistry), 'registry-id');
  assert.equal(resolveTicketDepartment('my transcript', withRegistry), 'registry-id');
});