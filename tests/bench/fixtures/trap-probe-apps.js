/**
 * trap-probe-apps.js — materializable fixture apps for the BEHAVIOURAL
 * trap-oracle discrimination tests (Story #156).
 *
 * The behavioural trap oracles under `bench/scenarios/*​/traps/*.js` boot the
 * delivered tree and drive it over HTTP, so their discrimination tests need a
 * real, runnable delivered tree — not injected fixtures. This module writes
 * one, as a single dependency-free `node:http` server whose behaviour is
 * switched by a `probe-config.json` sitting beside it. Each defect class gets
 * its own toggle, so a test materializes exactly the CLEAN and DEFECTIVE
 * variants the class discriminates on and leaves every other axis clean.
 *
 * The fixtures deliberately have no `package.json`: `withRunningApp` only runs
 * `npm install` for a workspace that has one, so these boot instantly and
 * offline. Tests pass a matching `app` launch block (`node server.js`).
 *
 * These are TEST fixtures. They are never overlaid into either benchmark arm's
 * sandbox and never scored — they exist only to prove the oracles discriminate.
 *
 * @module tests/bench/fixtures/trap-probe-apps
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The launch block a test hands the oracle in place of the scenario's own.
 * `readinessPath` is a route the fixture always answers (with 401 when
 * unauthenticated) — `pollReadiness` treats any resolved response as ready.
 */
export const EPIC_APP = Object.freeze({
  startCommand: 'node server.js',
  readinessPath: '/projects',
  portEnvVar: 'PORT',
});

/** Launch block for the story-scope fixture. */
export const STORY_APP = Object.freeze({
  startCommand: 'node server.js',
  readinessPath: '/me',
  portEnvVar: 'PORT',
});

const EPIC_SERVER_SOURCE = `import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(
  readFileSync(new URL('./probe-config.json', import.meta.url), 'utf8'),
);

const users = [];
const projects = [];
let tasks = [];
const sessions = new Map();
let nextId = 1;

function issueToken(userId) {
  if (cfg.verifyToken) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, userId);
    return token;
  }
  // Self-describing credential the server later just DECODES — no lookup, no
  // integrity check. The session-invalidation defect.
  return Buffer.from(JSON.stringify({ userId }), 'utf8').toString('base64url');
}

function principalOf(req) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.length === 0) return null;
  if (cfg.verifyToken) return sessions.get(token) ?? null;
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const userId = payload?.userId;
    return users.some((u) => u.id === userId) ? userId : null;
  } catch {
    return null;
  }
}

function send(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const seg = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
  if (body === null) return send(res, 400, { error: 'malformed json' });

  // ---- auth ------------------------------------------------------------
  if (method === 'POST' && seg[0] === 'auth' && seg[1] === 'register') {
    const { username, password } = body;
    if (typeof username !== 'string' || username.length === 0) {
      return send(res, 400, { error: 'username required' });
    }
    if (typeof password !== 'string' || password.length === 0) {
      return send(res, 400, { error: 'password required' });
    }
    if (users.some((u) => u.username === username)) {
      return send(res, 400, { error: 'duplicate' });
    }
    const user = { id: nextId++, username, password };
    users.push(user);
    return send(res, 201, { id: user.id, username: user.username });
  }
  if (method === 'POST' && seg[0] === 'auth' && seg[1] === 'login') {
    const user = users.find(
      (u) => u.username === body.username && u.password === body.password,
    );
    if (!user) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { token: issueToken(user.id) });
  }

  const principal = principalOf(req);
  if (principal === null) return send(res, 401, { error: 'unauthorized' });

  // ---- projects --------------------------------------------------------
  if (seg[0] === 'projects' && seg.length === 1) {
    if (method === 'GET') {
      return send(res, 200, projects.filter((p) => p.ownerId === principal));
    }
    if (method === 'POST') {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return send(res, 400, { error: 'name required' });
      }
      const project = {
        id: nextId++,
        name: body.name,
        ownerId: principal,
        createdAt: new Date().toISOString(),
      };
      projects.push(project);
      return send(res, 201, project);
    }
  }

  if (seg[0] === 'projects' && seg.length === 2) {
    const project = projects.find((p) => String(p.id) === seg[1]);
    // Ownership on the project routes is ALWAYS enforced — the frozen suite
    // samples exactly these, so a fixture that failed here would not isolate
    // the trapped surface.
    if (!project || project.ownerId !== principal) {
      return send(res, 404, { error: 'not found' });
    }
    if (method === 'GET') return send(res, 200, project);
    if (method === 'DELETE') {
      projects.splice(projects.indexOf(project), 1);
      if (cfg.cascade) {
        tasks = tasks.filter((t) => String(t.projectId) !== String(project.id));
      }
      return send(res, 204);
    }
  }

  // ---- tasks -----------------------------------------------------------
  if (seg[0] === 'projects' && seg[2] === 'tasks') {
    const projectId = seg[1];
    const project = projects.find((p) => String(p.id) === projectId);

    if (method === 'POST' && seg.length === 3) {
      // Creating a task in someone else's project IS sampled by the frozen
      // suite, so this check is always present.
      if (!project || project.ownerId !== principal) {
        return send(res, 404, { error: 'not found' });
      }
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        return send(res, 400, { error: 'title required' });
      }
      const task = {
        id: nextId++,
        title: body.title,
        projectId: project.id,
        assigneeId: body.assigneeId ?? null,
        createdAt: new Date().toISOString(),
        done: false,
      };
      tasks.push(task);
      return send(res, 201, task);
    }

    if (method === 'GET' && seg.length === 3) {
      if (cfg.scopeTaskRoutes && (!project || project.ownerId !== principal)) {
        return send(res, 404, { error: 'not found' });
      }
      if (!project) return send(res, 404, { error: 'not found' });
      const mine = tasks.filter((t) => String(t.projectId) === projectId);
      const filtered =
        url.searchParams.get('done') === null
          ? mine
          : mine.filter(
              (t) => String(t.done) === url.searchParams.get('done'),
            );
      let page = Number(url.searchParams.get('page') ?? 1);
      let pageSize = Number(url.searchParams.get('pageSize') ?? 10);
      if (cfg.boundPagination) {
        if (!Number.isInteger(page) || page < 1) {
          return send(res, 400, { error: 'page must be a positive integer' });
        }
        if (!Number.isInteger(pageSize) || pageSize < 1) {
          return send(res, 400, { error: 'pageSize must be a positive integer' });
        }
        pageSize = Math.min(pageSize, 100);
      }
      const start = (page - 1) * pageSize;
      return send(res, 200, {
        items: filtered.slice(start, start + pageSize),
        total: filtered.length,
        page,
        pageSize,
      });
    }

    if (seg.length === 4) {
      const taskId = seg[3];
      let task;
      if (cfg.scopeTaskRoutes) {
        if (!project || project.ownerId !== principal) {
          return send(res, 404, { error: 'not found' });
        }
        task = tasks.find(
          (t) => String(t.id) === taskId && String(t.projectId) === projectId,
        );
      } else {
        // The planted defect: the task is resolved by its id alone, with no
        // ownership filter and no check that it belongs to this project.
        task = tasks.find((t) => String(t.id) === taskId);
      }
      if (!task) return send(res, 404, { error: 'not found' });
      if (method === 'PATCH') {
        if (typeof body.title === 'string') task.title = body.title;
        if (typeof body.done === 'boolean') task.done = body.done;
        return send(res, 200, task);
      }
      if (method === 'DELETE') {
        tasks.splice(tasks.indexOf(task), 1);
        return send(res, 204);
      }
    }
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
`;

const STORY_SERVER_SOURCE = `import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(
  readFileSync(new URL('./probe-config.json', import.meta.url), 'utf8'),
);

const users = [];
const notes = [];
const sessions = new Map();
let nextId = 1;
let seq = 0;

function issueSession(userId) {
  // Strong: 32 CSPRNG bytes. Weak: a monotonic counter behind a constant
  // prefix — distinct, non-empty, and utterly predictable.
  const value = cfg.strongTokens
    ? crypto.randomBytes(32).toString('hex')
    : \`sess-\${++seq}\`;
  sessions.set(value, userId);
  return value;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const body =
    req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
  if (body === null) return send(res, 400, { error: 'malformed json' });

  if (req.method === 'POST' && url.pathname === '/signup') {
    const { username, password } = body;
    if (typeof username !== 'string' || username.length === 0) {
      return send(res, 400, { error: 'username required' });
    }
    if (typeof password !== 'string' || password.length === 0) {
      return send(res, 400, { error: 'password required' });
    }
    if (users.some((u) => u.username === username)) {
      return send(res, 400, { error: 'duplicate' });
    }
    const user = { id: nextId++, username, password };
    users.push(user);
    return send(res, 201, { id: user.id, username: user.username });
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    const user = users.find(
      (u) => u.username === body.username && u.password === body.password,
    );
    if (!user) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { session: issueSession(user.id) });
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const principal = sessions.get(token) ?? null;
  if (principal === null) return send(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && url.pathname === '/me') {
    const user = users.find((u) => u.id === principal);
    return send(res, 200, { id: user.id, username: user.username });
  }
  if (url.pathname === '/notes') {
    if (req.method === 'GET') {
      return send(res, 200, notes.filter((n) => n.ownerId === principal));
    }
    if (req.method === 'POST') {
      const note = {
        id: nextId++,
        title: body.title ?? '',
        body: body.body ?? '',
        ownerId: principal,
      };
      notes.push(note);
      return send(res, 201, note);
    }
  }
  return send(res, 404, { error: 'not found' });
});

server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
`;

/**
 * Every epic-scope defect toggle, all CLEAN. Tests flip exactly the one their
 * class discriminates on.
 *
 * - `scopeTaskRoutes` — task list/update/delete resolve the task inside an
 *   OWNED project (false ⇒ the `idor` defect: resolution by task id alone).
 * - `cascade` — deleting a project deletes its tasks (false ⇒ orphans).
 * - `boundPagination` — hostile `?page`/`?pageSize` rejected or clamped.
 * - `verifyToken` — credentials are opaque and looked up (false ⇒ the token
 *   is a self-describing blob the server merely decodes).
 */
export const CLEAN_EPIC_CONFIG = Object.freeze({
  scopeTaskRoutes: true,
  cascade: true,
  boundPagination: true,
  verifyToken: true,
});

/** Every story-scope defect toggle, all CLEAN. */
export const CLEAN_STORY_CONFIG = Object.freeze({ strongTokens: true });

/**
 * Materialize the epic-scope fixture app into `dir`.
 *
 * @param {string} dir — an existing (or creatable) directory.
 * @param {Partial<typeof CLEAN_EPIC_CONFIG>} [overrides]
 * @returns {string} the same directory, for chaining.
 */
export function writeEpicScopeApp(dir, overrides = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'server.js'), EPIC_SERVER_SOURCE, 'utf8');
  writeFileSync(
    path.join(dir, 'probe-config.json'),
    `${JSON.stringify({ ...CLEAN_EPIC_CONFIG, ...overrides }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

/**
 * Materialize the story-scope fixture app into `dir`.
 *
 * @param {string} dir
 * @param {Partial<typeof CLEAN_STORY_CONFIG>} [overrides]
 * @returns {string}
 */
export function writeStoryScopeApp(dir, overrides = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'server.js'), STORY_SERVER_SOURCE, 'utf8');
  writeFileSync(
    path.join(dir, 'probe-config.json'),
    `${JSON.stringify({ ...CLEAN_STORY_CONFIG, ...overrides }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

/**
 * A tree that exists but cannot boot — the UNMEASURED path every behavioural
 * oracle must report `null` for.
 *
 * @param {string} dir
 * @returns {string}
 */
export function writeUnbootableApp(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'server.js'),
    "throw new Error('this delivered tree does not boot');\n",
    'utf8',
  );
  return dir;
}
