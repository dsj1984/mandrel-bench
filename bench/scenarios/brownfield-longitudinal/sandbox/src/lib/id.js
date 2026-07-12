import { randomBytes } from 'node:crypto';

export function newId(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('newId requires a non-empty prefix');
  }
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}
