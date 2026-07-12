import { requireAuth, requireRole } from '../lib/auth/middleware.js';
import { sendJson } from '../router.js';
import { receivablesReport } from '../services/reports.service.js';

export function registerReportRoutes(router) {
  router.add(
    'GET',
    '/reports/receivables',
    requireAuth,
    requireRole('admin'),
    (req, res) => {
      sendJson(res, 200, receivablesReport());
    },
  );
}
