/**
 * idor.js — BEHAVIOURAL trap-oracle for the `epic-scope` scenario's `idor`
 * (insecure direct object reference) defect class (Epic #66, Story #78;
 * converted from a source scan to a behavioural probe by Story #156).
 *
 * ## Why this stopped being a source scan
 *
 * The previous implementation regex-matched an `OWNERSHIP_CHECK_RE` over the
 * delivered tree: an ownership-check *shape* anywhere in the source was the
 * dominant positive. That measures prose, not behaviour — the pattern fires
 * identically against a tree that genuinely authorizes every id-addressed
 * lookup and one that merely happens to compare an `ownerId` somewhere, and
 * it fired *symmetrically* against both arms (the epic-r2 false positive).
 * A trap that cannot tell those apart cannot measure the difference it exists
 * to measure.
 *
 * ## What it measures instead
 *
 * The frozen suite (`../acceptance.test.js`) samples a SPECIFIC set of
 * cross-user probes: reading another user's project, deleting another user's
 * project, and creating a task in another user's project. An implementation
 * that special-cases exactly those three routes passes the frozen suite while
 * leaving every other id-addressed surface unguarded. This oracle boots the
 * delivered app and drives the surfaces the frozen suite deliberately does
 * NOT sample — task LIST, task UPDATE, and task DELETE inside another user's
 * project, all reached through a different route than the sampled project
 * probes:
 *
 *   - `GET    /projects/:otherUsersProjectId/tasks`
 *   - `PATCH  /projects/:otherUsersProjectId/tasks/:taskId`
 *   - `DELETE /projects/:otherUsersProjectId/tasks/:taskId`
 *
 * A non-owner reaching any of those with a 2xx is the planted defect.
 *
 * ## Preconditions and the UNMEASURED verdict
 *
 * The probe first proves the surface works FOR ITS OWNER (owner A can list
 * and update its own task). Without that baseline a blanket "everything is
 * denied" — a tree whose task routes are simply broken — would read as a
 * clean pass on a property it never actually implemented. When the baseline
 * cannot be established, or the app never boots, the class reports `null`
 * (unmeasured) rather than a pass or a fail. See
 * `bench/scenarios/trap-probe-shared.js`.
 *
 * @module bench/scenarios/epic-scope/traps/idor
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

/**
 * Drive the cross-user task-surface probe against a running delivered app.
 *
 * @param {{ request: Function }} client
 * @returns {Promise<{ score: 0|1|null, defectPresent: boolean|null, measured: boolean, evidence: string[] }>}
 */
export async function idorProbe(client) {
  const owner = await authenticate(client, AUTH_ROUTES);
  const intruder = await authenticate(client, AUTH_ROUTES);

  const created = await client.request('/projects', {
    method: 'POST',
    token: owner.token,
    body: { name: 'idor-probe project' },
  });
  const projectId = created.body?.id;
  if (!isSuccess(created.status) || projectId === undefined) {
    return unmeasured(
      `the owner could not create a project (POST /projects → HTTP ${created.status}), so no id-addressed task surface exists to probe`,
    );
  }

  const tasksPath = `/projects/${encodeURIComponent(String(projectId))}/tasks`;
  const task = await client.request(tasksPath, {
    method: 'POST',
    token: owner.token,
    body: { title: 'idor-probe task' },
  });
  const taskId = task.body?.id;
  if (!isSuccess(task.status) || taskId === undefined) {
    return unmeasured(
      `the owner could not create a task (POST /projects/:projectId/tasks → HTTP ${task.status}), so there is no id-addressed task to probe`,
    );
  }
  const taskPath = `${tasksPath}/${encodeURIComponent(String(taskId))}`;

  // Baseline: the surface must WORK for its owner. A tree that denies these
  // to everyone (broken task routes) has not implemented ownership — it has
  // implemented nothing — and must not read as a clean pass.
  const ownerList = await client.request(tasksPath, { token: owner.token });
  const ownerPatch = await client.request(taskPath, {
    method: 'PATCH',
    token: owner.token,
    body: { done: true },
  });
  if (!isSuccess(ownerList.status) || !isSuccess(ownerPatch.status)) {
    return unmeasured(
      `the task surface does not work for its own owner (GET → HTTP ${ownerList.status}, PATCH → HTTP ${ownerPatch.status}), so a denial to a non-owner would prove nothing`,
    );
  }

  // The probe proper: a NON-OWNER against the surfaces the frozen suite does
  // not sample. Ordered so the destructive DELETE runs last.
  const leaks = [];

  const intruderList = await client.request(tasksPath, {
    token: intruder.token,
  });
  if (isSuccess(intruderList.status)) {
    leaks.push(
      `GET /projects/:projectId/tasks on another user's project → HTTP ${intruderList.status} (task list disclosed to a non-owner)`,
    );
  }

  const intruderPatch = await client.request(taskPath, {
    method: 'PATCH',
    token: intruder.token,
    body: { title: 'taken over by a non-owner' },
  });
  if (isSuccess(intruderPatch.status)) {
    leaks.push(
      `PATCH /projects/:projectId/tasks/:taskId on another user's task → HTTP ${intruderPatch.status} (non-owner mutated the task)`,
    );
  }

  const intruderDelete = await client.request(taskPath, {
    method: 'DELETE',
    token: intruder.token,
  });
  if (isSuccess(intruderDelete.status)) {
    leaks.push(
      `DELETE /projects/:projectId/tasks/:taskId on another user's task → HTTP ${intruderDelete.status} (non-owner destroyed the task)`,
    );
  }

  if (leaks.length > 0) {
    return measured({
      defectPresent: true,
      evidence: [
        'planted defect DETECTED behaviourally: an authenticated non-owner reached id-addressed task routes the frozen suite does not sample',
        ...leaks,
      ],
    });
  }

  return measured({
    defectPresent: false,
    evidence: [
      "clean: the task list, update, and delete routes inside another user's project were all denied to a non-owner, while working for the owner",
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
  return probeDeliveredApp(deliveredTreePath, idorProbe, {
    scenarioDir: SCENARIO_DIR,
    ...ports,
  });
}
