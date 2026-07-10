/**
 * FROZEN touch-2 acceptance oracle — `story-scope` scenario's second touch
 * (Epic #86, Story #96).
 *
 * The frozen behavioural spine for the story-scope CHANGE REQUEST (the
 * "password change + session invalidation" second touch). Like the touch-1
 * frozen suite (`./acceptance.test.js`) it is **frozen**: it exercises only
 * the delivered app's user-visible HTTP contract and imports nothing from the
 * delivered source — it has no knowledge of the app's storage engine, hashing
 * choice, or session mechanism.
 *
 * Session invalidation is a BEHAVIOURAL property (Epic #86 pre-mortem, F2
 * point 4): it is asserted HERE, over the live HTTP boundary — a session
 * identifier issued before the password change must stop authenticating —
 * NOT by a source-scan oracle. A source scan could not tell whether an old
 * session token is actually rejected on the next request; only a round-trip
 * can. The source-scan face of the touch-2 axis (hashing preservation) lives
 * separately under `../traps-touch2/regression-hashing.js`.
 *
 * Two faces, mirroring the touch-1 oracle: a pure {@link evaluate} the harness
 * calls directly, and a skip-unless-`BENCH_APP_BASE_URL` `node --test` case for
 * standalone runs against a live app.
 *
 * @module bench/scenarios/story-scope/acceptance.touch2.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Stable scenario identifier this oracle scores. */
export const SCENARIO_ID = 'story-scope';

/**
 * Frozen touch-2 acceptance criteria, in change-request order.
 *
 * @type {ReadonlyArray<string>}
 */
export const CRITERIA = Object.freeze([
  'POST /password with a valid bearer credential and a non-empty newPassword returns 200; a missing/invalid credential returns 401 and an empty newPassword returns 400',
  'After a password change, a session identifier issued BEFORE the change no longer authenticates — GET /me with the old credential returns 401 (session invalidation)',
  'After the change the user can sign in again with the NEW password (POST /login returns 200 with a non-empty session identifier)',
  'After the change the OLD password is rejected (POST /login with the old password returns 401)',
]);

/**
 * Join a base URL and a path without producing a double slash.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * A small result accumulator that records one criterion verdict and keeps the
 * criteria in change-request order regardless of probe ordering.
 */
class CriteriaLedger {
  constructor() {
    /** @type {Map<number, { index: number, criterion: string, met: boolean, evidence: string }>} */
    this.byIndex = new Map();
  }

  /**
   * @param {number} index
   * @param {boolean} met
   * @param {string} evidence
   */
  record(index, met, evidence) {
    this.byIndex.set(index, {
      index,
      criterion: CRITERIA[index],
      met: Boolean(met),
      evidence,
    });
  }

  /**
   * @param {string} reason
   * @returns {Array<{ index: number, criterion: string, met: boolean, evidence: string }>}
   */
  finalize(reason) {
    const out = [];
    for (let i = 0; i < CRITERIA.length; i += 1) {
      out.push(
        this.byIndex.get(i) ?? {
          index: i,
          criterion: CRITERIA[i],
          met: false,
          evidence: reason,
        },
      );
    }
    return out;
  }
}

/**
 * Best-effort JSON parse that never throws.
 *
 * @param {Response} res
 * @returns {Promise<unknown>}
 */
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Run the frozen password-change + session-invalidation oracle against a
 * running app instance. Signs up a fresh, run-stamped user, logs in to obtain
 * a session, probes the change endpoint's validation, changes the password,
 * and then asserts the four change-request behaviours over HTTP. Never throws
 * on an assertion failure: a failed or unreachable endpoint becomes a
 * `met: false` criterion with concrete evidence.
 *
 * @param {string} baseUrl
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] — injectable fetch (tests).
 * @param {() => string} [deps.uniqueSuffix] — injectable unique-username source.
 * @returns {Promise<{
 *   scenario: string,
 *   passed: boolean,
 *   criteria: Array<{ index: number, criterion: string, met: boolean, evidence: string }>,
 * }>}
 */
export async function evaluate(
  baseUrl,
  {
    fetchImpl = fetch,
    uniqueSuffix = () =>
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } = {},
) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError(
      'evaluate(baseUrl): baseUrl must be a non-empty string',
    );
  }

  const ledger = new CriteriaLedger();
  const suffix = uniqueSuffix();
  const username = `bench-touch2-${suffix}`;
  const oldPassword = `pw-old-${suffix}`;
  const newPassword = `pw-new-${suffix}`;
  const signupUrl = joinUrl(baseUrl, '/signup');
  const loginUrl = joinUrl(baseUrl, '/login');
  const meUrl = joinUrl(baseUrl, '/me');
  const passwordUrl = joinUrl(baseUrl, '/password');

  const json = (body) => ({
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const bearer = (session) => ({
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${session}`,
    },
  });

  try {
    // --- Arrange: sign up + log in to obtain the pre-change session ------
    await fetchImpl(signupUrl, {
      ...json({ username, password: oldPassword }),
      method: 'POST',
    });
    const loginRes = await fetchImpl(loginUrl, {
      ...json({ username, password: oldPassword }),
      method: 'POST',
    });
    const loginPayload = await safeJson(loginRes);
    const oldSession =
      loginPayload && typeof loginPayload === 'object'
        ? loginPayload.session
        : undefined;

    if (loginRes.status !== 200 || !oldSession) {
      // Cannot exercise the change request without a starting session — every
      // criterion is unmet with a shared, concrete reason.
      const reason = `precondition failed: login before change returned ${loginRes.status} with session=${String(oldSession)}`;
      const criteria = ledger.finalize(reason);
      return { scenario: SCENARIO_ID, passed: false, criteria };
    }

    // --- Criterion 0 — POST /password validation + happy path -----------
    {
      // No credential ⇒ 401.
      const noCredRes = await fetchImpl(passwordUrl, {
        ...json({ newPassword }),
        method: 'POST',
      });
      const noCredOk = noCredRes.status === 401;

      // Valid credential, empty newPassword ⇒ 400.
      const emptyRes = await fetchImpl(passwordUrl, {
        ...bearer(oldSession),
        body: JSON.stringify({ newPassword: '' }),
        method: 'POST',
      });
      const emptyOk = emptyRes.status === 400;

      // Valid credential, valid newPassword ⇒ 200.
      const changeRes = await fetchImpl(passwordUrl, {
        ...bearer(oldSession),
        body: JSON.stringify({ newPassword }),
        method: 'POST',
      });
      const changeOk = changeRes.status === 200;

      ledger.record(
        0,
        noCredOk && emptyOk && changeOk,
        `no-credential→${noCredRes.status} (want 401), empty-newPassword→${emptyRes.status} (want 400), change→${changeRes.status} (want 200)`,
      );

      if (!changeOk) {
        // The password never changed — the remaining criteria are all
        // downstream of a successful change, so mark them unmet explicitly.
        const reason = `password change did not succeed (POST /password → ${changeRes.status})`;
        ledger.record(1, false, reason);
        ledger.record(2, false, reason);
        ledger.record(3, false, reason);
        const criteria = ledger.finalize(reason);
        return { scenario: SCENARIO_ID, passed: false, criteria };
      }
    }

    // --- Criterion 1 — the pre-change session is invalidated ------------
    {
      const meRes = await fetchImpl(meUrl, { ...bearer(oldSession) });
      const met = meRes.status === 401;
      ledger.record(
        1,
        met,
        `GET /me with the pre-change session → ${meRes.status} (want 401 — old session must be rejected)`,
      );
    }

    // --- Criterion 2 — sign in with the NEW password --------------------
    let newSession;
    {
      const res = await fetchImpl(loginUrl, {
        ...json({ username, password: newPassword }),
        method: 'POST',
      });
      const payload = await safeJson(res);
      newSession =
        payload && typeof payload === 'object' ? payload.session : undefined;
      const met =
        res.status === 200 &&
        typeof newSession === 'string' &&
        newSession.length > 0;
      ledger.record(
        2,
        met,
        `POST /login with the new password → ${res.status}, session present=${Boolean(newSession)} (want 200 + session)`,
      );
    }

    // --- Criterion 3 — the OLD password no longer works -----------------
    {
      const res = await fetchImpl(loginUrl, {
        ...json({ username, password: oldPassword }),
        method: 'POST',
      });
      const met = res.status === 401;
      ledger.record(
        3,
        met,
        `POST /login with the old password → ${res.status} (want 401 — old password must be rejected)`,
      );
    }
  } catch (err) {
    const reason = `frozen touch-2 oracle aborted: ${
      err instanceof Error ? err.message : String(err)
    }`;
    const criteria = ledger.finalize(reason);
    return { scenario: SCENARIO_ID, passed: false, criteria };
  }

  const criteria = ledger.finalize('criterion probe did not run');
  return {
    scenario: SCENARIO_ID,
    passed: criteria.every((c) => c.met),
    criteria,
  };
}

// --- Standalone `node --test` face -------------------------------------

const BASE_URL = process.env.BENCH_APP_BASE_URL;

describe('story-scope frozen touch-2 acceptance oracle', {
  skip: !BASE_URL,
}, () => {
  it('every frozen touch-2 criterion is met by the delivered app', async () => {
    const result = await evaluate(/** @type {string} */ (BASE_URL));
    const failed = result.criteria.filter((c) => !c.met);
    assert.equal(
      failed.length,
      0,
      `unmet criteria: ${failed.map((c) => `${c.criterion} — ${c.evidence}`).join('; ')}`,
    );
    assert.equal(result.passed, true);
  });
});
