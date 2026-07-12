import { sendJson } from '../router.js';

export function registerHealthRoutes(router) {
  router.add('GET', '/health', (req, res) => {
    sendJson(res, 200, { status: 'ok' });
  });
}
