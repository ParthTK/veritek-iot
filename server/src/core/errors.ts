export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required.'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Not permitted.'): AppError =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not found.'): AppError =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'CONFLICT', message, details);

export const payloadTooLarge = (message: string): AppError =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', message);

export const tooManyRequests = (message: string): AppError =>
  new AppError(429, 'RATE_LIMITED', message);

/**
 * Used for the parts of the system that are deliberately inert until the real
 * hardware documentation lands - most importantly the remote-configuration
 * command syntax (spec section 17: "do not send invented commands").
 */
export const notConfigured = (message: string, details?: unknown): AppError =>
  new AppError(501, 'NOT_CONFIGURED', message, details);
