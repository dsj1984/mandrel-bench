import { ApiError, sendError } from './lib/errors.js';
import { logger } from './lib/logger.js';

const MAX_BODY_BYTES = 1024 * 1024;
const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT']);

export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'E_PAYLOAD_TOO_LARGE', 'request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function matchRoute(routes, method, segments) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const expected = route.segments[i];
      if (expected.startsWith(':')) {
        params[expected.slice(1)] = decodeURIComponent(segments[i]);
      } else if (expected !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, ...handlers) {
    routes.push({
      method,
      segments: pattern.split('/').filter(Boolean),
      handlers,
    });
  }

  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    try {
      const found = matchRoute(routes, req.method, segments);
      if (!found) {
        sendError(res, 404, 'E_NOT_FOUND', 'no such route');
        return;
      }
      req.params = found.params;
      req.query = Object.fromEntries(url.searchParams);
      if (BODY_METHODS.has(req.method)) {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            req.body = JSON.parse(raw);
          } catch {
            sendError(res, 400, 'E_MALFORMED_JSON', 'request body is not valid JSON');
            return;
          }
        } else {
          req.body = {};
        }
      }
      for (const handler of found.route.handlers) {
        await handler(req, res);
        if (res.writableEnded) return;
      }
      if (!res.writableEnded) {
        throw new Error(`route ${req.method} ${url.pathname} sent no response`);
      }
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof ApiError) {
        sendError(res, err.status, err.code, err.message, err.details);
        return;
      }
      logger.error('unhandled request error', {
        method: req.method,
        path: url.pathname,
        error: err?.message ?? String(err),
      });
      sendError(res, 500, 'E_INTERNAL', 'internal server error');
    }
  }

  return { add, dispatch };
}
