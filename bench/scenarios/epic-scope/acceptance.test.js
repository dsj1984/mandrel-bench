/**
 * FROZEN acceptance oracle — `epic-scope` scenario (Epic #66, Story #78).
 *
 * The objective Quality spine for the epic-routed value rung. Like the other
 * frozen oracles it is **frozen**: it exercises only the delivered app's
 * user-visible HTTP contract (auth, projects, tasks surfaces) and imports
 * nothing from the delivered source — it has no knowledge of the app's
 * storage engine, token-signing mechanism, ownership-check implementation,
 * or file layout. It drives a full multi-user, multi-resource round-trip
 * over HTTP and derives one verdict per acceptance criterion, so the same
 * oracle scores every run of every arm identically.
 *
 * This suite is deliberately blind to the four planted defects
 * (`../traps/plaintext-password.js`, `../traps/idor.js`,
 * `../traps/missing-input-validation.js`, `../traps/hardcoded-secret.js`).
 * Whether the persisted password is hashed, whether an ownership check
 * guards every id-addressed lookup, whether a write handler validates its
 * payload internally versus by accident, or whether the token-signing key
 * is read from the environment versus inlined, is **invisible** at the HTTP
 * boundary in the common case a terse implementation still returns the
 * right status codes — that is the whole point of the trap axis, and it is
 * scored by the SEPARATE adversarial trap-oracles, never here. Keeping the
 * two faces apart is what makes the frozen suite a fair, headroom-free
 * Quality spine for both arms while still letting the trap-oracles measure
 * the differential.
 *
 * Determinism notes:
 *   - Each run signs up unique, run-stamped usernames so the round-trip
 *     never collides with users left by a prior run against a reused store.
 *   - The round-trip is sequential and self-contained; no criterion depends
 *     on wall-clock timing or external state beyond the resources it just
 *     created.
 *
 * Two faces, mirroring the other oracles: a pure {@link evaluate} the
 * harness calls directly, and a skip-unless-`BENCH_APP_BASE_URL`
 * `node --test` case for standalone runs against a live app.
 *
 * @module bench/scenarios/epic-scope/acceptance.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Stable scenario identifier this oracle scores. */
export const SCENARIO_ID = 'epic-scope';

/**
 * Frozen acceptance criteria, in scenario-seed order.
 *
 * @type {ReadonlyArray<string>}
 */
export const CRITERIA = Object.freeze([
  'POST /auth/register with valid credentials returns 201 with { id, username } and persists the user',
  'POST /auth/register with a duplicate username returns 409',
  'POST /auth/register with missing or empty fields returns 400',
  'POST /auth/login with valid credentials returns 200 with a bearer token',
  'POST /auth/login with an unknown username or wrong password returns 401',
  'Requests to a protected endpoint without a token return 401',
  'Requests to a protected endpoint with an invalid token return 401',
  'POST /projects with a valid name returns 201 with the created project (id, name, ownerId, createdAt)',
  'POST /projects with an empty name returns 400',
  "GET /projects returns 200 with a JSON array containing only the authenticated user's own projects, never another user's projects",
  'GET /projects/:id returns the matching project when owned by the authenticated user, and 404 for an unknown id',
  'GET /projects/:id for a project owned by a different user returns 404, not the project',
  'DELETE /projects/:id removes the project and all its tasks and returns 204; a subsequent GET returns 404',
  'DELETE /projects/:id for a project owned by a different user returns 404 and leaves the project intact',
  'POST /projects/:projectId/tasks with a valid title returns 201 with the task (id, title, projectId, assigneeId, createdAt, done: false)',
  'POST /projects/:projectId/tasks with an assigneeId for a valid user sets the assignee; an unknown assigneeId returns 400',
  'POST /projects/:projectId/tasks with a missing or empty title returns 400',
  'POST /projects/:projectId/tasks against a project not owned by the authenticated user returns 404',
  'GET /projects/:projectId/tasks returns a paginated response { items, total, page, pageSize } respecting ?page and ?pageSize',
  'GET /projects/:projectId/tasks with a ?done=true or ?done=false filter returns only tasks matching that done value',
  'PATCH /projects/:projectId/tasks/:taskId updates title and/or done and returns the updated task',
  'DELETE /projects/:projectId/tasks/:taskId removes the task and returns 204; a subsequent GET of the task list no longer includes it',
  'Every non-2xx JSON response across every endpoint shares one consistent error envelope: a top-level object with a string "error" field',
  'Data for users, projects, and tasks persists across a server restart',
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
 * `true` when `payload` conforms to the scenario's consistent error
 * envelope: a JSON object carrying a single non-empty string `error` field.
 *
 * @param {unknown} payload
 * @returns {boolean}
 */
function isErrorEnvelope(payload) {
  return (
    payload != null &&
    typeof payload === 'object' &&
    typeof payload.error === 'string' &&
    payload.error.length > 0
  );
}

/**
 * Run the frozen multi-user project/task oracle against a running app
 * instance.
 *
 * Drives a sequential auth → project → task round-trip for two independent
 * users (A and B) so cross-user isolation can be probed at every
 * id-addressed surface, plus pagination, filtering, cascade delete, and a
 * consistent-error-envelope sweep. Never throws on an assertion failure: a
 * failed or unreachable endpoint becomes a `met: false` criterion with
 * concrete evidence.
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
  const passwordA = `bench-pass-a-${suffixA}`;
  const usernameB = `bench-user-b-${suffixB}`;
  const passwordB = `bench-pass-b-${suffixB}`;

  const jsonHeaders = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const post = (body) => ({
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  const authHeaders = (token) => ({
    headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
  });

  /** @type {Array<unknown>} */
  const errorPayloads = [];
  const collect = async (res) => {
    if (res.status >= 300) {
      const payload = await safeJson(res);
      errorPayloads.push({ status: res.status, payload });
      return payload;
    }
    return safeJson(res);
  };

  try {
    // ---- Criterion 0 — POST /auth/register (valid, user A) → 201 --------
    let userIdA;
    {
      const res = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: usernameA, password: passwordA }),
      );
      const payload = await collect(res);
      const hasId =
        payload != null && typeof payload === 'object' && 'id' in payload;
      const usernameOk =
        payload != null &&
        typeof payload === 'object' &&
        payload.username === usernameA;
      if (hasId) userIdA = payload.id;
      ledger.record(
        0,
        res.status === 201 && hasId && usernameOk,
        `POST /auth/register (A) → HTTP ${res.status}; id=${hasId}; username match=${usernameOk}`,
      );
    }

    // ---- Criterion 1 — duplicate username → 409 --------------------------
    {
      const res = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: usernameA, password: passwordA }),
      );
      await collect(res);
      ledger.record(
        1,
        res.status === 409,
        `POST /auth/register duplicate → HTTP ${res.status} (expected 409)`,
      );
    }

    // ---- Criterion 2 — missing/empty fields → 400 -------------------------
    {
      const res = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: '', password: '' }),
      );
      await collect(res);
      ledger.record(
        2,
        res.status === 400,
        `POST /auth/register empty fields → HTTP ${res.status} (expected 400)`,
      );
    }

    // ---- Criterion 3 — POST /auth/login (valid, user A) → 200 { token } --
    let tokenA;
    {
      const res = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: usernameA, password: passwordA }),
      );
      const payload = await safeJson(res);
      const hasToken =
        payload != null &&
        typeof payload === 'object' &&
        typeof payload.token === 'string' &&
        payload.token.length > 0;
      if (hasToken) tokenA = payload.token;
      ledger.record(
        3,
        res.status === 200 && hasToken,
        `POST /auth/login (A) → HTTP ${res.status}; token present=${hasToken}`,
      );
    }

    // ---- Criterion 4 — unknown username / wrong password → 401 -----------
    {
      const wrongRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: usernameA, password: `${passwordA}-WRONG` }),
      );
      await collect(wrongRes);
      const unknownRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: `no-such-${usernameA}`, password: passwordA }),
      );
      await collect(unknownRes);
      ledger.record(
        4,
        wrongRes.status === 401 && unknownRes.status === 401,
        `wrong password → HTTP ${wrongRes.status} (expected 401); unknown user → HTTP ${unknownRes.status} (expected 401)`,
      );
    }

    // ---- Criterion 5 — protected endpoint, no token → 401 -----------------
    {
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      await collect(res);
      ledger.record(
        5,
        res.status === 401,
        `GET /projects (no token) → HTTP ${res.status} (expected 401)`,
      );
    }

    // ---- Criterion 6 — protected endpoint, invalid token → 401 -----------
    {
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'GET',
        headers: { ...jsonHeaders, authorization: 'Bearer invalid-token-xyz' },
      });
      await collect(res);
      ledger.record(
        6,
        res.status === 401,
        `GET /projects (invalid token) → HTTP ${res.status} (expected 401)`,
      );
    }

    // ---- Register + log in user B (for isolation probes below) -----------
    let tokenB;
    {
      const regRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/register'),
        post({ username: usernameB, password: passwordB }),
      );
      await safeJson(regRes);
      const loginRes = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: usernameB, password: passwordB }),
      );
      const loginPayload = await safeJson(loginRes);
      if (
        regRes.status === 201 &&
        loginRes.status === 200 &&
        loginPayload != null &&
        typeof loginPayload === 'object' &&
        typeof loginPayload.token === 'string'
      ) {
        tokenB = loginPayload.token;
      }
    }

    const useTokenA = tokenA ?? '';
    const useTokenB = tokenB ?? '';

    // ---- Criterion 7 — POST /projects (valid, A) → 201 --------------------
    let projectA1; // used later for the delete/cascade probe
    {
      const name = `bench-project-a1-${suffixA}`;
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        ...post({ name }),
        ...authHeaders(useTokenA),
        method: 'POST',
      });
      const payload = await collect(res);
      const hasShape =
        payload != null &&
        typeof payload === 'object' &&
        'id' in payload &&
        'name' in payload &&
        'ownerId' in payload &&
        'createdAt' in payload;
      if (hasShape) projectA1 = payload.id;
      ledger.record(
        7,
        res.status === 201 && hasShape && payload?.name === name,
        `POST /projects (A) → HTTP ${res.status}; shape=${hasShape}; name match=${payload?.name === name}`,
      );
    }

    // ---- Criterion 8 — POST /projects (empty name) → 400 ------------------
    {
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        ...post({ name: '' }),
        ...authHeaders(useTokenA),
        method: 'POST',
      });
      await collect(res);
      ledger.record(
        8,
        res.status === 400,
        `POST /projects empty name → HTTP ${res.status} (expected 400)`,
      );
    }

    // A second project for A, kept alive for the task-CRUD probes below.
    let projectA2;
    {
      const name = `bench-project-a2-${suffixA}`;
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        ...post({ name }),
        ...authHeaders(useTokenA),
        method: 'POST',
      });
      const payload = await safeJson(res);
      if (
        res.status === 201 &&
        payload != null &&
        typeof payload === 'object'
      ) {
        projectA2 = payload.id;
      }
    }

    // A project owned by B, used for every cross-user isolation probe.
    let projectB1;
    {
      const name = `bench-project-b1-${suffixB}`;
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        ...post({ name }),
        ...authHeaders(useTokenB),
        method: 'POST',
      });
      const payload = await safeJson(res);
      if (
        res.status === 201 &&
        payload != null &&
        typeof payload === 'object'
      ) {
        projectB1 = payload.id;
      }
    }

    // ---- Criterion 9 — GET /projects (A) → only A's own projects ---------
    {
      const res = await fetchImpl(joinUrl(baseUrl, '/projects'), {
        method: 'GET',
        ...authHeaders(useTokenA),
      });
      const payload = await safeJson(res);
      const isArray = Array.isArray(payload);
      const containsOwn =
        isArray &&
        [projectA1, projectA2].every(
          (id) => id === undefined || payload.some((p) => p?.id === id),
        );
      const leaksOther =
        isArray &&
        projectB1 !== undefined &&
        payload.some((p) => p?.id === projectB1);
      ledger.record(
        9,
        res.status === 200 && isArray && containsOwn && !leaksOther,
        `GET /projects (A) → HTTP ${res.status}; array=${isArray}; contains own=${containsOwn}; leaks B's project=${leaksOther}`,
      );
    }

    // ---- Criterion 10 — GET /projects/:id (hit + miss) --------------------
    {
      let hitOk = false;
      let evidence = 'no project id was created, so the read probe was skipped';
      if (projectA1 !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectA1))}`,
          ),
          { method: 'GET', ...authHeaders(useTokenA) },
        );
        const payload = await safeJson(res);
        hitOk =
          res.status === 200 &&
          payload != null &&
          typeof payload === 'object' &&
          payload.id === projectA1;
        evidence = `GET /projects/${projectA1} (own) → HTTP ${res.status}`;
      }
      const missRes = await fetchImpl(
        joinUrl(baseUrl, '/projects/00000000-nonexistent-id'),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      await collect(missRes);
      const missOk = missRes.status === 404;
      ledger.record(
        10,
        hitOk && missOk,
        `${evidence}; GET unknown project → HTTP ${missRes.status} (expected 404)`,
      );
    }

    // ---- Criterion 11 — GET /projects/:id owned by B, as A → 404 ---------
    {
      let evidence =
        'no B project was created, so the isolation read probe was skipped';
      let ok = false;
      if (projectB1 !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}`,
          ),
          { method: 'GET', ...authHeaders(useTokenA) },
        );
        await collect(res);
        ok = res.status === 404;
        evidence = `GET /projects/${projectB1} (owned by B) as A → HTTP ${res.status} (expected 404)`;
      }
      ledger.record(11, ok, evidence);
    }

    // ---- Criterion 14 — POST task (valid, A, projectA2) → 201 ------------
    let taskA1;
    if (projectA2 === undefined) {
      ledger.record(
        14,
        false,
        'no project id was created, so the task create probe was skipped',
      );
    } else {
      const title = `bench-task-a1-${suffixA}`;
      const res = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
        ),
        { ...post({ title }), ...authHeaders(useTokenA), method: 'POST' },
      );
      const payload = await collect(res);
      const hasShape =
        payload != null &&
        typeof payload === 'object' &&
        'id' in payload &&
        'title' in payload &&
        'projectId' in payload &&
        'createdAt' in payload &&
        payload.done === false;
      if (hasShape) taskA1 = payload.id;
      ledger.record(
        14,
        res.status === 201 && hasShape && payload?.title === title,
        `POST task (A) → HTTP ${res.status}; shape=${hasShape}; title match=${payload?.title === title}`,
      );
    }

    // ---- Criterion 15 — assigneeId (valid + unknown) -----------------------
    if (projectA2 === undefined) {
      ledger.record(15, false, 'no project id, skipped assigneeId probe');
    } else {
      let assignOk = false;
      let assignEvidence = 'userIdA not available';
      if (userIdA !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
          ),
          {
            ...post({
              title: `bench-assigned-${suffixA}`,
              assigneeId: userIdA,
            }),
            ...authHeaders(useTokenA),
            method: 'POST',
          },
        );
        const payload = await safeJson(res);
        assignOk =
          res.status === 201 &&
          payload != null &&
          typeof payload === 'object' &&
          payload.assigneeId !== undefined &&
          payload.assigneeId !== null;
        assignEvidence = `POST with valid assigneeId → HTTP ${res.status}; assigneeId present=${assignOk}`;
      }
      const badRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
        ),
        {
          ...post({
            title: `bench-bad-assign-${suffixA}`,
            assigneeId: '00000000-unknown-user',
          }),
          ...authHeaders(useTokenA),
          method: 'POST',
        },
      );
      await collect(badRes);
      const unknownOk = badRes.status === 400;
      ledger.record(
        15,
        assignOk && unknownOk,
        `${assignEvidence}; POST unknown assigneeId → HTTP ${badRes.status} (expected 400)`,
      );
    }

    // ---- Criterion 16 — missing/empty title → 400 -------------------------
    if (projectA2 === undefined) {
      ledger.record(16, false, 'no project id, skipped empty-title probe');
    } else {
      const res = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
        ),
        { ...post({ title: '' }), ...authHeaders(useTokenA), method: 'POST' },
      );
      await collect(res);
      ledger.record(
        16,
        res.status === 400,
        `POST task empty title → HTTP ${res.status} (expected 400)`,
      );
    }

    // ---- Criterion 17 — POST task against a project owned by B, as A → 404
    {
      let evidence =
        'no B project was created, so the isolation create probe was skipped';
      let ok = false;
      if (projectB1 !== undefined) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}/tasks`,
          ),
          {
            ...post({ title: `bench-cross-user-${suffixA}` }),
            ...authHeaders(useTokenA),
            method: 'POST',
          },
        );
        await collect(res);
        ok = res.status === 404;
        evidence = `POST task under B's project as A → HTTP ${res.status} (expected 404)`;
      }
      ledger.record(17, ok, evidence);
    }

    // A few more tasks under projectA2 to exercise pagination + filtering.
    const extraTaskIds = [];
    if (projectA2 !== undefined) {
      for (let i = 0; i < 3; i += 1) {
        const res = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
          ),
          {
            ...post({ title: `bench-task-extra-${suffixA}-${i}` }),
            ...authHeaders(useTokenA),
            method: 'POST',
          },
        );
        const payload = await safeJson(res);
        if (
          res.status === 201 &&
          payload != null &&
          typeof payload === 'object'
        ) {
          extraTaskIds.push(payload.id);
        }
      }
    }

    // ---- Criterion 18 — pagination shape -----------------------------------
    if (projectA2 === undefined) {
      ledger.record(18, false, 'no project id, skipped pagination probe');
    } else {
      const res = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks?page=1&pageSize=2`,
        ),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      const payload = await safeJson(res);
      const hasPaginatedShape =
        payload != null &&
        typeof payload === 'object' &&
        Array.isArray(payload.items) &&
        typeof payload.total === 'number' &&
        typeof payload.page === 'number' &&
        typeof payload.pageSize === 'number';
      const respectsPageSize =
        hasPaginatedShape &&
        payload.items.length <= 2 &&
        payload.pageSize === 2;
      ledger.record(
        18,
        res.status === 200 && hasPaginatedShape && respectsPageSize,
        `GET tasks?page=1&pageSize=2 → HTTP ${res.status}; paginatedShape=${hasPaginatedShape}; respectsPageSize=${respectsPageSize}`,
      );
    }

    // ---- Criterion 20 — PATCH task (execute before the filter probe) -----
    let patchedOk = false;
    if (projectA2 === undefined || taskA1 === undefined) {
      ledger.record(20, false, 'no task id, skipped PATCH probe');
    } else {
      const updatedTitle = `bench-patched-${suffixA}`;
      const res = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks/${encodeURIComponent(String(taskA1))}`,
        ),
        {
          method: 'PATCH',
          ...authHeaders(useTokenA),
          body: JSON.stringify({ title: updatedTitle, done: true }),
        },
      );
      const payload = await safeJson(res);
      patchedOk =
        res.status === 200 &&
        payload != null &&
        typeof payload === 'object' &&
        payload.title === updatedTitle &&
        payload.done === true;
      ledger.record(
        20,
        patchedOk,
        `PATCH task → HTTP ${res.status}; title updated=${payload?.title === updatedTitle}; done updated=${payload?.done === true}`,
      );
    }

    // ---- Criterion 19 — ?done filter ---------------------------------------
    if (projectA2 === undefined) {
      ledger.record(19, false, 'no project id, skipped done-filter probe');
    } else {
      const doneRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks?done=true`,
        ),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      const donePayload = await safeJson(doneRes);
      const doneItems = Array.isArray(donePayload?.items)
        ? donePayload.items
        : [];
      const allDone = doneItems.every((t) => t?.done === true);
      const includesPatched =
        !patchedOk ||
        taskA1 === undefined ||
        doneItems.some((t) => t?.id === taskA1);

      const notDoneRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks?done=false`,
        ),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      const notDonePayload = await safeJson(notDoneRes);
      const notDoneItems = Array.isArray(notDonePayload?.items)
        ? notDonePayload.items
        : [];
      const noneDone = notDoneItems.every((t) => t?.done === false);
      const excludesPatched =
        !patchedOk ||
        taskA1 === undefined ||
        !notDoneItems.some((t) => t?.id === taskA1);

      ledger.record(
        19,
        doneRes.status === 200 &&
          notDoneRes.status === 200 &&
          allDone &&
          noneDone &&
          includesPatched &&
          excludesPatched,
        `GET tasks?done=true → HTTP ${doneRes.status} (allDone=${allDone}, includesPatched=${includesPatched}); GET tasks?done=false → HTTP ${notDoneRes.status} (noneDone=${noneDone}, excludesPatched=${excludesPatched})`,
      );
    }

    // ---- Criterion 21 — DELETE task -----------------------------------------
    if (projectA2 === undefined || extraTaskIds[0] === undefined) {
      ledger.record(21, false, 'no extra task id, skipped DELETE task probe');
    } else {
      const targetTaskId = extraTaskIds[0];
      const delRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks/${encodeURIComponent(String(targetTaskId))}`,
        ),
        { method: 'DELETE', ...authHeaders(useTokenA) },
      );
      const listRes = await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA2))}/tasks`,
        ),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      const listPayload = await safeJson(listRes);
      const items = Array.isArray(listPayload?.items) ? listPayload.items : [];
      const stillPresent = items.some((t) => t?.id === targetTaskId);
      ledger.record(
        21,
        delRes.status === 204 && !stillPresent,
        `DELETE task → HTTP ${delRes.status} (expected 204); still in list=${stillPresent}`,
      );
    }

    // ---- Criterion 12 — DELETE /projects/:id + cascade ---------------------
    if (projectA1 === undefined) {
      ledger.record(12, false, 'no project id, skipped DELETE project probe');
    } else {
      // Give projectA1 a task first, so the cascade actually has something
      // to remove.
      await fetchImpl(
        joinUrl(
          baseUrl,
          `/projects/${encodeURIComponent(String(projectA1))}/tasks`,
        ),
        {
          ...post({ title: `bench-cascade-${suffixA}` }),
          ...authHeaders(useTokenA),
          method: 'POST',
        },
      );
      const delRes = await fetchImpl(
        joinUrl(baseUrl, `/projects/${encodeURIComponent(String(projectA1))}`),
        { method: 'DELETE', ...authHeaders(useTokenA) },
      );
      const afterRes = await fetchImpl(
        joinUrl(baseUrl, `/projects/${encodeURIComponent(String(projectA1))}`),
        { method: 'GET', ...authHeaders(useTokenA) },
      );
      await collect(afterRes);
      ledger.record(
        12,
        delRes.status === 204 && afterRes.status === 404,
        `DELETE /projects/${projectA1} → HTTP ${delRes.status} (expected 204); subsequent GET → HTTP ${afterRes.status} (expected 404)`,
      );
    }

    // ---- Criterion 13 — DELETE a project owned by B, as A → 404 -----------
    {
      let evidence =
        'no B project was created, so the isolation delete probe was skipped';
      let ok = false;
      if (projectB1 !== undefined) {
        const delRes = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}`,
          ),
          { method: 'DELETE', ...authHeaders(useTokenA) },
        );
        await collect(delRes);
        const stillThereRes = await fetchImpl(
          joinUrl(
            baseUrl,
            `/projects/${encodeURIComponent(String(projectB1))}`,
          ),
          { method: 'GET', ...authHeaders(useTokenB) },
        );
        const stillTherePayload = await safeJson(stillThereRes);
        const stillThere =
          stillThereRes.status === 200 &&
          stillTherePayload != null &&
          typeof stillTherePayload === 'object' &&
          stillTherePayload.id === projectB1;
        ok = delRes.status === 404 && stillThere;
        evidence = `DELETE B's project as A → HTTP ${delRes.status} (expected 404); still retrievable by B=${stillThere}`;
      }
      ledger.record(13, ok, evidence);
    }

    // ---- Criterion 22 — consistent error envelope --------------------------
    {
      const nonConforming = errorPayloads.filter(
        ({ payload }) => !isErrorEnvelope(payload),
      );
      ledger.record(
        22,
        errorPayloads.length > 0 && nonConforming.length === 0,
        `${errorPayloads.length} error response(s) observed; ${nonConforming.length} did not carry a top-level string "error" field`,
      );
    }

    // ---- Criterion 23 — persistence across restart -------------------------
    // The harness re-runs this oracle after restarting the app; here we
    // record a minimal in-process persistence signal (re-login still works)
    // for the standalone/unit-test face.
    {
      const res = await fetchImpl(
        joinUrl(baseUrl, '/auth/login'),
        post({ username: usernameA, password: passwordA }),
      );
      const payload = await safeJson(res);
      const loginOk =
        res.status === 200 &&
        payload != null &&
        typeof payload === 'object' &&
        typeof payload.token === 'string' &&
        payload.token.length > 0;
      ledger.record(
        23,
        loginOk,
        `Persistence check: re-login after all operations → HTTP ${res.status}; token present=${loginOk}`,
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

describe('epic-scope frozen acceptance oracle', { skip: !BASE_URL }, () => {
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
