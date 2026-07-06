/** Drops undefined entries so PATCH semantics and DB defaults behave. */
export function definedOnly<T extends object>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
