import { createHash } from 'node:crypto'

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function codingDiagnostic(value: unknown) {
  const text = JSON.stringify(value)
  return { fingerprint: fingerprint(value), characters: text.length, excerpt: text.slice(0, 4000), truncated: text.length > 4000 }
}
