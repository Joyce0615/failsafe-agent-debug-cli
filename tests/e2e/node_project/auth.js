/**
 * Simple auth module with deliberate bugs.
 */

function validateUser(user) {
  // Bug: crashes when user.email is undefined (OAuth providers without email)
  const normalizedEmail = user.email.toLowerCase();
  return { ...user, email: normalizedEmail };
}

function createSession(user, options) {
  // Bug: options.ttl is expected to be a number but may be string from env
  const expiresAt = Date.now() + options.ttl * 1000;
  return {
    userId: user.id,
    email: user.email,
    expiresAt,
    token: `sess_${user.id}_${expiresAt}`,
  };
}

function checkPermission(user, resource) {
  // Bug: user.roles is undefined when user has no roles assigned
  return user.roles.includes(resource.requiredRole);
}

module.exports = { validateUser, createSession, checkPermission };
