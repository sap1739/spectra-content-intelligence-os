/**
 * Deep redaction for objects that are about to leave a trust boundary
 * (audit logs, error reports). Complements the pino path-based redaction in
 * @spectra/logging for cases where data is serialized manually.
 */

const SENSITIVE_KEY_PATTERN =
  /password|passphrase|secret|token|apikey|api_key|authorization|cookie|credential|cardnumber|card_number|cvv|encryptionkey|encryption_key|privatekey|private_key/i;

export const REDACTED_VALUE = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function deepRedact<T>(value: T, depth = 0): T {
  if (depth > 10 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, depth + 1)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED_VALUE : deepRedact(val, depth + 1);
  }
  return result as T;
}
