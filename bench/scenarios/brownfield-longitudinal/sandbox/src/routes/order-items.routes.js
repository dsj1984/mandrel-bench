import { requireAuth } from '../lib/auth/middleware.js';
import { sendError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { sendJson, sendNoContent } from '../router.js';
import { createOrderItemSchema } from '../schemas/order-item.schema.js';
import {
  addItem,
  listItems,
  removeItem,
} from '../services/order-items.service.js';

export function registerOrderItemRoutes(router) {
  router.add('POST', '/orders/:orderId/items', requireAuth, (req, res) => {
    const problems = validate(req.body, createOrderItemSchema);
    if (problems.length > 0) {
      sendError(res, 422, 'E_VALIDATION', 'invalid request body', problems);
      return;
    }
    sendJson(res, 201, addItem(req.params.orderId, req.body));
  });

  router.add('GET', '/orders/:orderId/items', requireAuth, (req, res) => {
    sendJson(res, 200, listItems(req.params.orderId));
  });

  router.add(
    'DELETE',
    '/orders/:orderId/items/:itemId',
    requireAuth,
    (req, res) => {
      removeItem(req.params.orderId, req.params.itemId);
      sendNoContent(res);
    },
  );
}
