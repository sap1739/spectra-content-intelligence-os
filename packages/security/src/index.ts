export { EncryptionError, ForbiddenError, SecurityError, TenantIsolationError } from './errors';
export {
  ROLE_PERMISSIONS,
  assertPermission,
  hasPermission,
  permissionsForRole,
} from './permissions';
export type { PermissionSubject } from './permissions';
export { assertTenantOwnership } from './tenant';
export type { TenantContext, TenantOwned } from './tenant';
export { decryptSecret, encryptSecret, generateEncryptionKey } from './crypto';
export type { KeyRing } from './crypto';
export { REDACTED_VALUE, deepRedact, isSensitiveKey } from './redaction';
export { CURRENT_SCRYPT_PARAMS, hashPassword, needsRehash, verifyPassword } from './passwords';
export type { ScryptParams } from './passwords';
