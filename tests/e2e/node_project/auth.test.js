const { validateUser, createSession, checkPermission } = require('./auth');

// --- validateUser tests ---

test('validateUser normalizes email', () => {
  const user = { id: '1', name: 'Alice', email: 'Alice@Example.COM' };
  const result = validateUser(user);
  expect(result.email).toBe('alice@example.com');
});

test('validateUser handles missing email', () => {
  // BUG: user.email is undefined → TypeError
  const user = { id: '2', name: 'Bob' };
  const result = validateUser(user);
  expect(result.email).toBeUndefined();
});

// --- createSession tests ---

test('createSession creates valid session', () => {
  const user = { id: '1', email: 'alice@test.com' };
  const session = createSession(user, { ttl: 3600 });
  expect(session.userId).toBe('1');
  expect(session.expiresAt).toBeGreaterThan(Date.now());
});

test('createSession with string ttl', () => {
  // BUG: ttl from env is string "3600", multiplication gives NaN-like behavior
  const user = { id: '1', email: 'alice@test.com' };
  const session = createSession(user, { ttl: '3600' });
  // This actually works in JS (string * number coerces), but test expects exact type
  expect(typeof session.expiresAt).toBe('number');
  expect(session.expiresAt).toBeGreaterThan(Date.now());
});

// --- checkPermission tests ---

test('checkPermission allows admin', () => {
  const user = { id: '1', roles: ['admin', 'editor'] };
  const resource = { requiredRole: 'admin' };
  expect(checkPermission(user, resource)).toBe(true);
});

test('checkPermission denies viewer', () => {
  const user = { id: '2', roles: ['viewer'] };
  const resource = { requiredRole: 'admin' };
  expect(checkPermission(user, resource)).toBe(false);
});

test('checkPermission with no roles', () => {
  // BUG: user.roles is undefined → TypeError
  const user = { id: '3' };
  const resource = { requiredRole: 'admin' };
  expect(checkPermission(user, resource)).toBe(false);
});
