import { requireAuth } from '../lib/auth/middleware.js';
import { sendError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { sendJson } from '../router.js';
import { createPaymentSchema } from '../schemas/payment.schema.js';
import { listPayments, recordPayment } from '../services/payments.service.js';

export function registerPaymentRoutes(router) {
  router.add('POST', '/orders/:orderId/payments', requireAuth, (req, res) => {
    const problems = validate(req.body, createPaymentSchema);
    if (problems.length > 0) {
      sendError(res, 422, 'E_VALIDATION', 'invalid request body', problems);
      return;
    }
    sendJson(res, 201, recordPayment(req.params.orderId, req.body));
  });

  router.add('GET', '/orders/:orderId/payments', requireAuth, (req, res) => {
    sendJson(res, 200, listPayments(req.params.orderId));
  });
}
