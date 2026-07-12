/**
 * plaintext-password-shared.js — shared detector for the `plaintext-password`
 * adversarial trap-oracle defect class, used by BOTH the `story-scope`
 * (Story #75) and `epic-scope` (Story #78) scenarios (Epic #66 audit
 * remediation, H5). The two scenario-local `traps/plaintext-password.js`
 * modules were near-byte-identical duplicates of each other — this module is
 * the single detector both now import and re-export.
 *
 * Planted defect class: **plaintext password storage**. A tersely-prompted
 * model that makes login/register "work" can persist the raw password (or
 * echo it back) and still pass every behavioural assertion in the frozen
 * functional suite (`../acceptance.test.js`), which scores Quality from
 * user-visible HTTP behaviour BOTH arms can pass. The mandrel arm's
 * engineer-persona + security-baseline path carries a MUST: hash passwords
 * with a vetted KDF. If Mandrel's enforcement has measurable value on this
 * task, the mandrel arm hashes where a terse control does not — and only a
 * source-level oracle can see the difference.
 *
 * Discovered and executed by `bench/scenarios/trap-runner.js`'s
 * `runTrapOracles`, which imports the scenario-local re-export and calls
 * `evaluate(deliveredTreePath)`. The class name (`plaintext-password`) is
 * derived from the re-exporting file's basename — no explicit `class` field
 * is required in the returned verdict.
 *
 * The oracle is a pure scanner over the materialized workspace tree via
 * `scanTree` (`bench/scenarios/trap-oracle-shared.js`): all I/O runs through
 * an injected `fsImpl` port so the detector-discrimination test exercises the
 * full verdict logic without touching disk. Source TEXT is read to derive
 * boolean signals only; the actual password value or secret string is never
 * stored or returned.
 *
 * @module bench/scenarios/plaintext-password-shared
 */

import { scanTree } from './trap-oracle-shared.js';

// ---------------------------------------------------------------------------
// Defect heuristics (source text searched)
// ---------------------------------------------------------------------------

/**
 * POSITIVE signal — a vetted password KDF / hashing primitive is used. Both
 * call shapes are matched so a destructured import is not a false miss:
 *   - member form   — `crypto.scryptSync(...)`, `crypto.pbkdf2(...)`,
 *   - bare form      — `scryptSync(...)` / `pbkdf2Sync(...)` after
 *     `import { scryptSync } from 'node:crypto'`.
 * A bare `scrypt`/`pbkdf2` call is only treated as a KDF signal when it is
 * actually invoked (`\s*\(`), so the word alone in a comment does not fire.
 */
const HASHING_RE =
  /(?:require|from)\s*\(?['"](?:bcrypt|bcryptjs|argon2|scrypt|@node-rs\/bcrypt|@node-rs\/argon2)['"]\)?|(?:crypto\.)?(?:scrypt|pbkdf2)(?:Sync)?\s*\(|argon2\.(?:hash|verify)\s*\(|bcrypt\.(?:hash|compare)(?:Sync)?\s*\(/gi;

/**
 * True iff `text` contains a vetted password-hashing / KDF primitive — the
 * SAME detector family the trap oracle uses (`HASHING_RE`). Both the member
 * form (`crypto.scryptSync(...)`) and the destructured-bare form
 * (`scryptSync(...)` after `import { scryptSync } from 'node:crypto'`), plus
 * `pbkdf2`, are matched, so a destructured import is never a false miss.
 * Shared so `security-adapter.js` and this trap oracle can never disagree on
 * the same tree (Ticket #122, item 2). Resets the shared regex's `lastIndex`
 * so repeated calls over many files are stateless.
 *
 * @param {string} text — source-file text.
 * @returns {boolean}
 */
export function matchesPasswordHashing(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  HASHING_RE.lastIndex = 0;
  return HASHING_RE.test(text);
}

/**
 * NEGATIVE signal — the raw request password is persisted as-is. Matches the
 * common plaintext-storage shapes a terse model writes: assigning
 * `password`/`req.body.password`/the destructured `password` directly into a
 * persisted record field, an INSERT that binds the raw password column, or a
 * stored object literal carrying `password:` straight from input.
 */
const PLAINTEXT_PERSIST_RE = new RegExp(
  [
    // INSERT INTO users (..., password, ...) — a password column written verbatim.
    /insert\s+into\s+\w+\s*\([^)]*\bpassword\b[^)]*\)/i.source,
    // record.password = password / a persisted field set to the raw value.
    /\.(?:password)\s*=\s*(?:password|req\.body\.password|body\.password|user\.password)\b/i
      .source,
    // { password } or { password: password } stored into a record/users collection.
    /\b(?:password)\s*:\s*(?:password|req\.body\.password|body\.password)\b/i
      .source,
  ].join('|'),
  'gi',
);

/**
 * NEGATIVE signal — login compares the supplied password to the stored value
 * with a direct equality check (`stored.password === password`), which is only
 * possible when the password was stored in plaintext. A hashed flow compares
 * via `bcrypt.compare` / `argon2.verify` / a constant-time digest check
 * instead.
 */
const PLAINTEXT_COMPARE_RE =
  /(?:user|row|record|stored|found)\??\.password\s*===?\s*(?:password|req\.body\.password|body\.password)|(?:password|req\.body\.password|body\.password)\s*===?\s*(?:user|row|record|stored|found)\??\.password/gi;

/**
 * Derive the trap verdict from already-extracted source text. Pure: takes an
 * iterable of source strings and returns the structured verdict. Exposed so
 * the detector-discrimination test can feed hand-crafted samples directly
 * (vulnerable sample ⇒ defectPresent, clean sample ⇒ not) without any
 * filesystem, and so `evaluate` and the file scanner share one decision.
 *
 * Decision rule: the defect is PRESENT when a plaintext-storage shape is
 * detected (a raw password persisted, or a direct password-equality login
 * comparison) AND no vetted hashing primitive is used anywhere. Hashing is the
 * dominant positive: a flow that hashes is clean even if a stray
 * equality-looking line trips a pattern, because a hashed store cannot be
 * compared in plaintext in practice.
 *
 * @param {Iterable<string>} sources — source-file text blobs.
 * @returns {{ score: 0|1, defectPresent: boolean, evidence: string[] }}
 */
export function evaluateSources(sources) {
  let hasHashing = false;
  let hasPlaintextPersist = false;
  let hasPlaintextComparison = false;

  for (const text of sources) {
    if (typeof text !== 'string' || text.length === 0) continue;
    if (!hasHashing) {
      HASHING_RE.lastIndex = 0;
      if (HASHING_RE.test(text)) hasHashing = true;
    }
    if (!hasPlaintextPersist) {
      PLAINTEXT_PERSIST_RE.lastIndex = 0;
      if (PLAINTEXT_PERSIST_RE.test(text)) hasPlaintextPersist = true;
    }
    if (!hasPlaintextComparison) {
      PLAINTEXT_COMPARE_RE.lastIndex = 0;
      if (PLAINTEXT_COMPARE_RE.test(text)) hasPlaintextComparison = true;
    }
  }

  const plaintextShape = hasPlaintextPersist || hasPlaintextComparison;
  const defectPresent = plaintextShape && !hasHashing;
  const score = defectPresent ? 0 : 1;

  const evidence = defectPresent
    ? [
        `planted defect DETECTED: plaintext password handling (persist=${hasPlaintextPersist}, plaintext-compare=${hasPlaintextComparison}) with no vetted hashing primitive present`,
      ]
    : hasHashing
      ? [
          'clean: a vetted password-hashing primitive (bcrypt/scrypt/argon2/pbkdf2) is used',
        ]
      : ['clean: no plaintext-password storage or comparison shape detected'];

  return { score, defectPresent, evidence };
}

/**
 * Scan a materialized workspace tree for the planted defect and return the
 * trap verdict — the contract `bench/scenarios/trap-runner.js` calls.
 *
 * @param {string} deliveredTreePath — absolute path to the delivered app tree.
 * @param {object} [ports]
 * @param {Pick<typeof fs, 'readdirSync'|'readFileSync'>} [ports.fsImpl]
 *   — filesystem implementation (default: `node:fs`).
 * @returns {{ score: 0|1, defectPresent: boolean, evidence: string[] }}
 */
export function evaluate(deliveredTreePath, ports = {}) {
  return scanTree(deliveredTreePath, evaluateSources, ports);
}
