const crypto = require('node:crypto');
const secret = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [algorithm, salt, hash] = stored.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(hash || '')) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function generateToken(user, sessionId) {
  const payload = Buffer.from(JSON.stringify({ userId: user.id, sessionId, timestamp: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  try {
    if (typeof token !== 'string') return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const age = Date.now() - data.timestamp;
    if (!Number.isFinite(age) || age < 0 || age > 30 * 24 * 60 * 60 * 1000) return null;
    if (!Number.isInteger(data.userId) || !data.sessionId) return null;
    return data;
  } catch { return null; }
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken };
