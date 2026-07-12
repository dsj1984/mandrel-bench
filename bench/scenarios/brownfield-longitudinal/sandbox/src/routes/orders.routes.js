import { requireAuth } from '../lib/auth/middleware.js';
import { sendError } from '../lib/errors.js';
import { parsePagination } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import { sendJson } from '../router.js';
import { createOrderSchema } from '../schemas/order.schema.js';
import {
  createOrder,
  getOrderDetail,
  issueOrder,
  listOrdersPage,
  voidOrder,
} from '../services/orders.service.js';

export function registerOrderRoutes(router) {
  router.add('POST', '/orders', requireAuth, (req, res) => {
    const problems = validate(req.body, createOrderSchema);
    if (problems.length > 0) {
      sendError(res, 422, 'E_VALIDATION', 'invalid request body', problems);
      return;
    }
    sendJson(res, 201, createOrder(req.body, req.user.id));
  });

  router.add('GET', '/orders', requireAuth, (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    sendJson(
      res,
      200,
      listOrdersPage({
        status: req.query.status,
        customerId: req.query.customerId,
        page,
        pageSize,
        offset,
      }),
    );
  });

  router.add('GET', '/orders/:orderId', requireAuth, (req, res) => {
    sendJson(res, 200, getOrderDetail(req.params.orderId));
  });

  router.add('POST', '/orders/:orderId/issue', requireAuth, (req, res) => {
    sendJson(res, 200, issueOrder(req.params.orderId));
  });

  router.add('POST', '/orders/:orderId/void', requireAuth, (req, res) => {
    sendJson(res, 200, voidOrder(req.params.orderId));
  });
}
