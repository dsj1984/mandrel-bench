// bench/driver/app-runner.js
/**
 * Delivered-app runner for the Mandrel self-benchmark harness (Epic #2,
 * Story #2). Internal tooling only — never shipped in the distributed
 * `.agents/` bundle, never run against the live repo.
 *
 * The Quality dimension is scored by each scenario's FROZEN acceptance oracle
 * (`bench/scenarios/<id>/acceptance.test.js#evaluate`), which probes a RUNNING
 * instance of the delivered app over HTTP. Nothing else in the harness starts
 * that app — this module is that missing piece. Given a delivered workspace and
 * the scenario's `app` block, it:
 *
 *   1. picks a free TCP port (so concurrent/sequential runs never collide),
 *   2. runs `npm install` once when the workspace has no `node_modules` yet,
 *   3. spawns the app's start command with the chosen port injected via the
 *      scenario's `portEnvVar`,
 *   4. polls the readiness path until the server answers (or a bounded timeout),
 *   5. yields the live `baseUrl` to a caller-supplied function, and
 *   6. GUARANTEES the whole process tree is reaped in a `finally`, even when the
 *      app never came up or the callback threw.
 *
 * A never-ready app is NOT a fatal error: the runner still yields `baseUrl`, and
 * the frozen oracle's built-in transport-error path turns "no app" into a
 * fully-`unmet`, `quality=0` result rather than an exception. That keeps a
 * failed delivery scoreable instead of crashing the whole benchmark run.
 *
 * Every external effect (`spawn`, `spawnSync`, `net`, `fetch`, the readiness
 * sleep) is injectable so the unit tests exercise the full lifecycle — free
 * port, conditional install, readiness poll, transport-error tolerance, and the
 * guaranteed kill — without binding a real port or spawning a real server.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

/** Default ceiling for `npm install` in a delivered workspace. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Default ceiling for the app to answer its readiness path. */
export const DEFAULT_READINESS_TIMEOUT_MS = 30 * 1000;

/** Poll interval while waiting for readiness. */
export const DEFAULT_READINESS_INTERVAL_MS = 250;

/** Grace period between SIGTERM and SIGKILL when reaping the app. */
export const DEFAULT_KILL_GRACE_MS = 2000;

/**
 * Resolve a free TCP port by binding an ephemeral server to port 0, reading the
 * assigned port, then releasing it. There is a small TOCTOU window before the
 * app rebinds — acceptable for the harness's sequential runs.
 *
 * @param {object} [deps]
 * @param {() => import('node:net').Server} [deps.netFactory]  Injectable server factory.
 * @returns {Promise<number>}
 */
export function findFreePort(deps = {}) {
  const factory = deps.netFactory ?? (() => createServer());
  return new Promise((resolve, reject) => {
    const server = factory();
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close(() => {
        if (typeof port === 'number' && port > 0) resolve(port);
        else reject(new Error('[app-runner] could not resolve a free port'));
      });
    });
  });
}

/**
 * Sleep helper (injectable for tests so the readiness poll runs instantly).
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split a shell-ish start command into argv. Scenario start commands are simple
 * (`"npm start"`), so a whitespace split is sufficient and shell-injection free.
 *
 * @param {string} startCommand
 * @returns {{ cmd: string, args: string[] }}
 */
export function parseStartCommand(startCommand) {
  if (typeof startCommand !== 'string' || startCommand.trim().length === 0) {
    throw new TypeError('parseStartCommand requires a non-empty startCommand');
  }
  const parts = startCommand.trim().split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

/**
 * Poll `url` until a fetch resolves (the server is listening and answering) or
 * the timeout elapses. A resolved fetch of ANY status counts as ready — the
 * goal is "is the server up", not "is the route 200" (the frozen oracle judges
 * the response). Transport errors (connection refused while the app boots) are
 * swallowed and retried.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {number} [args.timeoutMs]
 * @param {number} [args.intervalMs]
 * @param {() => number} [args.now]            Injectable clock (ms).
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(ms: number) => Promise<void>} [args.sleepFn]
 * @returns {Promise<{ ready: boolean, attempts: number }>}
 */
export async function pollReadiness({
  url,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  intervalMs = DEFAULT_READINESS_INTERVAL_MS,
  now = () => Date.now(),
  fetchImpl = fetch,
  sleepFn = defaultSleep,
}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await fetchImpl(url, { method: 'GET' });
      return { ready: true, attempts };
    } catch {
      // Not up yet.
    }
    if (now() >= deadline) return { ready: false, attempts };
    await sleepFn(intervalMs);
  }
}

/**
 * Kill a spawned app process (and its group on POSIX) idempotently: SIGTERM,
 * then SIGKILL after a grace period if it is still alive. Resolves once the
 * child has exited (or was already gone).
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} [opts]
 * @param {number} [opts.graceMs]
 * @param {(ms: number) => Promise<void>} [opts.sleepFn]
 * @param {(pid: number, signal: string|number) => void} [opts.killFn]  Injectable `process.kill`.
 * @returns {Promise<void>}
 */
export async function killApp(child, opts = {}) {
  if (!child || typeof child.pid !== 'number') return;
  const graceMs = opts.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const killFn = opts.killFn ?? ((pid, sig) => process.kill(pid, sig));
  const onPosix = process.platform !== 'win32';
  // On POSIX the app was spawned `detached`, so it leads its own process group;
  // negating the pid signals the whole group (npm → node child included).
  const target = onPosix ? -child.pid : child.pid;

  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));

  try {
    killFn(target, 'SIGTERM');
  } catch {
    // Already gone.
  }

  let settled = false;
  await Promise.race([
    exited.then(() => {
      settled = true;
    }),
    sleepFn(graceMs),
  ]);

  if (!settled && child.exitCode === null && child.signalCode === null) {
    try {
      killFn(target, 'SIGKILL');
    } catch {
      // Already gone.
    }
    await exited;
  }
}

/**
 * Bring up a delivered app, yield its base URL to `fn`, and guarantee teardown.
 *
 * @param {object} opts
 * @param {string} opts.workspacePath  Absolute path of the delivered workspace.
 * @param {{ startCommand: string, readinessPath: string, defaultPort?: number, portEnvVar: string }} opts.app
 *   The scenario's `app` block.
 * @param {number} [opts.installTimeoutMs]
 * @param {number} [opts.readinessTimeoutMs]
 * @param {number} [opts.readinessIntervalMs]
 * @param {object} [deps]
 * @param {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} [deps.spawnFn]
 * @param {(cmd: string, args: string[], opts: object) => { status: number|null }} [deps.spawnSyncFn]
 * @param {() => import('node:net').Server} [deps.netFactory]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(ms: number) => Promise<void>} [deps.sleepFn]
 * @param {(p: string) => boolean} [deps.existsFn]
 * @param {(pid: number, signal: string|number) => void} [deps.killFn]
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @template T
 * @param {(baseUrl: string, info: { ready: boolean, port: number, restart: () => Promise<{ ready: boolean, port: number, baseUrl: string }> }) => Promise<T> | T} fn
 *   `info.restart` genuinely reaps and respawns the app on the same port
 *   (Ticket #122, item 5), so an oracle can test real persistence across a
 *   restart.
 * @returns {Promise<T>}
 */
export async function withRunningApp(opts, fn, deps = {}) {
  const {
    workspacePath,
    app,
    installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    readinessIntervalMs = DEFAULT_READINESS_INTERVAL_MS,
  } = opts ?? {};

  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError('withRunningApp requires a non-empty workspacePath');
  }
  if (
    !app ||
    typeof app.startCommand !== 'string' ||
    typeof app.portEnvVar !== 'string'
  ) {
    throw new TypeError(
      'withRunningApp requires app.startCommand and app.portEnvVar',
    );
  }
  if (typeof fn !== 'function') {
    throw new TypeError('withRunningApp requires a callback fn');
  }

  const spawnImpl = deps.spawnFn ?? spawn;
  const spawnSyncImpl = deps.spawnSyncFn ?? spawnSync;
  const exists = deps.existsFn ?? existsSync;
  const logger = deps.logger;

  const port = await findFreePort({ netFactory: deps.netFactory });
  const readinessPath = app.readinessPath ?? '/';
  const baseUrl = `http://127.0.0.1:${port}`;

  // Conditional install: only when the workspace has a package.json but no
  // node_modules yet (the control arm builds from scratch; the mandrel arm
  // already has node_modules overlaid).
  const hasPackageJson = exists(path.join(workspacePath, 'package.json'));
  const hasNodeModules = exists(path.join(workspacePath, 'node_modules'));
  if (hasPackageJson && !hasNodeModules) {
    logger?.info?.(`[app-runner] npm install in ${workspacePath}`);
    const inst = spawnSyncImpl('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: installTimeoutMs,
      stdio: 'pipe',
    });
    if (inst && inst.status !== 0) {
      logger?.warn?.(
        `[app-runner] npm install exited ${inst?.status} (continuing; the oracle will record the failure)`,
      );
    }
  }

  const { cmd, args } = parseStartCommand(app.startCommand);

  // Capture output for diagnostics (best-effort; streams may be absent in fakes).
  const out = [];

  // Spawn a fresh app process on the SAME port (env-injected). Factored out so a
  // restart (below) can respawn identically. `detached` on POSIX makes the child
  // lead its own process group so killApp reaps the whole npm→node tree.
  const spawnChild = () => {
    const c = spawnImpl(cmd, args, {
      cwd: workspacePath,
      env: { ...process.env, [app.portEnvVar]: String(port) },
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
    c.stdout?.on?.('data', (d) => out.push(String(d)));
    c.stderr?.on?.('data', (d) => out.push(String(d)));
    return c;
  };

  logger?.info?.(
    `[app-runner] starting "${app.startCommand}" on ${app.portEnvVar}=${port}`,
  );
  let child = spawnChild();

  // Restart hook (Ticket #122, item 5): the app-runner OWNS the process, so it
  // can genuinely restart it — reap the current child, respawn on the SAME port,
  // and re-poll readiness. The scenario oracle uses this to test PERSISTENCE
  // (data must survive a real restart): an in-memory store loses its state on
  // restart and fails the persistence criterion, while an on-disk store passes.
  // Yielded to the oracle callback so it can drive a real restart mid-probe.
  const restart = async () => {
    logger?.info?.('[app-runner] restarting app (persistence probe)…');
    await killApp(child, { sleepFn: deps.sleepFn, killFn: deps.killFn });
    child = spawnChild();
    const { ready } = await pollReadiness({
      url: baseUrl + readinessPath,
      timeoutMs: readinessTimeoutMs,
      intervalMs: readinessIntervalMs,
      fetchImpl: deps.fetchImpl,
      sleepFn: deps.sleepFn,
    });
    logger?.info?.(`[app-runner] app restarted (ready=${ready})`);
    return { ready, port, baseUrl };
  };

  try {
    const { ready, attempts } = await pollReadiness({
      url: baseUrl + readinessPath,
      timeoutMs: readinessTimeoutMs,
      intervalMs: readinessIntervalMs,
      fetchImpl: deps.fetchImpl,
      sleepFn: deps.sleepFn,
    });
    if (!ready) {
      logger?.warn?.(
        `[app-runner] app not ready after ${attempts} attempts; probing anyway. ` +
          `Last output: ${out.join('').slice(-500)}`,
      );
    } else {
      logger?.info?.(`[app-runner] app ready at ${baseUrl}${readinessPath}`);
    }
    return await fn(baseUrl, { ready, port, restart });
  } finally {
    await killApp(child, { sleepFn: deps.sleepFn, killFn: deps.killFn });
    logger?.info?.('[app-runner] app reaped');
  }
}
