import { createHash } from 'node:crypto'
import { ToolInputError } from './errors'
import { canonicalToolEffectJson } from './toolEffects'

export const toolEffectArtifactPurposes = [
  'file_edit', 'file_restore', 'managed-call', 'subagent', 'subagent-thread', 'subagent-run', 'memory-record', 'http-download'
] as const
export type ToolEffectArtifactPurpose = typeof toolEffectArtifactPurposes[number]

/** Resource identities belong to the durable call. Business handlers receive
 * these values, never graph task keys or a recipe for generating new identities. */
export interface ToolEffectArtifactIdentity {
  readonly runId: string
  readonly artifacts: Readonly<Record<ToolEffectArtifactPurpose, string>>
}

export interface ToolEffectCall {
  id?: string
  name: string
  args: unknown
}

export function readToolEffectCall(value: unknown): ToolEffectCall & { args: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Execution supplied an invalid tool call.')
  }
  const call = value as Partial<ToolEffectCall>
  if (typeof call.name !== 'string' || !call.name) {
    throw new Error('Execution supplied a tool call without a name.')
  }
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new ToolInputError(`Tool call ${call.name} requires arguments as a JSON object.`)
  }
  return call as ToolEffectCall & { args: Record<string, unknown> }
}

/** Bind to the actual response batch before consulting or preparing its journal.
 * Reference, unique provider ID, then canonical arguments retain the imported
 * precedence. Ambiguous identity must never select another call's saved result. */
export function toolEffectCallIdentity(calls: readonly ToolEffectCall[], current: ToolEffectCall): {
  callIndex: number; callKey: string; argsJson: string; inputHash: string
} {
  let callIndex = calls.findIndex(call => call === current)
  if (callIndex < 0 && current.id) {
    const matchingIds = calls.flatMap((call, index) => call.id === current.id ? [index] : [])
    if (matchingIds.length === 1) callIndex = matchingIds[0]
  }
  const argsJson = canonicalToolEffectJson(current.args)
  if (callIndex < 0) {
    const matchingValues = calls.flatMap((call, index) =>
      call.name === current.name && canonicalToolEffectJson(call.args) === argsJson ? [index] : [])
    if (matchingValues.length === 1) callIndex = matchingValues[0]
  }
  if (callIndex < 0) throw new Error(`Cannot resolve a stable call index for effectful tool ${current.name}.`)
  return { callIndex, callKey: current.id ? `id:${current.id}` : `index:${callIndex}`,
    argsJson, inputHash: createHash('sha256').update(argsJson).digest('hex') }
}
