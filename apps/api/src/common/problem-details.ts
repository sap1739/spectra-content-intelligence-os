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
  /**
   * Budget decision attached to a `budget-exceeded` refusal, so the client can
   * show what limit was hit and how much of it was estimated.
   */
  budget?: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
