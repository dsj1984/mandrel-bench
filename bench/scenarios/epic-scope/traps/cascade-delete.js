/**
 * cascade-delete.js — BEHAVIOURAL trap-oracle for the `epic-scope` scenario's
 * `cascade-delete` defect class (Story #156).
 *
 * ## Why this class exists
 *
 * One of the JUDGMENT-GRADIENT classes that replaced the entailed
 * input-validation trap (whose positive signal the frozen suite already
 * required, making it non-differential by construction). The seed prompt states the cascade as a
 * capability ("deleting a project also removes the tasks in it") and the
 * frozen suite (`../acceptance.test.js`, criterion 10) samples exactly one
 * consequence of it: after `DELETE /projects/:id`, a subsequent `GET` of that
 * project no longer returns it. What the frozen suite never asks is whether
 * the TASKS actually went away, or merely became unreachable through the one
 * route it checked.
 *
 * A delete that removes the project row and leaves its task rows behind is
 * the classic shortcut: it passes every project-shaped probe, and the orphans
 * only surface through a route that resolves a task by id under a DIFFERENT
 * project — which is precisely where an unscoped lookup will happily find
 * them again.
 *
 * ## Decision rule
 *
 * Owner A creates two projects, puts a task in the first, deletes the first,
 * then the probe checks the orphan is genuinely gone:
 *
 *   1. the orphaned task must not be readable/mutable through the SURVIVING
 *      project's task route (`PATCH /projects/:survivor/tasks/:orphanId`);
 *   2. the surviving project's task list must not contain the orphan;
 *   3. the orphaned task must not still be mutable through its own (now
 *      deleted) project's route;
 *   4. a freshly created project must start empty — an orphan resurfacing in
 *      a new project means task rows outlived their parent.
 *
 * Any 2xx on (1) or (3), or the orphan appearing in (2) or (4), is the
 * planted defect. A tree that never boots, or whose delete never succeeds,
 * reports `null` (unmeasured).
 *
 * @module bench/scenarios/epic-scope/traps/cascade-delete
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
 * Extract the task array from a paged task-list response, tolerating either
 * the paged envelope or a bare array.
 *
 * @param {unknown} body
 * @returns {unknown[]|null}
 */
export function taskItemsOf(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object' && Array.isArray(body.items)) {
    return body.items;
  }
  return null;
}

/**
 * Drive the orphaned-task probe against a running delivered app.
 *
 * @param {{ request: Function }} client
 * @returns {Promise<object>} a trap verdict.
 */
export async function cascadeDeleteProbe(client) {
  const owner = await authenticate(client, AUTH_ROUTES);

  const createProject = async (name) => {
    const res = await client.request('/projects', {
      method: 'POST',
      token: owner.token,
      body: { name },
    });
    return isSuccess(res.status) ? (res.body?.id ?? null) : null;
  };

  const doomedId = await createProject('cascade-probe doomed');
  const survivorId = await createProject('cascade-probe survivor');
  if (doomedId === null || survivorId === null) {
    return unmeasured(
      'the owner could not create the two projects the cascade probe needs',
    );
  }

  const doomedTasks = `/projects/${encodeURIComponent(String(doomedId))}/tasks`;
  const survivorTasks = `/projects/${encodeURIComponent(String(survivorId))}/tasks`;

  const task = await client.request(doomedTasks, {
    method: 'POST',
    token: owner.token,
    body: { title: 'cascade-probe orphan' },
  });
  const orphanId = task.body?.id;
  if (!isSuccess(task.status) || orphanId === undefined) {
    return unmeasured(
      `the owner could not create the task the cascade probe deletes (POST ${doomedTasks} → HTTP ${task.status})`,
    );
  }

  const deleted = await client.request(
    `/projects/${encodeURIComponent(String(doomedId))}`,
    { method: 'DELETE', token: owner.token },
  );
  if (!isSuccess(deleted.status)) {
    return unmeasured(
      `the project delete did not succeed (DELETE /projects/:id → HTTP ${deleted.status}), so there is no cascade to observe`,
    );
  }

  const orphanRef = encodeURIComponent(String(orphanId));
  const reasons = [];

  const viaSurvivor = await client.request(`${survivorTasks}/${orphanRef}`, {
    method: 'PATCH',
    token: owner.token,
    body: { done: true },
  });
  if (isSuccess(viaSurvivor.status)) {
    reasons.push(
      `PATCH /projects/:survivorId/tasks/:orphanId → HTTP ${viaSurvivor.status} (the task of a deleted project is still resolvable — and mutable — under a different project)`,
    );
  }

  const survivorList = await client.request(survivorTasks, {
    token: owner.token,
  });
  const survivorItems = taskItemsOf(survivorList.body);
  if (
    Array.isArray(survivorItems) &&
    survivorItems.some((t) => String(t?.id) === String(orphanId))
  ) {
    reasons.push(
      "the orphaned task appears in the surviving project's task list",
    );
  }

  const viaDoomed = await client.request(`${doomedTasks}/${orphanRef}`, {
    method: 'PATCH',
    token: owner.token,
    body: { done: true },
  });
  if (isSuccess(viaDoomed.status)) {
    reasons.push(
      `PATCH /projects/:deletedProjectId/tasks/:orphanId → HTTP ${viaDoomed.status} (the task outlived the project that owned it)`,
    );
  }

  const freshId = await createProject('cascade-probe fresh');
  if (freshId !== null) {
    const freshList = await client.request(
      `/projects/${encodeURIComponent(String(freshId))}/tasks`,
      { token: owner.token },
    );
    const freshItems = taskItemsOf(freshList.body);
    if (Array.isArray(freshItems) && freshItems.length > 0) {
      reasons.push(
        `a freshly created project already contains ${freshItems.length} task(s) — task rows outlived their parent project`,
      );
    }
  }

  if (reasons.length > 0) {
    return measured({
      defectPresent: true,
      evidence: [
        'planted defect DETECTED behaviourally: deleting a project left its tasks reachable on surfaces the frozen suite does not assert',
        ...reasons,
      ],
    });
  }
  return measured({
    defectPresent: false,
    evidence: [
      "clean: the deleted project's task was unreachable through the surviving project's route, absent from every task list, and no longer mutable through its own route",
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
  return probeDeliveredApp(deliveredTreePath, cascadeDeleteProbe, {
    scenarioDir: SCENARIO_DIR,
    ...ports,
  });
}
