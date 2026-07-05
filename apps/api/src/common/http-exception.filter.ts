import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ForbiddenError, TenantIsolationError } from '@spectra/security';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from './problem-details';
import { ZodValidationException } from './zod-validation.pipe';

/**
 * Maps every error to a problem+json body. Domain security errors map to
 * 403/404-style responses without leaking resource existence; unexpected
 * errors are logged with the correlation id and returned as opaque 500s.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const correlationId = (request.headers['x-correlation-id'] as string) ?? undefined;

    const problem = this.toProblem(exception, correlationId);

    if (problem.status >= 500) {
      this.logger.error(
        { correlationId, err: exception instanceof Error ? exception.message : exception },
        'Unhandled exception',
      );
    }

    void reply.status(problem.status).header('content-type', PROBLEM_CONTENT_TYPE).send(problem);
  }

  private toProblem(exception: unknown, correlationId?: string): ProblemDetails {
    if (exception instanceof ZodValidationException) {
      return {
        type: 'https://spectra.dev/problems/validation',
        title: 'Request validation failed',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: exception.issues,
        ...(correlationId ? { correlationId } : {}),
      };
    }

    if (exception instanceof TenantIsolationError) {
      // Same response for "not found" and "not yours": no existence leaks.
      return {
        type: 'https://spectra.dev/problems/not-found',
        title: 'Resource not found',
        status: HttpStatus.NOT_FOUND,
        ...(correlationId ? { correlationId } : {}),
      };
    }

    if (exception instanceof ForbiddenError) {
      return {
        type: 'https://spectra.dev/problems/forbidden',
        title: 'Insufficient permissions',
        status: HttpStatus.FORBIDDEN,
        detail: exception.message,
        ...(correlationId ? { correlationId } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail =
        typeof response === 'string'
          ? response
          : ((response as Record<string, unknown>)['message'] as string | undefined);
      return {
        type: `https://spectra.dev/problems/http-${status}`,
        title: exception.message,
        status,
        ...(detail && detail !== exception.message ? { detail: String(detail) } : {}),
        ...(correlationId ? { correlationId } : {}),
      };
    }

    return {
      type: 'https://spectra.dev/problems/internal',
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      ...(correlationId ? { correlationId } : {}),
    };
  }
}
