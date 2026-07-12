import { requireAuth, requireRole } from '../lib/auth/middleware.js';
import { sendError } from '../lib/errors.js';
import { parsePagination } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import { sendJson, sendNoContent } from '../router.js';
import {
  createCustomerSchema,
  updateCustomerSchema,
} from '../schemas/customer.schema.js';
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  listCustomersPage,
  patchCustomer,
} from '../services/customers.service.js';

export function registerCustomerRoutes(router) {
  router.add('POST', '/customers', requireAuth, (req, res) => {
    const problems = validate(req.body, createCustomerSchema);
    if (problems.length > 0) {
      sendError(res, 422, 'E_VALIDATION', 'invalid request body', problems);
      return;
    }
    sendJson(res, 201, createCustomer(req.body));
  });

  router.add('GET', '/customers', requireAuth, (req, res) => {
    sendJson(res, 200, listCustomersPage(parsePagination(req.query)));
  });

  router.add('GET', '/customers/:customerId', requireAuth, (req, res) => {
    sendJson(res, 200, getCustomer(req.params.customerId));
  });

  router.add('PATCH', '/customers/:customerId', requireAuth, (req, res) => {
    const problems = validate(req.body, updateCustomerSchema);
    if (problems.length > 0) {
      sendError(res, 422, 'E_VALIDATION', 'invalid request body', problems);
      return;
    }
    sendJson(res, 200, patchCustomer(req.params.customerId, req.body));
  });

  router.add(
    'DELETE',
    '/customers/:customerId',
    requireAuth,
    requireRole('admin'),
    (req, res) => {
      deleteCustomer(req.params.customerId);
      sendNoContent(res);
    },
  );
}
