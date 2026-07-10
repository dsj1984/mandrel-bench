/**
 * FROZEN touch-2 acceptance oracle — `epic-scope` scenario's second touch
 * (Epic #86, Story #96).
 *
 * The frozen behavioural spine for the epic-scope CHANGE REQUEST (the "project
 * sharing with role-based access" second touch). Like the touch-1 frozen suite
 * (`./acceptance.test.js`) it is **frozen**: it drives only the delivered app's
 * user-visible HTTP contract and imports nothing from the delivered source — it
 * has no knowledge of the app's storage engine, token-signing mechanism, or
 * ownership-check implementation.
 *
 * Role-based access is a BEHAVIOURAL property: whether a viewer is actually
 * denied a write and an editor actually allowed one is asserted HERE, over the
 * live HTTP boundary, not by a source scan. The source-scan face of the
 * touch-2 axis for this rung (per-user isolation preservation) lives separately
 * under `../traps-touch2/regression-isolation.js`.
 *
 * Two faces, mirroring the touch-1 oracle: a pure {@link evaluate} the harness
 * calls directly, and a skip-unless-`BENCH_APP_BASE_URL` `node --test` case for
 * standalone runs against a live app.
 *
 * @module bench/scenarios/epic-scope/acceptance.touch2.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Stable scenario identifier this oracle scores. */
export const SCENARIO_ID = 'epic-scope';

/**
 * Frozen touch-2 acceptance criteria, in change-request order.
 *
 * @type {ReadonlyArray<string>}
 */
export const CRITERIA = Object.freeze([
  "POST /projects/:id/shares by the project's owner shares it with another user as a viewer and returns 201",
  'A user a project is shared with as a viewer can GET the project (200) and list its tasks (200)',
  'A viewer may NOT create a task on the shared project — POST /projects/:id/tasks is rejected with a non-2xx status',
  'A user a project is shared with as an editor may create a task on the shared project — POST /projects/:id/tasks returns 201',
  'A user with no relationship to the project still gets 404 for it, exactly as before',
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
 * Criterion ledger, keeping verdicts in change-request order.
 */
class CriteriaLedger {
  constructor() {
    /** @type {Map<number, { index: number, criterion: string, met: boolean, evidence: string }>} */
    this.byIndex = new Map();
  }

  record(index, met, evidence) {
    this.byIndex.set(index, {
      index,
      criterion: CRITERIA[index],
      met: Boolean(met),
      evidence,
    });
  }

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
 * Run the frozen project-sharing + role-based-access oracle against a running
 * app instance. Registers four fresh users (owner, viewer, editor, stranger),
 * has the owner create and share a project, and asserts the five role-based
 * behaviours over HTTP. Never throws on an assertion failure: a failed or
 * unreachable endpoint becomes a `met: false` criterion with concrete evidence.
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
  const jsonHeaders = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const json = (body) => ({ headers: jsonHeaders, body: JSON.stringify(body) });
  const authHeaders = (token) => ({
    headers: { ...jsonHeaders, authorization: `Bearer ${token}` },
  });
  const registerUrl = joinUrl(baseUrl, '/auth/register');
  const loginUrl = joinUrl(baseUrl, '/auth/login');
  const projectsUrl = joinUrl(baseUrl, '/projects');

  /**
   * Register + log in a fresh user, returning `{ id, token }` or null on any
   * failure.
   */
  async function makeUser(tag) {
    const suffix = uniqueSuffix();
    const username = `bench-t2-${tag}-${suffix}`;
    const password = `pw-${tag}-${suffix}`;
    const regRes = await fetchImpl(registerUrl, {
      ...json({ username, password }),
      method: 'POST',
    });
    const regPayload = await safeJson(regRes);
    const id =
      regPayload && typeof regPayload === 'object' ? regPayload.id : undefined;
    const loginRes = await fetchImpl(loginUrl, {
      ...json({ username, password }),
      method: 'POST',
    });
    const loginPayload = await safeJson(loginRes);
    const token =
      loginPayload && typeof loginPayload === 'object'
        ? loginPayload.token
        : undefined;
    if (
      regRes.status !== 201 ||
      id == null ||
      loginRes.status !== 200 ||
      !token
    ) {
      return null;
    }
    return { id, token };
  }

  try {
    const owner = await makeUser('owner');
    const viewer = await makeUser('viewer');
    const editor = await makeUser('editor');
    const stranger = await makeUser('stranger');

    if (!owner || !viewer || !editor || !stranger) {
      const reason =
        'precondition failed: could not register/log in the four test users (auth contract not met)';
      const criteria = ledger.finalize(reason);
      return { scenario: SCENARIO_ID, passed: false, criteria };
    }

    // Owner creates a project.
    const projRes = await fetchImpl(projectsUrl, {
      ...authHeaders(owner.token),
      body: JSON.stringify({ name: `t2-project-${Date.now()}` }),
      method: 'POST',
    });
    const projPayload = await safeJson(projRes);
    const projectId =
      projPayload && typeof projPayload === 'object'
        ? projPayload.id
        : undefined;
    if (projRes.status !== 201 || projectId == null) {
      const reason = `precondition failed: owner could not create a project (POST /projects → ${projRes.status})`;
      const criteria = ledger.finalize(reason);
      return { scenario: SCENARIO_ID, passed: false, criteria };
    }

    const sharesUrl = joinUrl(baseUrl, `/projects/${projectId}/shares`);
    const projectUrl = joinUrl(baseUrl, `/projects/${projectId}`);
    const tasksUrl = joinUrl(baseUrl, `/projects/${projectId}/tasks`);

    // --- Criterion 0 — owner shares the project with the viewer ---------
    {
      const res = await fetchImpl(sharesUrl, {
        ...authHeaders(owner.token),
        body: JSON.stringify({ userId: viewer.id, role: 'viewer' }),
        method: 'POST',
      });
      ledger.record(
        0,
        res.status === 201,
        `POST /projects/:id/shares (owner→viewer) → ${res.status} (want 201)`,
      );
    }

    // --- Criterion 1 — the viewer can read the project + its tasks ------
    {
      const projGet = await fetchImpl(projectUrl, {
        ...authHeaders(viewer.token),
      });
      const tasksGet = await fetchImpl(tasksUrl, {
        ...authHeaders(viewer.token),
      });
      ledger.record(
        1,
        projGet.status === 200 && tasksGet.status === 200,
        `viewer GET /projects/:id → ${projGet.status}, GET tasks → ${tasksGet.status} (want 200/200)`,
      );
    }

    // --- Criterion 2 — the viewer may NOT write a task ------------------
    {
      const res = await fetchImpl(tasksUrl, {
        ...authHeaders(viewer.token),
        body: JSON.stringify({ title: 'viewer-should-not-create' }),
        method: 'POST',
      });
      // Any non-2xx status is a pass: the write is denied. A 2xx means the
      // viewer role was not enforced.
      const denied = res.status >= 400;
      ledger.record(
        2,
        denied,
        `viewer POST /projects/:id/tasks → ${res.status} (want a non-2xx denial)`,
      );
    }

    // --- Criterion 3 — an editor MAY write a task -----------------------
    {
      const shareRes = await fetchImpl(sharesUrl, {
        ...authHeaders(owner.token),
        body: JSON.stringify({ userId: editor.id, role: 'editor' }),
        method: 'POST',
      });
      const createRes = await fetchImpl(tasksUrl, {
        ...authHeaders(editor.token),
        body: JSON.stringify({ title: 'editor-created-task' }),
        method: 'POST',
      });
      ledger.record(
        3,
        shareRes.status === 201 && createRes.status === 201,
        `share owner→editor → ${shareRes.status}, editor POST task → ${createRes.status} (want 201/201)`,
      );
    }

    // --- Criterion 4 — a stranger still gets 404 ------------------------
    {
      const res = await fetchImpl(projectUrl, {
        ...authHeaders(stranger.token),
      });
      ledger.record(
        4,
        res.status === 404,
        `stranger GET /projects/:id → ${res.status} (want 404 — no relationship)`,
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

describe('epic-scope frozen touch-2 acceptance oracle', {
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
