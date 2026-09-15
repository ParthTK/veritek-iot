import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { isProduction } from '../../config/env.js';

const log = createLogger('api');

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'No route matches ' + req.method + ' ' + req.path },
  });
}

/**
 * Terminal error handler.
 *
 * Client errors are answered with their own code; anything unexpected is logged
 * in full and answered with a generic message, so internal detail never leaks
 * to a caller.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof AppError) {
    if (error.code === 'NOT_CONFIGURED') {
      // Expected while the hardware's wire format is still unknown.
      log.warn('request refused: capability not configured yet', {
        path: req.path,
        message: error.message,
      });
    } else if (error.status >= 500) {
      log.error('request failed', { path: req.path, method: req.method, error });
    } else {
      log.debug('request rejected', { path: req.path, code: error.code, message: error.message });
    }
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  log.error('unhandled request error', { path: req.path, method: req.method, error });
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      ...(isProduction ? {} : { detail: error instanceof Error ? error.message : String(error) }),
    },
  });
}
