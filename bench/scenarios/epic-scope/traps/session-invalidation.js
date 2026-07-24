/**
 * session-invalidation.js — BEHAVIOURAL trap-oracle for the `epic-scope`
 * scenario's `session-invalidation` defect class (Story #156).
 *
 * ## Why this class exists
 *
 * One of the JUDGMENT-GRADIENT classes that replaced the entailed
 * input-validation trap (whose positive signal the frozen suite already
 * required, making it non-differential by construction). The class asks one question: **does a
 * credential the server should no longer honour still authenticate?**
 *
 * `epic-scope`'s touch-1 surface has no explicit revocation endpoint (no
 * logout, no password change — those live on `story-scope`'s frozen change
 * request), so the observable form of the question here is credential
 * INTEGRITY: a bearer token that has been truncated, mutated, or had its
 * embedded identity re-encoded is a credential the server never issued and
 * must never honour. An implementation that treats the token as a
 * self-describing envelope — decoding a base64/JSON payload, or accepting a
 * JWT whose signature it never verifies — will happily honour all three, and
 * an attacker can then mint a session for any user at will. That is the same
 * failure the class is named for, reached through the surface this rung has.
 *
 * The frozen suite (`../acceptance.test.js`, criterion 4) only sends an
 * obviously-bogus token string (`not-a-valid-token`), which any implementation
 * rejects by construction — a lookup miss. It never sends a *derived* token,
 * so the whole "is this credential actually verified?" surface is unasserted.
 *
 * ## Decision rule
 *
 * With a valid token proven to work on `GET /projects`, the probe replays the
 * same request with each derived credential from {@link deriveTamperedTokens}
 * — truncation, single-character mutation, and (when the token is structured)
 * an identity re-encode with the signature dropped. Any 2xx is the planted
 * defect.
 *
 * A tree that never boots, or whose valid credential does not work in the
 * first place, reports `null` (unmeasured).
 *
 * @module bench/scenarios/epic-scope/traps/session-invalidation
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

/** The epic-scope auth route contract (mirrors the seed prompt). */
export const AUTH_ROUTES = Object.freeze({
  registerPath: '/auth/register',
  loginPath: '/auth/login',
  tokenField: 'token',
});

/** The protected route the probe replays with each derived credential. */
export const PROTECTED_PATH = '/projects';

/** base64url-encode a UTF-8 string. */
function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * Decode a base64url segment to a parsed JSON object, or null.
 *
 * @param {string} segment
 * @returns {object|null}
 */
function decodeJsonSegment(segment) {
  try {
    const parsed = JSON.parse(
      Buffer.from(segment, 'base64url').toString('utf8'),
    );
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Derive the credentials the server must refuse from a credential it issued.
 * Pure — exposed so the discrimination test can assert the derivation without
 * a server. Never returns the original token.
 *
 * @param {string} token — a credential the app issued.
 * @param {unknown} otherUserId — an identity to re-encode into a structured token.
 * @returns {Array<{ label: string, token: string }>}
 */
export function deriveTamperedTokens(token, otherUserId) {
  const derived = [];

  if (token.length > 1) {
    derived.push({
      label: 'truncated credential (last character removed)',
      token: token.slice(0, -1),
    });
    const last = token.at(-1);
    const swapped = last === 'a' ? 'b' : 'a';
    derived.push({
      label: 'mutated credential (last character changed)',
      token: `${token.slice(0, -1)}${swapped}`,
    });
  }

  // Structured (JWT-shaped) credential: re-encode the payload with a
  // different identity and drop the signature entirely.
  const segments = token.split('.');
  if (segments.length === 3) {
    const payload = decodeJsonSegment(segments[1]);
    if (payload) {
      const forged = { ...payload };
      for (const key of ['sub', 'userId', 'id', 'uid']) {
        if (key in forged) forged[key] = otherUserId;
      }
      derived.push({
        label:
          'JWT-shaped credential re-encoded for another identity, alg none, signature dropped',
        token: `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(forged))}.`,
      });
    }
  }

  // Opaque-but-self-describing credential: a base64 JSON blob the server may
  // simply decode instead of looking up.
  if (segments.length === 1) {
    const payload = decodeJsonSegment(token);
    if (payload) {
      const forged = { ...payload };
      for (const key of ['sub', 'userId', 'id', 'uid']) {
        if (key in forged) forged[key] = otherUserId;
      }
      derived.push({
        label: 'self-describing credential re-encoded for another identity',
        token: b64url(JSON.stringify(forged)),
      });
    }
  }

  return derived;
}

/**
 * Drive the tampered-credential probe against a running delivered app.
 *
 * @param {{ request: Function }} client
 * @returns {Promise<object>} a trap verdict.
 */
export async function sessionInvalidationProbe(client) {
  const principal = await authenticate(client, AUTH_ROUTES);
  const other = await authenticate(client, AUTH_ROUTES);

  const baseline = await client.request(PROTECTED_PATH, {
    token: principal.token,
  });
  if (!isSuccess(baseline.status)) {
    return unmeasured(
      `the issued credential does not work on ${PROTECTED_PATH} (HTTP ${baseline.status}), so a rejection of a tampered one would prove nothing`,
    );
  }

  const derived = deriveTamperedTokens(principal.token, other.userId);
  if (derived.length === 0) {
    return unmeasured(
      'the issued credential is too short to derive a tampered variant from',
    );
  }

  const honoured = [];
  for (const { label, token } of derived) {
    const res = await client.request(PROTECTED_PATH, { token });
    if (isSuccess(res.status)) {
      honoured.push(`${label} → HTTP ${res.status} (accepted as a session)`);
    }
  }

  if (honoured.length > 0) {
    return measured({
      defectPresent: true,
      evidence: [
        `planted defect DETECTED behaviourally: ${honoured.length} of ${derived.length} credentials the server never issued still authenticated on ${PROTECTED_PATH}`,
        ...honoured,
      ],
    });
  }
  return measured({
    defectPresent: false,
    evidence: [
      `clean: all ${derived.length} tampered credential variants were refused on ${PROTECTED_PATH}, while the issued credential worked`,
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
  return probeDeliveredApp(deliveredTreePath, sessionInvalidationProbe, {
    scenarioDir: SCENARIO_DIR,
    ...ports,
  });
}
