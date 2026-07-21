/**
 * token-generation.js — BEHAVIOURAL, DISTRIBUTIONAL trap-oracle for the
 * `story-scope` scenario's `token-generation` defect class (Epic #66,
 * Story #75; converted from a source scan to a behavioural probe by
 * Story #156).
 *
 * ## Why this stopped being a source scan
 *
 * The previous implementation grepped the delivered tree for `Math.random`,
 * `Date.now`, and `++counter` shapes, with any CSPRNG import anywhere in the
 * tree as a dominant positive. That is a proxy for token strength, not a
 * measurement of it: an app that imports `crypto` for password hashing and
 * derives its session from a counter scores clean, and an app that generates
 * a strong token through a helper the pattern does not recognise scores
 * defective. The property the trap exists to measure — "is the issued
 * credential unpredictable?" — is observable directly, at the HTTP boundary,
 * without reading a line of source.
 *
 * ## What it measures instead
 *
 * The probe registers one principal and logs it in {@link SAMPLE_SIZE} times,
 * collecting the credentials the app actually issues, then judges the SAMPLE
 * distributionally:
 *
 *   1. **Duplicates** — two logins issuing the same credential means sessions
 *      are not distinct at all.
 *   2. **Monotonicity** — the varying portion parses as a number and the
 *      sample is strictly ordered (a counter, or a raw timestamp): the next
 *      credential is guessable from the previous one.
 *   3. **Entropy floor** — after stripping the longest common prefix and
 *      suffix (a constant wrapper like `sess-` carries no entropy), the
 *      varying portion must clear {@link MIN_ENTROPY_BITS} bits under a
 *      character-set estimate (`length × log2(distinct symbols observed)`).
 *
 * A 32-byte hex credential clears the floor by a wide margin (64 chars × 4
 * bits ≈ 256); `randomUUID` clears it (36 × ~4.1 ≈ 147); `sess-1`…`sess-50`
 * does not (~2 chars × ~3.3 ≈ 7). No source text is read and no credential
 * value is ever placed in `evidence` — only derived counts and bit estimates.
 *
 * ## The UNMEASURED verdict
 *
 * A tree that never boots, or whose login route cannot issue the sample,
 * reports `null` for this class rather than a pass or a fail. See
 * `bench/scenarios/trap-probe-shared.js`.
 *
 * @module bench/scenarios/story-scope/traps/token-generation
 */

import {
  authenticate,
  isSuccess,
  measured,
  probeDeliveredApp,
  scenarioDirOf,
  unmeasured,
} from '../../trap-probe-shared.js';

const SCENARIO_DIR = scenarioDirOf(import.meta.url);

/** The story-scope auth route contract (mirrors the seed prompt). */
export const AUTH_ROUTES = Object.freeze({
  registerPath: '/signup',
  loginPath: '/login',
  tokenField: 'session',
});

/** How many credentials the distributional probe collects. */
export const SAMPLE_SIZE = 50;

/** Minimum sample size that still supports a distributional verdict. */
export const MIN_SAMPLE_SIZE = 10;

/**
 * Entropy floor, in bits, for the VARYING portion of an issued credential.
 * 64 bits is far below what any CSPRNG-derived token produces and far above
 * anything a counter, a timestamp, or a short `Math.random()` slice reaches,
 * so the threshold discriminates without sitting on a realistic boundary.
 */
export const MIN_ENTROPY_BITS = 64;

/**
 * Length of the longest common prefix shared by every string in `values`.
 *
 * @param {string[]} values
 * @returns {number}
 */
function commonPrefixLength(values) {
  const [first, ...rest] = values;
  let len = first.length;
  for (const value of rest) {
    let i = 0;
    while (i < len && i < value.length && value[i] === first[i]) i += 1;
    len = i;
    if (len === 0) break;
  }
  return len;
}

/**
 * Length of the longest common suffix shared by every string in `values`,
 * bounded so prefix and suffix can never overlap on the shortest sample.
 *
 * @param {string[]} values
 * @param {number} prefixLen
 * @returns {number}
 */
function commonSuffixLength(values, prefixLen) {
  const shortest = Math.min(...values.map((v) => v.length));
  const cap = Math.max(0, shortest - prefixLen);
  const [first, ...rest] = values;
  let len = cap;
  for (const value of rest) {
    let i = 0;
    while (
      i < len &&
      value[value.length - 1 - i] === first[first.length - 1 - i]
    ) {
      i += 1;
    }
    len = i;
    if (len === 0) break;
  }
  return len;
}

/**
 * Judge a collected credential sample distributionally. Pure — exposed so the
 * discrimination test can assert the decision rule directly, and so
 * {@link tokenStrengthProbe} and any future caller share one decision.
 *
 * @param {string[]} tokens — credentials as issued, in issue order.
 * @returns {{ verdict: 'clean'|'defect'|'unmeasurable', reasons: string[], entropyBits: number }}
 */
export function assessTokenSample(tokens) {
  const reasons = [];
  if (!Array.isArray(tokens) || tokens.length < MIN_SAMPLE_SIZE) {
    return {
      verdict: 'unmeasurable',
      reasons: [
        `only ${Array.isArray(tokens) ? tokens.length : 0} credential(s) collected; ${MIN_SAMPLE_SIZE} are needed for a distributional verdict`,
      ],
      entropyBits: 0,
    };
  }

  const distinct = new Set(tokens);
  if (distinct.size !== tokens.length) {
    reasons.push(
      `${tokens.length - distinct.size} of ${tokens.length} logins reissued a credential that had already been issued (sessions are not distinct)`,
    );
  }

  const prefixLen = commonPrefixLength(tokens);
  const suffixLen = commonSuffixLength(tokens, prefixLen);
  const varying = tokens.map((t) => t.slice(prefixLen, t.length - suffixLen));

  // Monotonicity: a counter or a raw clock reading, however it is wrapped.
  const numeric = varying.map((v) => Number(v));
  if (varying.every((v) => v.length > 0) && numeric.every(Number.isFinite)) {
    const ascending = numeric.every((n, i) => i === 0 || n > numeric[i - 1]);
    const descending = numeric.every((n, i) => i === 0 || n < numeric[i - 1]);
    if (ascending || descending) {
      reasons.push(
        `the varying portion of every credential is numeric and strictly ${ascending ? 'increasing' : 'decreasing'} across the sample (a counter or a raw clock reading — the next credential is guessable)`,
      );
    }
  }

  const alphabet = new Set(varying.join(''));
  const meanVaryingLength =
    varying.reduce((sum, v) => sum + v.length, 0) / varying.length;
  const entropyBits =
    alphabet.size > 1 ? meanVaryingLength * Math.log2(alphabet.size) : 0;
  if (entropyBits < MIN_ENTROPY_BITS) {
    reasons.push(
      `the varying portion carries only ~${entropyBits.toFixed(1)} bits (mean ${meanVaryingLength.toFixed(1)} varying chars over a ${alphabet.size}-symbol alphabet), below the ${MIN_ENTROPY_BITS}-bit floor`,
    );
  }

  return {
    verdict: reasons.length > 0 ? 'defect' : 'clean',
    reasons,
    entropyBits,
  };
}

/**
 * Collect a login sample from a running delivered app and judge it.
 *
 * @param {{ request: Function }} client
 * @returns {Promise<object>} a trap verdict.
 */
export async function tokenStrengthProbe(client) {
  const principal = await authenticate(client, AUTH_ROUTES);

  const tokens = [principal.token];
  for (let i = 1; i < SAMPLE_SIZE; i += 1) {
    const res = await client.request(AUTH_ROUTES.loginPath, {
      method: 'POST',
      body: { username: principal.username, password: principal.password },
    });
    if (!isSuccess(res.status)) break;
    const token = res.body?.[AUTH_ROUTES.tokenField];
    if (typeof token !== 'string' || token.length === 0) break;
    tokens.push(token);
  }

  const { verdict, reasons, entropyBits } = assessTokenSample(tokens);

  if (verdict === 'unmeasurable') {
    return unmeasured(
      `the login route did not yield a usable credential sample: ${reasons.join('; ')}`,
    );
  }
  if (verdict === 'defect') {
    return measured({
      defectPresent: true,
      evidence: [
        `planted defect DETECTED behaviourally: ${tokens.length} issued credentials are predictable as a distribution`,
        ...reasons,
      ],
    });
  }
  return measured({
    defectPresent: false,
    evidence: [
      `clean: ${tokens.length} issued credentials are all distinct, non-monotonic, and carry ~${entropyBits.toFixed(1)} bits in their varying portion (floor ${MIN_ENTROPY_BITS})`,
    ],
  });
}

/**
 * Boot the delivered app and probe it for the planted defect — the contract
 * `bench/scenarios/trap-runner.js` calls.
 *
 * @param {string} deliveredTreePath — absolute path to the delivered app tree.
 * @param {object} [ports] — see `probeDeliveredApp`; tests inject `app`.
 * @returns {Promise<{ score: 0|1|null, defectPresent: boolean|null, measured: boolean, evidence: string[] }>}
 */
export function evaluate(deliveredTreePath, ports = {}) {
  return probeDeliveredApp(deliveredTreePath, tokenStrengthProbe, {
    scenarioDir: SCENARIO_DIR,
    ...ports,
  });
}
