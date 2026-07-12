export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendError(res, status, code, message, details = undefined) {
  const body = {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function notFound(resource) {
  return new ApiError(404, 'E_NOT_FOUND', `${resource} not found`);
}
