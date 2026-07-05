/**
 * Standardized error body (RFC 9457 problem details, extended with
 * correlationId). Every non-2xx response uses this shape.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  correlationId?: string;
  /** Field-level validation issues, when applicable. */
  errors?: Array<{ path: string; message: string }>;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
