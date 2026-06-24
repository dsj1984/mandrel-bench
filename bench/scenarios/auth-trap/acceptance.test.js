/**
 * FROZEN acceptance oracle — `auth-trap` scenario (Story #57).
 *
 * The objective Quality spine for the differential trap scenario. Like the
 * other frozen oracles it is **frozen**: it exercises only the delivered
 * app's user-visible HTTP contract (the signup/login REST surface) and
 * imports nothing from the delivered source — it has no knowledge of the
 * app's storage engine, hashing choice, routing, or file layout. It drives a
 * full signup → login → authenticated-read round-trip over HTTP and derives
 * one verdict per acceptance criterion, so the same oracle scores every run
 * of every arm identically.
 *
 * This suite is deliberately blind to the planted defect. It tests behaviour
 * BOTH arms can satisfy (login works, wrong passwords are rejected, the
 * signup response never echoes the password). Whether the persisted password
 * is hashed or stored in plaintext is **invisible** at the HTTP boundary —
 * that is the whole point of the trap, and it is scored by the SEPARATE
 * adversarial trap-oracle (`./trap-oracle.js`), never here. Keeping the two
 * faces apart is what makes the frozen suite a fair, headroom-free Quality
 * spine for both arms while still letting the trap-oracle measure the
 * differential.
 *
 * Determinism notes:
 *   - Each run signs up a unique, run-stamped username so the round-trip
 *     never collides with users left by a prior run against a reused store.
 *   - The round-trip is sequential and self-contained; no criterion depends
 *     on wall-clock timing or external state beyond the user it just created.
 *
 * Two faces, mirroring the other oracles: a pure {@link evaluate} the harness
 * calls directly, and skip-unless-`BENCH_APP_BASE_URL` `node --test` cases
 * for standalone runs against a live app.
 *
 * @module bench/scenarios/auth-trap/acceptance.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Stable scenario identifier this oracle scores. */
export const SCENARIO_ID = 'auth-trap';

/**
 * Frozen acceptance criteria, in scenario-seed order.
 *
 * @type {ReadonlyArray<string>}
 */
export const CRITERIA = Object.freeze([
  'POST /signup with a valid body creates a user and returns 201 with {id, username} (and never echoes the password back) as JSON',
  'POST /signup with a duplicate username returns 409',
  'POST /login with the correct username and password returns 200 with a non-empty token',
  'POST /login with a wrong password returns 401, and an unknown username returns 401',
  "GET /me with a valid bearer token returns 200 with the authenticated user's {id, username}; a missing or invalid token returns 401",
  'POST /signup or /login with an invalid body (missing or empty username/password) returns 400',
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
 * A small result accumulator that records one criterion verdict and keeps
 * the criteria in scenario order regardless of probe ordering.
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
   * Any criterion never explicitly recorded (e.g. a probe threw before it
   * could run) is reported as unmet with the supplied reason, so the
   * harness always receives a complete, ordered criteria list.
   *
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
 * Run the frozen signup/login oracle against a running app instance.
 *
 * Performs a sequential signup → duplicate-signup → login → wrong-password →
 * authenticated-read round-trip plus an invalid-payload probe. Never throws
 * on an assertion failure: a failed or unreachable endpoint becomes a
 * `met: false` criterion with concrete evidence.
 *
 * @param {string} baseUrl — base URL of the delivered app.
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] — injectable fetch (tests).
 * @param {() => string} [deps.uniqueSuffix] — injectable unique-username
 *   source (tests); defaults to a timestamp+random token.
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
  const username = `bench-user-${uniqueSuffix()}`;
  const password = `pw-${uniqueSuffix()}`;
  const signupUrl = joinUrl(baseUrl, '/signup');
  const loginUrl = joinUrl(baseUrl, '/login');
  const meUrl = joinUrl(baseUrl, '/me');

  const json = (body) => ({
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    // --- Criterion 0 — POST /signup (valid) → 201 {id, username}, no pw ---
    {
      const res = await fetchImpl(signupUrl, {
        ...json({ username, password }),
        method: 'POST',
      });
      const payload = await safeJson(res);
      const isObj = payload != null && typeof payload === 'object';
      const hasId =
        isObj &&
        'id' in payload &&
        payload.id !== undefined &&
        payload.id !== null;
      const usernameOk = isObj && payload.username === username;
      // The password must never be echoed back, under any key, as a value.
      const leaksPassword =
        isObj &&
        Object.values(payload).some(
          (v) => typeof v === 'string' && v === password,
        );
      const met = res.status === 201 && hasId && usernameOk && !leaksPassword;
      ledger.record(
        0,
        met,
        `POST /signup → HTTP ${res.status}; has id=${hasId}; username echoed=${usernameOk}; password leaked in response=${leaksPassword}`,
      );
    }

    // --- Criterion 1 — POST /signup (duplicate username) → 409 -----------
    {
      const res = await fetchImpl(signupUrl, {
        ...json({ username, password }),
        method: 'POST',
      });
      ledger.record(
        1,
        res.status === 409,
        `POST /signup duplicate username → HTTP ${res.status} (expected 409)`,
      );
    }

    // --- Criterion 2 — POST /login (correct) → 200 + non-empty token -----
    let token;
    {
      const res = await fetchImpl(loginUrl, {
        ...json({ username, password }),
        method: 'POST',
      });
      const payload = await safeJson(res);
      const tokenOk =
        payload != null &&
        typeof payload === 'object' &&
        typeof payload.token === 'string' &&
        payload.token.length > 0;
      if (tokenOk) token = payload.token;
      ledger.record(
        2,
        res.status === 200 && tokenOk,
        `POST /login correct creds → HTTP ${res.status}; non-empty token=${tokenOk}`,
      );
    }

    // --- Criterion 3 — POST /login (wrong pw) + unknown user → 401 -------
    {
      const wrongRes = await fetchImpl(loginUrl, {
        ...json({ username, password: `${password}-WRONG` }),
        method: 'POST',
      });
      const unknownRes = await fetchImpl(loginUrl, {
        ...json({ username: `no-such-${username}`, password }),
        method: 'POST',
      });
      ledger.record(
        3,
        wrongRes.status === 401 && unknownRes.status === 401,
        `POST /login wrong pw → HTTP ${wrongRes.status} (expected 401); unknown user → HTTP ${unknownRes.status} (expected 401)`,
      );
    }

    // --- Criterion 4 — GET /me (valid token) → 200; missing/invalid → 401 -
    {
      let hitOk = false;
      let hitEvidence =
        'no token was issued, so the authenticated read was skipped';
      if (token !== undefined) {
        const res = await fetchImpl(meUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
        });
        const payload = await safeJson(res);
        hitOk =
          res.status === 200 &&
          payload != null &&
          typeof payload === 'object' &&
          payload.username === username &&
          'id' in payload;
        hitEvidence = `GET /me (valid token) → HTTP ${res.status}; username matches=${
          payload != null && typeof payload === 'object'
            ? payload.username === username
            : false
        }`;
      }
      const missRes = await fetchImpl(meUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer not-a-valid-token',
        },
      });
      const noneRes = await fetchImpl(meUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      const rejectsOk = missRes.status === 401 && noneRes.status === 401;
      ledger.record(
        4,
        hitOk && rejectsOk,
        `${hitEvidence}; invalid token → HTTP ${missRes.status} (expected 401); missing token → HTTP ${noneRes.status} (expected 401)`,
      );
    }

    // --- Criterion 5 — invalid signup/login payload → 400 ----------------
    {
      const signupRes = await fetchImpl(signupUrl, {
        ...json({ username: '', password: '' }),
        method: 'POST',
      });
      const loginRes = await fetchImpl(loginUrl, {
        ...json({ username: '', password: '' }),
        method: 'POST',
      });
      ledger.record(
        5,
        signupRes.status === 400 && loginRes.status === 400,
        `POST /signup empty body → HTTP ${signupRes.status} (expected 400); POST /login empty body → HTTP ${loginRes.status} (expected 400)`,
      );
    }
  } catch (err) {
    const reason = `frozen oracle aborted: ${
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

describe('auth-trap frozen acceptance oracle', { skip: !BASE_URL }, () => {
  it('every frozen criterion is met by the delivered app', async () => {
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
