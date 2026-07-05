/** Reusable security errors. API layers map these to HTTP status codes. */

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ForbiddenError extends SecurityError {
  constructor(
    public readonly permission: string,
    message = `Missing required permission: ${permission}`,
  ) {
    super(message);
  }
}

export class TenantIsolationError extends SecurityError {
  constructor(message = 'Resource does not belong to the caller tenant') {
    // Deliberately generic: callers must not learn whether the resource exists.
    super(message);
  }
}

export class EncryptionError extends SecurityError {}
