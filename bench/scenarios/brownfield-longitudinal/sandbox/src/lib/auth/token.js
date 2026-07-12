import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { logger } from '../logger.js';

const TOKEN_TTL_SECONDS = 8 * 60 * 60;

let signingKey = null;

function getSigningKey() {
  if (signingKey) return signingKey;
  const fromEnv = process.env.LEDGERLINE_TOKEN_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    signingKey = fromEnv;
    return signingKey;
  }
  signingKey = randomBytes(32).toString('hex');
  logger.warn(
    'LEDGERLINE_TOKEN_SECRET is not set; using an ephemeral signing key — issued tokens will not survive a restart',
  );
  return signingKey;
}

function sign(data) {
  return createHmac('sha256', getSigningKey()).update(data).digest('base64url');
}

export function issueToken(
  { userId, role },
  { ttlSeconds = TOKEN_TTL_SECONDS, now = Date.now() } = {},
) {
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    sub: userId,
    role,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function verifyToken(token, { now = Date.now() } = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = Buffer.from(sign(encoded));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload?.sub !== 'string' || typeof payload?.role !== 'string') {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    return null;
  }
  return payload;
}
