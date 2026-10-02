const test = require('node:test');
const assert = require('node:assert/strict');
const staffAuth = require('../staffAuth.js');
const { app } = require('../server.js');

test('POST /admin/signup creates a department-linked staff account', async () => {
  const originalCreateStaffUser = staffAuth.createStaffUser;
  const originalIssueToken = staffAuth.issueToken;

  staffAuth.createStaffUser = async (username, password, departmentId) => ({
    id: 'staff-123',
    username,
    password,
    departmentId,
    departmentName: 'Accounts',
    isAdmin: false,
    createdAt: new Date().toISOString(),
  });
  staffAuth.issueToken = () => 'test-token';

  try {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/admin/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'fees.staff', password: 'securepass123', departmentId: 'dept-accounts' }),
    });

    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.staff.username, 'fees.staff');
    assert.equal(body.staff.departmentId, 'dept-accounts');
    assert.equal(body.staff.departmentName, 'Accounts');

    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  } finally {
    staffAuth.createStaffUser = originalCreateStaffUser;
    staffAuth.issueToken = originalIssueToken;
  }
});
