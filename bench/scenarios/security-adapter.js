/**
 * security-adapter.js — static-analysis security sub-signal collector for
 * the Mandrel self-benchmark harness (Epic #32, Story #37).
 *
 * Extracts the objective security sub-signals from a workspace so that
 * `computeSecurity` (bench/score/dimensions.js) has real inputs for both arms.
 *
 * Sub-signals returned:
 *
 *   secretScanCount         {number}  — count of potential secrets detected by
 *                                       a grep-based heuristic over the tree.
 *                                       Never the secret value itself.
 *   depAuditVulnCount       {number}  — total vulnerability count from
 *                                       `npm audit --json`, summing critical +
 *                                       high + moderate + low.
 *   hasEdgeInputValidation  {boolean} — true iff a schema-validation library
 *                                       import is found (e.g. zod, joi, yup,
 *                                       ajv, express-validator).
 *   hasPasswordHashing      {boolean} — true iff a password-hashing library
 *                                       import is found (bcrypt, scrypt,
 *                                       argon2) or the native crypto.scrypt.
 *   hasSafeTokenStorage     {boolean} — true iff cookies are configured with
 *                                       httpOnly (no auth tokens in localStorage
 *                                       / sessionStorage).
 *   hasServerSideAuthz      {boolean} — true iff server-side ownership /
 *                                       authorization patterns are present.
 *   hasAuthRateLimiting     {boolean} — true iff a rate-limiting library import
 *                                       is found on auth-relevant paths.
 *
 * Design constraints:
 *
 *   - All I/O runs through injected ports (fsImpl, spawnImpl, globImpl) so the
 *     unit test can stub every surface without touching the filesystem or
 *     spawning a real child process.
 *   - No network writes. The adapter is purely a reader/scanner.
 *   - Counts and booleans only — never the raw secret string.
 *
 * @module bench/scenarios/security-adapter
 */

import { execFileSync as defaultExecFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Secret-scan heuristics
// ---------------------------------------------------------------------------

/**
 * Patterns that may indicate a hardcoded secret in source text.
 * Matches common key/token assignment patterns — but NOT placeholders.
 * Only the *count* of matches is surfaced; the actual text is never stored.
 */
const SECRET_PATTERNS = [
  // Generic: key/token/secret/password assigned to a non-placeholder string literal.
  /(?:api[_-]?key|api[_-]?token|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\s*[=:]\s*['"][^'"]{8,}['"]/gi,
  // AWS-style access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // Private key headers
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  // Bearer token literals
  /['"]Bearer [A-Za-z0-9._-]{20,}['"]/g,
];

/** File extensions considered source/config (skip binaries, lockfiles). */
const SCANNABLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.env',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.bash',
]);

/** Directories to skip when scanning for secrets. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

// ---------------------------------------------------------------------------
// MUST-presence heuristics (pattern sets — source text searched)
// ---------------------------------------------------------------------------

/** Imports/requires of schema-validation libraries (edge input validation). */
const EDGE_INPUT_VALIDATION_RE =
  /(?:require|from)\s*\(?['"](?:zod|joi|yup|ajv|@hapi\/joi|express-validator|class-validator|superstruct|valibot|typebox)['"]\)?/gi;

/** Imports/requires of password-hashing libraries OR native crypto.scrypt usage. */
const PASSWORD_HASHING_RE =
  /(?:require|from)\s*\(?['"](?:bcrypt|bcryptjs|argon2|scrypt|@node-rs\/bcrypt|@node-rs\/argon2)['"]\)?|crypto\.scrypt\s*\(|crypto\.scryptSync\s*\(/gi;

/**
 * Safe token storage: cookies with httpOnly flag.
 * Matches `httpOnly: true`, `httponly`, `HttpOnly` — covers Express/Koa/Hono
 * cookie options and `Set-Cookie: ...; HttpOnly` header strings.
 */
const SAFE_TOKEN_STORAGE_RE = /httpOnly\s*:\s*true|[Hh]ttp[Oo]nly/g;

/**
 * Counter-signal for *unsafe* token storage: tokens placed in localStorage or
 * sessionStorage. If this matches, hasSafeTokenStorage is false regardless of
 * the positive signal.
 */
const UNSAFE_TOKEN_STORAGE_RE =
  /localStorage\.setItem|sessionStorage\.setItem/g;

/**
 * Server-side authorization: middleware or guard calls that indicate
 * ownership/permission checks beyond "is logged in".
 *
 * Matches common patterns: requireAuth, requireOwner, authorize,
 * checkPermission, can(), ability.can(), gate.check(), policy.authorize().
 */
const SERVER_SIDE_AUTHZ_RE =
  /requireOwner|requirePermission|checkOwnership|canAccess|authorize\s*\(|\.can\s*\(|ability\.can|gate\.check|policy\.authorize|isOwner|hasPermission|checkPermission/gi;

/** Rate-limiting library imports (auth endpoints). */
const AUTH_RATE_LIMITING_RE =
  /(?:require|from)\s*\(?['"](?:express-rate-limit|rate-limiter-flexible|@nestjs\/throttler|koa-ratelimit|hono-rate-limiter|bottleneck|limiter)['"]\)?|rateLimit\s*\(|rateLimiter\s*\(|throttle\s*\(/gi;

// ---------------------------------------------------------------------------
// Filesystem walker
// ---------------------------------------------------------------------------

/**
 * Recursively collect all scannable source files under `dir`.
 *
 * @param {string} dir  — absolute path to scan.
 * @param {{ readdirSync: typeof fs.readdirSync, statSync: typeof fs.statSync }} fsImpl
 * @returns {string[]}  — absolute paths of scannable files.
 */
function collectSourceFiles(dir, fsImpl) {
  const result = [];
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectSourceFiles(full, fsImpl));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCANNABLE_EXTENSIONS.has(ext)) {
        result.push(full);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Npm audit parser
// ---------------------------------------------------------------------------

/**
 * Parse `npm audit --json` output and return the total vulnerability count.
 * Sums across all severity levels.
 *
 * @param {string} json  — raw JSON string from `npm audit --json`.
 * @returns {number}
 */
function parseAuditVulnCount(json) {
  try {
    const parsed = JSON.parse(json);
    // npm v7+ shape: { metadata: { vulnerabilities: { critical, high, moderate, low, ... } } }
    const v = parsed?.metadata?.vulnerabilities;
    if (v && typeof v === 'object') {
      return (
        (v.critical ?? 0) +
        (v.high ?? 0) +
        (v.moderate ?? 0) +
        (v.low ?? 0) +
        (v.info ?? 0)
      );
    }
    // Fallback: count top-level `vulnerabilities` entries (npm v6 / audit-level objects)
    if (parsed?.vulnerabilities && typeof parsed.vulnerabilities === 'object') {
      return Object.keys(parsed.vulnerabilities).length;
    }
    return 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Collect normalized security sub-signals from `workspacePath`.
 *
 * @param {string} workspacePath  — absolute path to the workspace to scan.
 * @param {object} [ports]        — injectable ports for all I/O.
 * @param {Pick<typeof fs, 'readdirSync'|'readFileSync'|'statSync'>} [ports.fsImpl]
 *   — filesystem implementation (default: `node:fs`).
 * @param {typeof defaultExecFileSync} [ports.execFileSync]
 *   — child-process spawner (default: `node:child_process.execFileSync`).
 *   Called as `execFileSync('npm', ['audit', '--json'], { cwd, encoding })`.
 *   Must return a string. May throw; errors are caught and treated as 0 vulns.
 *
 * @returns {{
 *   secretScanCount: number,
 *   depAuditVulnCount: number,
 *   hasEdgeInputValidation: boolean,
 *   hasPasswordHashing: boolean,
 *   hasSafeTokenStorage: boolean,
 *   hasServerSideAuthz: boolean,
 *   hasAuthRateLimiting: boolean,
 * }}
 */
export function collectSecuritySignals(workspacePath, ports = {}) {
  const fsImpl = ports.fsImpl ?? fs;
  const execFileSyncImpl = ports.execFileSync ?? defaultExecFileSync;

  // ── 1. Collect source files ───────────────────────────────────────────────
  const files = collectSourceFiles(workspacePath, fsImpl);

  // ── 2. Scan source text for secret patterns and MUST heuristics ──────────
  let secretScanCount = 0;
  let hasEdgeInputValidation = false;
  let hasPasswordHashing = false;
  let hasSafeTokenStorage = false;
  let hasServerSideAuthz = false;
  let hasAuthRateLimiting = false;
  let unsafeTokenStorageFound = false;

  for (const filePath of files) {
    let text;
    try {
      text = fsImpl.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // Secret scan — count matches, never store value
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      if (matches) secretScanCount += matches.length;
    }

    // MUST: edge input validation
    if (!hasEdgeInputValidation) {
      EDGE_INPUT_VALIDATION_RE.lastIndex = 0;
      if (EDGE_INPUT_VALIDATION_RE.test(text)) hasEdgeInputValidation = true;
    }

    // MUST: password hashing
    if (!hasPasswordHashing) {
      PASSWORD_HASHING_RE.lastIndex = 0;
      if (PASSWORD_HASHING_RE.test(text)) hasPasswordHashing = true;
    }

    // MUST: safe token storage (httpOnly cookie flag)
    if (!hasSafeTokenStorage) {
      SAFE_TOKEN_STORAGE_RE.lastIndex = 0;
      if (SAFE_TOKEN_STORAGE_RE.test(text)) hasSafeTokenStorage = true;
    }

    // Counter-signal: unsafe token storage (localStorage/sessionStorage writes)
    if (!unsafeTokenStorageFound) {
      UNSAFE_TOKEN_STORAGE_RE.lastIndex = 0;
      if (UNSAFE_TOKEN_STORAGE_RE.test(text)) unsafeTokenStorageFound = true;
    }

    // MUST: server-side authorization
    if (!hasServerSideAuthz) {
      SERVER_SIDE_AUTHZ_RE.lastIndex = 0;
      if (SERVER_SIDE_AUTHZ_RE.test(text)) hasServerSideAuthz = true;
    }

    // MUST: auth rate limiting
    if (!hasAuthRateLimiting) {
      AUTH_RATE_LIMITING_RE.lastIndex = 0;
      if (AUTH_RATE_LIMITING_RE.test(text)) hasAuthRateLimiting = true;
    }
  }

  // Unsafe token storage overrides the positive httpOnly signal
  if (unsafeTokenStorageFound) hasSafeTokenStorage = false;

  // ── 3. Dependency audit ───────────────────────────────────────────────────
  let depAuditVulnCount = 0;
  try {
    const auditJson = execFileSyncImpl('npm', ['audit', '--json'], {
      cwd: workspacePath,
      encoding: 'utf8',
    });
    depAuditVulnCount = parseAuditVulnCount(auditJson);
  } catch (err) {
    // `npm audit` exits non-zero when vulnerabilities are found. The output
    // is still valid JSON on stdout — extract it from the error object if
    // available (node's execFileSync throws with .stdout when encoding set).
    const stdout = err?.stdout ?? '';
    if (stdout) {
      depAuditVulnCount = parseAuditVulnCount(stdout);
    }
    // If stdout is empty (e.g. no package.json), depAuditVulnCount stays 0.
  }

  return {
    secretScanCount,
    depAuditVulnCount,
    hasEdgeInputValidation,
    hasPasswordHashing,
    hasSafeTokenStorage,
    hasServerSideAuthz,
    hasAuthRateLimiting,
  };
}
