import { sendError } from '../errors.js';
import { verifyToken } from './token.js';

export function requireAuth(req, res) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    sendError(res, 401, 'E_UNAUTHENTICATED', 'a bearer token is required');
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    sendError(res, 401, 'E_UNAUTHENTICATED', 'invalid or expired token');
    return;
  }
  req.user = { id: payload.sub, role: payload.role };
}

export function requireRole(role) {
  return function checkRole(req, res) {
    if (req.user?.role !== role) {
      sendError(res, 403, 'E_FORBIDDEN', `this action requires the ${role} role`);
    }
  };
}
