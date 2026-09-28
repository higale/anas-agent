/** Validate an application-owned persisted document before interpreting its fields. */
export function requireDataVersion(value: unknown, expected: number, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).version !== expected) {
    throw new Error(`Unsupported ${label} version; expected ${expected}.`)
  }
}
