import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { issueToken } from '../lib/auth/token.js';
import { nowIso } from '../lib/clock.js';
import { ApiError, notFound } from '../lib/errors.js';
import { newId } from '../lib/id.js';
import {
  countUsers,
  findUserByEmail,
  findUserById,
  insertUser,
} from '../repositories/users.repo.js';

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

export function register({ name, email, password }) {
  if (findUserByEmail(email)) {
    throw new ApiError(409, 'E_CONFLICT', 'a user with this email already exists');
  }
  const role = countUsers() === 0 ? 'admin' : 'member';
  const passwordSalt = randomBytes(16).toString('hex');
  const user = {
    id: newId('usr'),
    name,
    email,
    passwordHash: hashPassword(password, passwordSalt),
    passwordSalt,
    role,
    createdAt: nowIso(),
  };
  insertUser(user);
  return publicUser(user);
}

export function login({ email, password }) {
  const user = findUserByEmail(email);
  if (!user) {
    throw new ApiError(401, 'E_UNAUTHENTICATED', 'invalid email or password');
  }
  const candidate = Buffer.from(hashPassword(password, user.passwordSalt), 'hex');
  const stored = Buffer.from(user.passwordHash, 'hex');
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
    throw new ApiError(401, 'E_UNAUTHENTICATED', 'invalid email or password');
  }
  return { token: issueToken({ userId: user.id, role: user.role }) };
}

export function getProfile(userId) {
  const user = findUserById(userId);
  if (!user) throw notFound('user');
  return publicUser(user);
}
