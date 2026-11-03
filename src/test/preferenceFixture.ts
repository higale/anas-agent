import { vi } from 'vitest'
import type { PreferenceScope } from '../shared/preferenceMemory'

export function mockPreferenceReader(owner: object, content = '') {
  const read = vi.fn((scope: PreferenceScope) => ({ scope, content: scope.kind === 'project' ? content : '', hash: '' }))
  Object.defineProperty(owner, 'preferences', { configurable: true, value: { read } })
  return read
}
