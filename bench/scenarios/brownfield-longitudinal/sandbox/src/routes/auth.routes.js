import { requireAuth } from '../lib/auth/middleware.js';
import { sendError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { sendJson } from '../router.js';
import { loginSchema, registerSchema } from '../schemas/auth.schema.js';
import { getProfile, login, register } from '../services/auth.service.js';

export function registerAuthRoutes(router) {
  router.add('POST', '/auth/register', (req, res) => {
    const problems = validate(req.body, registerSchema);
    if (problems.length > 0) {
      sendError(res, 422, 'E_VALIDATION', 'invalid request body', problems);
      return;
    }
    sendJson(res, 201, register(req.body));
  });

  router.add('POST', '/auth/login', (req, res) => {
    const problems = validate(req.body, loginSchema);
    if (problems.length > 0) {
      sendError(res, 422, 'E_VALIDATION', 'invalid request body', problems);
      return;
    }
    sendJson(res, 200, login(req.body));
  });

  router.add('GET', '/auth/me', requireAuth, (req, res) => {
    sendJson(res, 200, getProfile(req.user.id));
  });
}
