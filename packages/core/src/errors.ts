/**
 * SAJIMORA v4.0 — Error Taxonomy
 * Subordinate to SAJIMORA_V4_MASTER_IMPLEMENTATION_PLAN.md & Volume 1
 */

export abstract class SajimoraError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  constructor(message: string, public readonly metadata?: Record<string, any>) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      metadata: this.metadata || null,
    };
  }
}

export class AuthenticationError extends SajimoraError {
  readonly code = 'UNAUTHENTICATED';
  readonly statusCode = 401;
}

export class ForbiddenError extends SajimoraError {
  readonly code = 'FORBIDDEN';
  readonly statusCode = 403;
}

export class NotFoundError extends SajimoraError {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;
}

export class MfaRequiredError extends SajimoraError {
  readonly code = 'MFA_REQUIRED';
  readonly statusCode = 403;
  constructor(message: string, public readonly stepUpToken: string) {
    super(message, { stepUpToken });
  }
}

export class SecurityIsolationError extends SajimoraError {
  readonly code = 'SECURITY_ISOLATION_BREACH';
  readonly statusCode = 403;
}

export class RateLimitExceededError extends SajimoraError {
  readonly code = 'RATE_LIMIT_EXCEEDED';
  readonly statusCode = 429;
}

export class InternalSystemError extends SajimoraError {
  readonly code = 'INTERNAL_ERROR';
  readonly statusCode = 500;
}
