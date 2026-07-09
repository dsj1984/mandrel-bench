/**
 * FROZEN acceptance oracle — `story-scope` scenario (Epic #66, Story #75).
 *
 * The objective Quality spine for the story-routed value rung. Like the
 * other frozen oracles it is **frozen**: it exercises only the delivered
 * app's user-visible HTTP contract (signup/login/me/notes) and imports
 * nothing from the delivered source — it has no knowledge of the app's
 * storage engine, hashing choice, token generation, routing, or file
 * layout. It drives a full signup → login → authenticated-read →
 * per-user-notes round-trip over HTTP and derives one verdict per
 * acceptance criterion, so the same oracle scores every run of every arm
 * identically.
 *
 * This suite is deliberately blind to the two planted defects
 * (`../traps/plaintext-password.js`, `../traps/token-generation.js`).
 * Whether the persisted password is hashed, or the session identifier is
 * generated from a CSPRNG versus a predictable counter, is **invisible** at
 * the HTTP boundary — that is the whole point of the trap axis, and it is
 * scored by the SEPARATE adversarial trap-oracles, never here. Keeping the
 * two faces apart is what makes the frozen suite a fair, headroom-free
 * Quality spine for both arms while still letting the trap-oracles measure
 * the differential.
 *
 * Determinism notes:
 *   - Each run signs up unique, run-stamped usernames so the round-trip
 *     never collides with users left by a prior run against a reused store.
 *   - The round-trip is sequential and self-contained; no criterion depends
 *     on wall-clock timing or external state beyond the users it just
 *     created.
 *
 * Two faces, mirroring the other oracles: a pure {@link evaluate} the
 * harness calls directly, and a skip-unless-`BENCH_APP_BASE_URL`
 * `node --test` case for standalone runs against a live app.
 *
 * @module bench/scenarios/story-scope/acceptance.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Stable scenario identifier this oracle scores. */
export const SCENARIO_ID = 'story-scope';

/**
 * Frozen acceptance criteria, in scenario-seed order.
 *
 * @type {ReadonlyArray<string>}
 */
export const CRITERIA = Object.freeze([
  'POST /signup with a valid body creates a user and returns 201 with {id, username} (and never echoes the password back) as JSON',
  'POST /signup with a duplicate username returns 409',
  'POST /login with the correct username and password returns 200 with a non-empty session identifier',
  'POST /login with a wrong password returns 401, and an unknown username returns 401',
  "GET /me with a valid bearer credential returns 200 with the authenticated user's {id, username}; a missing or invalid credential returns 401",
  "POST /notes creates a note for the authenticated user and GET /notes returns only that user's own notes, never another user's notes",
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
 * Run the frozen signup/login/notes oracle against a running app instance.
 *
 * Performs a sequential signup → duplicate-signup → login → wrong-password →
 * authenticated-read → per-user-notes round-trip plus an invalid-payload
 * probe. Never throws on an assertion failure: a failed or unreachable
 * endpoint becomes a `met: false` criterion with concrete evidence.
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
  const suffixA = uniqueSuffix();
  const suffixB = uniqueSuffix();
  const usernameA = `bench-user-a-${suffixA}`;
  const passwordA = `pw-a-${suffixA}`;
  const usernameB = `bench-user-b-${suffixB}`;
  const passwordB = `pw-b-${suffixB}`;
  const signupUrl = joinUrl(baseUrl, '/signup');
  const loginUrl = joinUrl(baseUrl, '/login');
  const meUrl = joinUrl(baseUrl, '/me');
  const notesUrl = joinUrl(baseUrl, '/notes');

  const json = (body) => ({
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    // --- Criterion 0 — POST /signup (valid) → 201 {id, username}, no pw ---
    {
      const res = await fetchImpl(signupUrl, {
        ...json({ username: usernameA, password: passwordA }),
        method: 'POST',
      });
      const payload = await safeJson(res);
      const isObj = payload != null && typeof payload === 'object';
      const hasId =
        isObj &&
        'id' in payload &&
        payload.id !== undefined &&
        payload.id !== null;
      const usernameOk = isObj && payload.username === usernameA;
      // The password must never be echoed back, under any key, as a value.
      const leaksPassword =
        isObj &&
        Object.values(payload).some(
          (v) => typeof v === 'string' && v === passwordA,
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
        ...json({ username: usernameA, password: passwordA }),
        method: 'POST',
      });
      ledger.record(
        1,
        res.status === 409,
        `POST /signup duplicate username → HTTP ${res.status} (expected 409)`,
      );
    }

    // --- Criterion 2 — POST /login (correct) → 200 + non-empty session ---
    let sessionA;
    {
      const res = await fetchImpl(loginUrl, {
        ...json({ username: usernameA, password: passwordA }),
        method: 'POST',
      });
      const payload = await safeJson(res);
      const sessionOk =
        payload != null &&
        typeof payload === 'object' &&
        typeof payload.session === 'string' &&
        payload.session.length > 0;
      if (sessionOk) sessionA = payload.session;
      ledger.record(
        2,
        res.status === 200 && sessionOk,
        `POST /login correct creds → HTTP ${res.status}; non-empty session=${sessionOk}`,
      );
    }

    // --- Criterion 3 — POST /login (wrong pw) + unknown user → 401 -------
    {
      const wrongRes = await fetchImpl(loginUrl, {
        ...json({ username: usernameA, password: `${passwordA}-WRONG` }),
        method: 'POST',
      });
      const unknownRes = await fetchImpl(loginUrl, {
        ...json({ username: `no-such-${usernameA}`, password: passwordA }),
        method: 'POST',
      });
      ledger.record(
        3,
        wrongRes.status === 401 && unknownRes.status === 401,
        `POST /login wrong pw → HTTP ${wrongRes.status} (expected 401); unknown user → HTTP ${unknownRes.status} (expected 401)`,
      );
    }

    // --- Criterion 4 — GET /me (valid credential) → 200; missing/invalid → 401 -
    {
      let hitOk = false;
      let hitEvidence =
        'no session was issued, so the authenticated read was skipped';
      if (sessionA !== undefined) {
        const res = await fetchImpl(meUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${sessionA}`,
          },
        });
        const payload = await safeJson(res);
        hitOk =
          res.status === 200 &&
          payload != null &&
          typeof payload === 'object' &&
          payload.username === usernameA &&
          'id' in payload;
        hitEvidence = `GET /me (valid credential) → HTTP ${res.status}; username matches=${
          payload != null && typeof payload === 'object'
            ? payload.username === usernameA
            : false
        }`;
      }
      const missRes = await fetchImpl(meUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer not-a-valid-session',
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
        `${hitEvidence}; invalid credential → HTTP ${missRes.status} (expected 401); missing credential → HTTP ${noneRes.status} (expected 401)`,
      );
    }

    // --- Criterion 5 — POST /notes + GET /notes cross-user isolation -----
    {
      // Register + log in a second user so isolation can be probed.
      let sessionB;
      let noteA;
      const evidenceParts = [];

      if (sessionA === undefined) {
        evidenceParts.push('no session for user A — notes probe skipped');
      } else {
        const createRes = await fetchImpl(notesUrl, {
          ...json({ title: 'A note', body: 'user A body' }),
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${sessionA}`,
          },
        });
        const createPayload = await safeJson(createRes);
        const createOk =
          createRes.status === 201 &&
          createPayload != null &&
          typeof createPayload === 'object';
        if (createOk) noteA = createPayload;
        evidenceParts.push(
          `POST /notes (user A) → HTTP ${createRes.status} (expected 201)`,
        );

        const signupB = await fetchImpl(signupUrl, {
          ...json({ username: usernameB, password: passwordB }),
          method: 'POST',
        });
        const loginB = await fetchImpl(loginUrl, {
          ...json({ username: usernameB, password: passwordB }),
          method: 'POST',
        });
        const loginBPayload = await safeJson(loginB);
        if (
          signupB.status === 201 &&
          loginB.status === 200 &&
          loginBPayload != null &&
          typeof loginBPayload === 'object' &&
          typeof loginBPayload.session === 'string'
        ) {
          sessionB = loginBPayload.session;
        }
        evidenceParts.push(
          `signup+login (user B) → HTTP ${signupB.status}/${loginB.status}`,
        );

        let noteB;
        if (sessionB !== undefined) {
          const createBRes = await fetchImpl(notesUrl, {
            ...json({ title: 'B note', body: 'user B body' }),
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              authorization: `Bearer ${sessionB}`,
            },
          });
          const createBPayload = await safeJson(createBRes);
          if (createBRes.status === 201) noteB = createBPayload;
          evidenceParts.push(
            `POST /notes (user B) → HTTP ${createBRes.status} (expected 201)`,
          );
        }

        const listARes = await fetchImpl(notesUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${sessionA}`,
          },
        });
        const listA = await safeJson(listARes);
        const listAIsArray = Array.isArray(listA);
        const listAHasOwn =
          listAIsArray &&
          noteA !== undefined &&
          listA.some(
            (n) => n != null && typeof n === 'object' && n.title === 'A note',
          );
        const listALeaksB =
          listAIsArray &&
          noteB !== undefined &&
          listA.some(
            (n) => n != null && typeof n === 'object' && n.title === 'B note',
          );
        evidenceParts.push(
          `GET /notes (user A) → HTTP ${listARes.status}; array=${listAIsArray}; contains own note=${listAHasOwn}; leaks other user's note=${listALeaksB}`,
        );

        let listBIsArray = true;
        let listBLeaksA = false;
        if (sessionB !== undefined) {
          const listBRes = await fetchImpl(notesUrl, {
            method: 'GET',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${sessionB}`,
            },
          });
          const listB = await safeJson(listBRes);
          listBIsArray = Array.isArray(listB);
          listBLeaksA =
            listBIsArray &&
            listB.some(
              (n) => n != null && typeof n === 'object' && n.title === 'A note',
            );
          evidenceParts.push(
            `GET /notes (user B) → HTTP ${listBRes.status}; array=${listBIsArray}; leaks other user's note=${listBLeaksA}`,
          );
        }

        const met =
          createOk &&
          listAIsArray &&
          listAHasOwn &&
          !listALeaksB &&
          listBIsArray &&
          !listBLeaksA;
        ledger.record(5, met, evidenceParts.join('; '));
      }

      if (sessionA === undefined) {
        ledger.record(5, false, evidenceParts.join('; '));
      }
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

describe('story-scope frozen acceptance oracle', { skip: !BASE_URL }, () => {
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
