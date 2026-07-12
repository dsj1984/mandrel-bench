import { ApiError } from './errors.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(422, 'E_VALIDATION', `${name} must be a positive integer`);
  }
  return value;
}

export function parsePagination(query) {
  const page = parsePositiveInt(query.page, 1, 'page');
  const pageSize = parsePositiveInt(query.pageSize, DEFAULT_PAGE_SIZE, 'pageSize');
  if (pageSize > MAX_PAGE_SIZE) {
    throw new ApiError(422, 'E_VALIDATION', `pageSize must be at most ${MAX_PAGE_SIZE}`);
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function buildPage(items, total, page, pageSize) {
  return { items, total, page, pageSize };
}
