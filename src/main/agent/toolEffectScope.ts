import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentManagedCallRecord } from './managedCallStore'
import type { ToolEffectArtifactIdentity, ToolEffectArtifactPurpose } from '../../runtime/toolEffectIdentity'
import { beginToolEffect } from './toolExecutionContext'
import type { FilePatchEditRecord } from '../filePatchRecord'

export type AgentToolEffectRecoveryMode = 'confirm' | 'idempotent'

export interface AgentToolEffectArm {
  kind: string
  target: unknown
  recoveryMode?: AgentToolEffectRecoveryMode
  idempotencyFingerprint?: string
}

export interface CurrentAgentToolEffectScope {
  readonly identity?: ToolEffectArtifactIdentity
  isUnarmed?(): boolean
  previousEffect?(): Pick<AgentToolEffectArm, 'kind' | 'target'> | undefined
  persistFileChange?(record: FilePatchEditRecord, observed: boolean): void
  deferManagedCallResult?(call: AgentManagedCallRecord): void
  arm(effect: AgentToolEffectArm): void
}

const currentToolEffect = new AsyncLocalStorage<CurrentAgentToolEffectScope>()

export function deferCurrentManagedCallResult(call: AgentManagedCallRecord): boolean {
  const defer = currentToolEffect.getStore()?.deferManagedCallResult
  if (!defer) return false
  defer(call)
  return true
}

export function persistCurrentFileChange(record: FilePatchEditRecord, observed = false): void {
  currentToolEffect.getStore()?.persistFileChange?.(record, observed)
}

export function runWithCurrentAgentToolEffect<T>(
  scope: CurrentAgentToolEffectScope,
  operation: () => T
): T {
  return currentToolEffect.run(scope, operation)
}

export function runWithoutCurrentAgentToolEffect<T>(operation: () => T): T {
  return currentToolEffect.exit(operation)
}

export function armCurrentAgentToolEffect(effect: AgentToolEffectArm): void {
  beginToolEffect()
  currentToolEffect.getStore()?.arm(effect)
}

export function currentAgentToolEffectArtifactId(purpose: ToolEffectArtifactPurpose): string | undefined {
  return currentToolEffect.getStore()?.identity?.artifacts[purpose]
}

export function currentAgentToolEffectReference(): Pick<AgentToolEffectArm, 'kind' | 'target'> | undefined {
  return structuredClone(currentToolEffect.getStore()?.previousEffect?.())
}

export function hasCurrentAgentToolEffectScope(): boolean {
  return currentToolEffect.getStore() !== undefined
}

export function canRestartUnpublishedEffectArtifact(requestId: string, operationId: string, purpose: ToolEffectArtifactPurpose): boolean {
  const scope = currentToolEffect.getStore()
  return scope?.identity?.runId === requestId
    && scope.identity.artifacts[purpose] === operationId
    && scope.isUnarmed?.() === true
}
