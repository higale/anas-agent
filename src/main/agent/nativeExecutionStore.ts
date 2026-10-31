import { canRetryModelRequest, isCompleteModelInput, lastToolResultBatch, modelRetryTodos, withholdToolResult } from '../../runtime/modelRequestRecovery'
import { requireObjectToolCall } from '../../runtime/toolInput'
import { modelOutputWasTruncated } from '../../runtime/modelOutputRecovery'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { encodeExecutionValue, decodeExecutionValue } from '../../runtime/executionValue'
import { encodeConversationMessage, decodeConversationMessage, conversationMessageRecordId } from '../../runtime/conversationStorage'
import { projectRulesSchema } from '../../runtime/projectRules'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { authorizationInputHash } from '../../runtime/authorizationReceipts'
import type { ManualContextCompression } from '../../runtime/compression'
import { canonicalToolEffectJson, type ToolEffectArm, type ToolEffectRecoveryMode, type ToolEffectRecoveryRequest } from '../../runtime/toolEffects'
import type { ExecutionApproval, ExecutionCommitScope, ExecutionContext, ExecutionMessageInput,
  ExecutionMessageRecord, ExecutionPhase, ExecutionState, ExecutionToolCall, ExecutionToolPreparation, ExecutionToolStateUpdate, ExecutionEffectKey, ExecutionEffectRecord } from '../../runtime/executionState'

/** Installed only by creation of the native execution database.
 * Merely constructing a store never creates tables or upgrades existing data. */
export const nativeExecutionSchema = `
  CREATE TABLE execution_state (
    thread_id TEXT PRIMARY KEY, run_id TEXT, revision_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('idle','prepare_model','model_result','tools','waiting','waiting_context','completed','cancelled','failed')),
    context_value BLOB NOT NULL, approvals_value BLOB NOT NULL, response_record_id TEXT,
    CHECK ((phase='idle' AND run_id IS NULL) OR (phase<>'idle' AND run_id IS NOT NULL))
  );
  CREATE TABLE execution_message_bodies (
    thread_id TEXT NOT NULL, record_id TEXT NOT NULL, message_id TEXT NOT NULL, value BLOB NOT NULL,
    PRIMARY KEY (thread_id,record_id)
  );
  CREATE TABLE execution_messages (
    thread_id TEXT NOT NULL, position INTEGER NOT NULL, message_id TEXT NOT NULL, record_id TEXT NOT NULL,
    PRIMARY KEY (thread_id,position), UNIQUE (thread_id,message_id),
    FOREIGN KEY (thread_id) REFERENCES execution_state(thread_id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id,record_id) REFERENCES execution_message_bodies(thread_id,record_id)
  );
  CREATE TABLE execution_model_calls (
    thread_id TEXT NOT NULL, record_id TEXT NOT NULL, call_index INTEGER NOT NULL CHECK (call_index >= 0), call_id TEXT NOT NULL,
    PRIMARY KEY (thread_id,record_id,call_index), UNIQUE (thread_id,record_id,call_id),
    FOREIGN KEY (thread_id,record_id) REFERENCES execution_message_bodies(thread_id,record_id) ON DELETE CASCADE
  );
  CREATE TABLE execution_calls (
    thread_id TEXT NOT NULL, call_id TEXT NOT NULL, call_index INTEGER NOT NULL, call_value BLOB NOT NULL,
    result_record_id TEXT, result_update_value BLOB, prepared INTEGER NOT NULL DEFAULT 0 CHECK (prepared IN (0,1)),
    PRIMARY KEY (thread_id,call_id), UNIQUE (thread_id,call_index),
    FOREIGN KEY (thread_id) REFERENCES execution_state(thread_id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id,result_record_id) REFERENCES execution_message_bodies(thread_id,record_id)
  );
  CREATE TABLE execution_effects (
    thread_id TEXT NOT NULL, run_id TEXT NOT NULL, call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL, provider_call_id TEXT, args_json TEXT NOT NULL, resources_value BLOB NOT NULL,
    recovery_mode TEXT NOT NULL CHECK (recovery_mode IN ('confirm','idempotent')),
    state TEXT NOT NULL CHECK (state IN ('prepared','intent','result')),
    effect_kind TEXT, target_json TEXT, idempotency_fingerprint TEXT,
    effect_attempt INTEGER NOT NULL DEFAULT 0 CHECK (effect_attempt >= 0),
    confirmation_count INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_count >= 0),
    automatic_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (automatic_retry_count >= 0),
    result_record_id TEXT,
    PRIMARY KEY (thread_id,run_id,call_id),
    FOREIGN KEY (thread_id,result_record_id) REFERENCES execution_message_bodies(thread_id,record_id)
  );
`

interface StateRow { thread_id: string; run_id: string; revision_id: string; phase: ExecutionPhase; context_value: Uint8Array; approvals_value: Uint8Array; response_record_id: string | null }
type HistoryRow = StateRow | (Omit<StateRow, 'run_id' | 'phase'> & { run_id: null; phase: 'idle' })
interface BodyRow { record_id: string; message_id: string; value: Uint8Array }
interface CallRow { call_id: string; call_index: number; call_value: Uint8Array; result_record_id: string | null; result_update_value: Uint8Array | null; prepared: number }
interface EffectRow {
  thread_id: string; run_id: string; call_id: string; tool_name: string; provider_call_id: string | null; args_json: string; resources_value: Uint8Array;
  recovery_mode: ToolEffectRecoveryMode; state: ExecutionEffectRecord['state']; effect_kind: string | null;
  target_json: string | null; idempotency_fingerprint: string | null; effect_attempt: number; confirmation_count: number;
  automatic_retry_count: number; result_record_id: string | null
}

export interface NativeHistorySnapshot {
  threadId: string
  revisionId: string
  messages: ExecutionMessageRecord[]
  summary?: { reference: NonNullable<ExecutionContext['summary']>; record: ExecutionMessageRecord }
}

export interface NativeExecutionCommit {
  /** The owning product run stores the failure detail with this transition. */
  error?: string
  threadId: string
  runId: string
  revisionId: string
  phase: ExecutionPhase
  inputAccepted: boolean
  messageRecords: ExecutionMessageRecord[]
  previousResponseRecordId?: string
  replacedToolResults?: Record<string, string>
  summary?: ManualContextCompression & { id: string }
}

function validContext(context: ExecutionContext): ExecutionContext {
  const recovery = context.modelRecovery
  if (recovery !== undefined && (!recovery || !Number.isSafeInteger(recovery.attempts) || recovery.attempts < 0 || recovery.attempts > 2
    || recovery.inFlight !== undefined && typeof recovery.inFlight !== 'boolean'
    || !Number.isSafeInteger(recovery.retryAt) || recovery.retryAt < 0
    || !['network', 'rate_limit', 'server', 'timeout', 'configuration_changed', 'incomplete', 'invalid_tool_call', 'output_limit', 'text_continuation'].includes(recovery.reason)
    || recovery.feedback !== undefined && !['invalid_tool_call', 'output_limit', 'text_continuation'].includes(recovery.feedback))) {
    throw new Error('Invalid model recovery state.')
  }
  if (context.modelRequestFailed !== undefined && typeof context.modelRequestFailed !== 'boolean') throw new Error('Invalid model request recovery context.')
  if (context.modelFailureBoundaries !== undefined && (!context.modelFailureBoundaries || typeof context.modelFailureBoundaries !== 'object'
    || Array.isArray(context.modelFailureBoundaries) || Object.entries(context.modelFailureBoundaries).some(([id, value]) => !id || !value || typeof value !== 'object'
      || typeof value.messageId !== 'string' || !value.messageId || typeof value.modelRequestFailed !== 'boolean'))) {
    throw new Error('Invalid model failure boundaries.')
  }
  for (const observed of [context.observedManagedCalls, context.observedSubagents]) {
    if (observed !== undefined && (!observed || typeof observed !== 'object' || Array.isArray(observed)
      || Object.entries(observed).some(([id, value]) => !id || value !== true))) throw new Error('Invalid persisted background observation evidence.')
  }
  if (!Number.isSafeInteger(context.modelCalls) || context.modelCalls < 0 || !Array.isArray(context.todos)
    || context.threadModelCalls !== undefined && (!Number.isSafeInteger(context.threadModelCalls) || context.threadModelCalls < 0)
    || context.todos.some(todo => !todo || typeof todo.content !== 'string' || !['pending', 'in_progress', 'completed'].includes(todo.status))) {
    throw new Error('Invalid persisted execution context.')
  }
  if (context.summary !== undefined && (!context.summary || typeof context.summary.id !== 'string' || !context.summary.id
    || typeof context.summary.messageRecordId !== 'string' || !context.summary.messageRecordId
    || !Number.isSafeInteger(context.summary.cutoffIndex) || context.summary.cutoffIndex < 0
    || context.summary.sessionId !== undefined && typeof context.summary.sessionId !== 'string')) {
    throw new Error('Invalid persisted execution summary reference.')
  }
  if (context.projectRules !== undefined) projectRulesSchema.parse(context.projectRules)
  const preparation = context.rulePreparation
  if (preparation !== undefined && (!preparation || typeof preparation.runId !== 'string' || !preparation.runId
    || typeof preparation.initialized !== 'boolean' || !Array.isArray(preparation.reads)
    || preparation.reads.some(read => !read || typeof read.path !== 'string' || !read.path || typeof read.approved !== 'boolean')
    || new Set(preparation.reads.map(read => read.path)).size !== preparation.reads.length
    || (context.projectRules ? context.projectRules.runId !== preparation.runId : preparation.initialized))) throw new Error('Invalid persisted project rule preparation.')
  if (preparation?.completedCalls !== undefined && (!preparation.initialized || !Array.isArray(preparation.completedCalls)
    || preparation.completedCalls.some(call => !call || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name
      || typeof call.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(call.inputHash))
    || new Set(preparation.completedCalls.map(call => call.id)).size !== preparation.completedCalls.length)) {
    throw new Error('Invalid persisted completed rule preparation.')
  }
  return context
}

function validCall(call: ExecutionToolCall): ExecutionToolCall {
  if (typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name
    || call.providerCallId !== undefined && typeof call.providerCallId !== 'string'
    || !call.artifacts || toolEffectArtifactPurposes.some(purpose => typeof call.artifacts[purpose] !== 'string' || !call.artifacts[purpose])) {
    throw new Error('Invalid persisted execution tool call.')
  }
  if (!['object', 'string', 'number', 'boolean'].includes(typeof call.args)) throw new Error('Invalid tool arguments.')
  // These are recorded model arguments, not an authorized effect. Preflight
  // must be able to return invalid numbers to the model as a correction.
  const authorization = call.authorization
  const child = call.subagentApproval
  if (child !== undefined && (!child || call.name !== 'wait_subagent' || child.subagentId !== requireObjectToolCall(call).args.subagent_id
    || typeof child.generation !== 'string' || !child.generation || !Array.isArray(child.decisions) || !child.decisions.length
    || child.decisions.some(decision => !decision || !['approve', 'reject'].includes(decision.type)
      || decision.type === 'reject' && decision.message !== undefined && typeof decision.message !== 'string'))) {
    throw new Error('Invalid persisted subagent approval answer.')
  }
  if (authorization !== undefined && (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)
    || Object.keys(authorization).some(key => !['approval', 'patch', 'shell'].includes(key)))) throw new Error('Invalid persisted tool authorization.')
  if (authorization?.approval !== undefined && authorization.approval !== 'pending' && authorization.approval !== 'granted') {
    throw new Error('Invalid persisted tool approval grant.')
  }
  for (const receipt of [authorization?.patch, authorization?.shell]) {
    if (receipt !== undefined && (!receipt || typeof receipt !== 'object' || receipt.id !== call.id || receipt.name !== call.name || receipt.inputHash !== authorizationInputHash(call.args)
      || typeof receipt.requiresApproval !== 'boolean' || typeof receipt.humanApproved !== 'boolean')) {
      throw new Error('The persisted authorization does not match its tool call.')
    }
  }
  const patch = authorization?.patch
  if (patch && (!Array.isArray(patch.targets) || patch.targets.some(target => !target || typeof target.path !== 'string'
    || typeof target.lexicalPath !== 'string' || !Array.isArray(target.locator) || target.locator.some(part => typeof part !== 'string' && typeof part !== 'number')
    || !['file', 'temporary', 'directory'].includes(target.kind) || !['read', 'write'].includes(target.access))
    || patch.error !== undefined && typeof patch.error !== 'string')) throw new Error('Invalid persisted patch authorization targets.')
  const plan = authorization?.shell?.plan
  if (plan !== undefined && (!plan || typeof plan.workingDir !== 'string' || typeof plan.executable !== 'string'
    || !Array.isArray(plan.paths) || plan.paths.some(path => typeof path !== 'string')
    || plan.skillScript !== undefined && (!plan.skillScript || ['skillId', 'root', 'script', 'executor'].some(key =>
      typeof plan.skillScript![key as keyof typeof plan.skillScript] !== 'string')))) throw new Error('Invalid persisted Shell authorization plan.')
  return call
}

function authorizationValue(authorization: NonNullable<ExecutionToolCall['authorization']>): unknown {
  const common = (receipt: NonNullable<typeof authorization.patch> | NonNullable<typeof authorization.shell>) => ({
    id: receipt.id, name: receipt.name, input_hash: receipt.inputHash, requires_approval: receipt.requiresApproval, human_approved: receipt.humanApproved
  })
  return { ...(authorization.approval === undefined ? {} : { approval: authorization.approval }),
    ...(authorization.patch ? { patch: { ...common(authorization.patch),
      targets: authorization.patch.targets.map(target => ({ path: target.path, lexical_path: target.lexicalPath, locator: target.locator, kind: target.kind, access: target.access })),
      ...(authorization.patch.error === undefined ? {} : { error: authorization.patch.error }) } } : {}),
    ...(authorization.shell ? { shell: { ...common(authorization.shell), ...(authorization.shell.plan ? { plan: {
      working_dir: authorization.shell.plan.workingDir, executable: authorization.shell.plan.executable, paths: authorization.shell.plan.paths,
      ...(authorization.shell.plan.skillScript ? { skill_script: { skill_id: authorization.shell.plan.skillScript.skillId,
        root: authorization.shell.plan.skillScript.root, script: authorization.shell.plan.skillScript.script, executor: authorization.shell.plan.skillScript.executor } } : {})
    } } : {}) } } : {}) }
}

function readAuthorization(value: unknown): ExecutionToolCall['authorization'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['approval', 'patch', 'shell'].includes(key))) throw new Error('Invalid persisted tool authorization.')
  type Receipt = { id: string; name: string; input_hash: string; requires_approval: boolean; human_approved: boolean }
  const source = value as { approval?: 'pending' | 'granted';
    patch?: Receipt & { targets: Array<{ path: string; lexical_path: string; locator: (string | number)[]; kind: 'file' | 'temporary' | 'directory'; access: 'read' | 'write' }>; error?: string };
    shell?: Receipt & { plan?: { working_dir: string; executable: string; paths: string[];
      skill_script?: { skill_id: string; root: string; script: string; executor: string } } } }
  for (const receipt of [source.patch, source.shell]) if (receipt !== undefined && (!receipt || typeof receipt !== 'object')) throw new Error('Invalid persisted authorization receipt.')
  if (source.shell?.plan !== undefined && (!source.shell.plan || typeof source.shell.plan !== 'object')) throw new Error('Invalid persisted Shell authorization plan.')
  const skill = source.shell?.plan?.skill_script
  if (skill !== undefined && (!skill || typeof skill !== 'object')) throw new Error('Invalid persisted Shell skill authorization.')
  const common = (receipt: Receipt) => ({ id: receipt.id, name: receipt.name, inputHash: receipt.input_hash,
    requiresApproval: receipt.requires_approval, humanApproved: receipt.human_approved })
  return { ...(source.approval === undefined ? {} : { approval: source.approval }),
    ...(source.patch ? { patch: { ...common(source.patch), targets: source.patch.targets.map(target => ({ path: target.path,
      lexicalPath: target.lexical_path, locator: target.locator, kind: target.kind, access: target.access })),
      ...(source.patch.error === undefined ? {} : { error: source.patch.error }) } } : {}),
    ...(source.shell ? { shell: { ...common(source.shell), ...(source.shell.plan ? { plan: {
      workingDir: source.shell.plan.working_dir, executable: source.shell.plan.executable, paths: source.shell.plan.paths,
      ...(source.shell.plan.skill_script ? { skillScript: { skillId: source.shell.plan.skill_script.skill_id,
        root: source.shell.plan.skill_script.root, script: source.shell.plan.skill_script.script, executor: source.shell.plan.skill_script.executor } } : {})
    } } : {}) } } : {}) }
}

function contextValue(context: ExecutionContext): unknown {
  validContext(context)
  return { model_calls: context.modelCalls, todos: context.todos,
    ...(context.modelRecovery ? { model_recovery: { attempts: context.modelRecovery.attempts, reason: context.modelRecovery.reason,
      retry_at: context.modelRecovery.retryAt, ...(context.modelRecovery.inFlight === undefined ? {} : { in_flight: context.modelRecovery.inFlight }),
      ...(context.modelRecovery.feedback ? { feedback: context.modelRecovery.feedback } : {}) } } : {}),
    ...(context.modelFailureBoundaries === undefined ? {} : { model_failure_boundaries: Object.fromEntries(Object.entries(context.modelFailureBoundaries).map(([id, value]) =>
      [id, { message_id: value.messageId, model_request_failed: value.modelRequestFailed }])) }),
    ...(context.modelRequestFailed === undefined ? {} : { model_request_failed: context.modelRequestFailed }),
    ...(context.observedManagedCalls === undefined ? {} : { observed_managed_calls: context.observedManagedCalls }),
    ...(context.observedSubagents === undefined ? {} : { observed_subagents: context.observedSubagents }),
    ...(context.rulePreparation ? { rule_preparation: { run_id: context.rulePreparation.runId,
      initialized: context.rulePreparation.initialized, reads: context.rulePreparation.reads,
      ...(context.rulePreparation.completedCalls === undefined ? {} : { completed_calls: context.rulePreparation.completedCalls.map(call => ({
        id: call.id, name: call.name, input_hash: call.inputHash })) }) } } : {}),
    ...(context.threadModelCalls === undefined ? {} : { thread_model_calls: context.threadModelCalls }),
    ...(context.summary ? { summary: { id: context.summary.id, message_record_id: context.summary.messageRecordId,
      cutoff_index: context.summary.cutoffIndex, ...(context.summary.sessionId === undefined ? {} : { session_id: context.summary.sessionId }) } } : {}),
    ...(context.projectRules ? { project_rules: {
      run_id: context.projectRules.runId, trusted_folders: context.projectRules.trustedFolders, roots: context.projectRules.roots,
      documents: context.projectRules.documents, directories: context.projectRules.directories.map(value => ({ path: value.path, document_id: value.documentId })),
      initial_scopes: context.projectRules.initialScopes, active_scopes: context.projectRules.activeScopes,
      blocked_calls: context.projectRules.blockedCalls, rejected_calls: context.projectRules.rejectedCalls,
      checked_writes: context.projectRules.checkedWrites, blocked_reason: context.projectRules.blockedReason, fatal_error: context.projectRules.fatalError
    } } : {}) }
}

function readContext(bytes: Uint8Array): ExecutionContext {
  const value = decodeExecutionValue(bytes) as Record<string, unknown>
  if (value.model_failure_boundaries !== undefined && (!value.model_failure_boundaries || typeof value.model_failure_boundaries !== 'object'
    || Array.isArray(value.model_failure_boundaries))) throw new Error('Invalid model failure boundaries.')
  const summary = value.summary as { id: string; message_record_id: string; cutoff_index: number; session_id?: string } | undefined
  const rules = value.project_rules as Record<string, unknown> | undefined
  const preparation = value.rule_preparation as { run_id: string; initialized: boolean; reads: { path: string; approved: boolean }[];
    completed_calls?: { id: string; name: string; input_hash: string }[] } | undefined
  const recovery = value.model_recovery as { attempts: number; reason: NonNullable<ExecutionContext['modelRecovery']>['reason'];
    retry_at: number; in_flight?: boolean; feedback?: NonNullable<ExecutionContext['modelRecovery']>['feedback'] } | undefined
  return validContext({
    ...(recovery === undefined ? {} : { modelRecovery: recovery && { attempts: recovery.attempts, reason: recovery.reason,
      retryAt: recovery.retry_at, ...(recovery.in_flight === undefined ? {} : { inFlight: recovery.in_flight }),
      ...(recovery.feedback === undefined ? {} : { feedback: recovery.feedback }) } }),
    ...(value.model_failure_boundaries === undefined ? {} : { modelFailureBoundaries: Object.fromEntries(Object.entries(value.model_failure_boundaries as Record<string, { message_id: string; model_request_failed: boolean }>).map(([id, value]) =>
      [id, { messageId: value?.message_id, modelRequestFailed: value?.model_request_failed }])) }),
    ...(value.model_request_failed === undefined ? {} : { modelRequestFailed: value.model_request_failed as boolean }),
    modelCalls: value.model_calls as number, todos: value.todos as ExecutionContext['todos'],
    ...(value.observed_managed_calls === undefined ? {} : { observedManagedCalls: value.observed_managed_calls as Record<string, true> }),
    ...(value.observed_subagents === undefined ? {} : { observedSubagents: value.observed_subagents as Record<string, true> }),
    ...(preparation === undefined ? {} : { rulePreparation: { runId: preparation.run_id, initialized: preparation.initialized, reads: preparation.reads,
      ...(preparation.completed_calls === undefined ? {} : { completedCalls: preparation.completed_calls.map(call => ({
        id: call.id, name: call.name, inputHash: call.input_hash })) }) } }),
    ...(value.thread_model_calls === undefined ? {} : { threadModelCalls: value.thread_model_calls as number }),
    ...(summary !== undefined ? { summary: { id: summary.id, messageRecordId: summary.message_record_id, cutoffIndex: summary.cutoff_index,
      ...(summary.session_id === undefined ? {} : { sessionId: summary.session_id }) } } : {}),
    ...(rules !== undefined ? { projectRules: {
      runId: rules.run_id, trustedFolders: rules.trusted_folders, roots: rules.roots, documents: rules.documents,
      directories: (rules.directories as Array<{ path: string; document_id: string | null }>).map(item => ({ path: item.path, documentId: item.document_id })),
      initialScopes: rules.initial_scopes, activeScopes: rules.active_scopes, blockedCalls: rules.blocked_calls,
      rejectedCalls: rules.rejected_calls, checkedWrites: rules.checked_writes, blockedReason: rules.blocked_reason, fatalError: rules.fatal_error
    } as ExecutionContext['projectRules'] } : {}) })
}

function callValue(call: ExecutionToolCall): unknown {
  validCall(call)
  return { id: call.id, name: call.name, args: call.args, resource_ids: call.artifacts,
    ...(call.subagentApproval ? { subagent_approval: { subagent_id: call.subagentApproval.subagentId,
      generation: call.subagentApproval.generation, decisions: call.subagentApproval.decisions } } : {}),
    ...(call.providerCallId === undefined ? {} : { provider_call_id: call.providerCallId }),
    ...(call.authorization === undefined ? {} : { authorization: authorizationValue(call.authorization) }) }
}

function readCall(bytes: Uint8Array): ExecutionToolCall {
  const value = decodeExecutionValue(bytes) as { id: string; name: string; args: Record<string, unknown>;
    provider_call_id?: string; resource_ids: ExecutionToolCall['artifacts']; authorization?: unknown;
    subagent_approval?: { subagent_id: string; generation: string; decisions: NonNullable<ExecutionToolCall['subagentApproval']>['decisions'] } }
  return validCall({ id: value.id, name: value.name, args: value.args, artifacts: value.resource_ids,
    ...(value.subagent_approval === undefined ? {} : { subagentApproval: { subagentId: value.subagent_approval.subagent_id,
      generation: value.subagent_approval.generation, decisions: value.subagent_approval.decisions } }),
    ...(value.provider_call_id === undefined ? {} : { providerCallId: value.provider_call_id }),
    ...(value.authorization === undefined ? {} : { authorization: readAuthorization(value.authorization) }) })
}

function validApprovals(approvals: ExecutionApproval[]): ExecutionApproval[] {
  if (!Array.isArray(approvals)) throw new Error('Invalid persisted execution approvals.')
  const ids = new Set<string>(), calls = new Set<string>()
  for (const value of approvals) {
    if (!value || typeof value.id !== 'string' || !value.id || ids.has(value.id)
      || typeof value.generation !== 'string' || !value.generation || !['tool', 'effect_recovery', 'context_read', 'subagent'].includes(value.kind)
      || !Array.isArray(value.callIds) || (value.kind === 'context_read' ? value.callIds.length !== 0 : !value.callIds.length)
      || !Array.isArray(value.request?.actionRequests) || !Array.isArray(value.request?.reviewConfigs)
      || (value.kind === 'subagent' ? !value.request.actionRequests.length : value.request.actionRequests.length !== (value.kind === 'context_read' ? 1 : value.callIds.length))
      || value.request.reviewConfigs.length !== value.request.actionRequests.length) {
      throw new Error('Invalid persisted execution approvals.')
    }
    ids.add(value.id)
    if (value.kind === 'subagent' && (value.callIds.length !== 1 || typeof value.subagentId !== 'string' || !value.subagentId
      || typeof value.childGeneration !== 'string' || !value.childGeneration)) throw new Error('Invalid persisted subagent approval ownership.')
    if (value.kind === 'context_read') {
      const action = value.request.actionRequests[0], policy = value.request.reviewConfigs[0]
      if (typeof value.path !== 'string' || !value.path || !['prepare_model', 'tools'].includes(value.resumePhase)
        || action?.name !== 'read_file' || action.args?.path !== value.path || Object.keys(action.args).length !== 1
        || typeof action.description !== 'string' || policy?.actionName !== 'read_file'
        || policy.allowedDecisions?.length !== 2 || !policy.allowedDecisions.includes('approve') || !policy.allowedDecisions.includes('reject')) {
        throw new Error('Invalid persisted context read approval.')
      }
    }
    for (const id of value.callIds) {
      if (typeof id !== 'string' || !id || calls.has(id)) throw new Error('Invalid persisted execution approval call or policy.')
      calls.add(id)
    }
    for (const [index, action] of value.request.actionRequests.entries()) {
      const policy = value.request.reviewConfigs[index]
      if (!action || typeof action.name !== 'string' || !action.name
        || !action.args || typeof action.args !== 'object' || Array.isArray(action.args) || typeof action.description !== 'string'
        || !policy || policy.actionName !== action.name || !Array.isArray(policy.allowedDecisions)
        || !policy.allowedDecisions.length || policy.allowedDecisions.some(decision => decision !== 'approve' && decision !== 'reject')) {
        throw new Error('Invalid persisted execution approval call or policy.')
      }
      const recovery = (action as ToolEffectRecoveryRequest['actionRequests'][number]).anasRecovery
      if (recovery !== undefined && (!recovery || recovery.state !== 'uncertain'
        || !Number.isSafeInteger(recovery.ordinal) || recovery.ordinal < 1)) throw new Error('Invalid persisted effect recovery ordinal.')
    }
  }
  return approvals
}

function approvalsValue(approvals: ExecutionApproval[]): unknown {
  return validApprovals(approvals).map(value => ({ id: value.id, generation: value.generation, kind: value.kind,
    ...(value.kind === 'context_read' ? { path: value.path, resume_phase: value.resumePhase } : {}),
    ...(value.kind === 'subagent' ? { subagent_id: value.subagentId, child_generation: value.childGeneration } : {}),
    call_ids: value.callIds, request: {
      action_requests: value.request.actionRequests.map(action => {
        const recovery = (action as ToolEffectRecoveryRequest['actionRequests'][number]).anasRecovery
        return { name: action.name, args: action.args, description: action.description,
          ...(recovery === undefined ? {} : { effect_recovery: recovery }) }
      }),
      review_configs: value.request.reviewConfigs.map(policy => ({ action_name: policy.actionName, allowed_decisions: policy.allowedDecisions }))
    } }))
}

function readApprovals(bytes: Uint8Array): ExecutionApproval[] {
  const values = decodeExecutionValue(bytes) as Array<{ id: string; generation: string; kind: ExecutionApproval['kind'];
    call_ids: string[]; path?: string; resume_phase?: 'prepare_model' | 'tools'; subagent_id?: string; child_generation?: string; request: { action_requests: Array<{ name: string; args: Record<string, unknown>; description: string;
      effect_recovery?: { ordinal: number; state: 'uncertain' } }>;
      review_configs: Array<{ action_name: string; allowed_decisions: ('approve' | 'reject')[] }> } }>
  if (!Array.isArray(values)) throw new Error('Invalid persisted execution approvals.')
  return validApprovals(values.map(value => ({ id: value.id, generation: value.generation,
    ...(value.kind === 'context_read' ? { kind: value.kind, callIds: value.call_ids as [], path: value.path!, resumePhase: value.resume_phase! }
      : value.kind === 'subagent' ? { kind: value.kind, callIds: value.call_ids as [string], subagentId: value.subagent_id!, childGeneration: value.child_generation! }
      : { kind: value.kind, callIds: value.call_ids }), request: {
      actionRequests: value.request.action_requests.map(action => ({ name: action.name, args: action.args, description: action.description,
        ...(action.effect_recovery === undefined ? {} : { anasRecovery: action.effect_recovery }) })),
      reviewConfigs: value.request.review_configs.map(policy => ({ actionName: policy.action_name, allowedDecisions: policy.allowed_decisions }))
    } })))
}

export class NativeExecutionStore {
  constructor(private readonly database: Database.Database,
    private readonly onCommit?: (commit: NativeExecutionCommit) => void,
    /** The registered managed-call owner may finish its handoff while another
     * call waits for approval. This must query the same database ownership. */
    private readonly detachedEffectRunning?: (effect: ExecutionEffectRecord) => boolean) {}

  readMessageRecord(threadId: string, recordId: string): ExecutionMessageRecord {
    return this.requireBody(threadId, recordId)
  }

  /** Application identities belong to the immutable response, not just its
   * active batch. They remain available after completion, cancellation or edit. */
  readModelCallIds(threadId: string, recordId: string): string[] {
    const response = this.requireBody(threadId, recordId)
    const rows = this.database.prepare('SELECT call_index,call_id FROM execution_model_calls WHERE thread_id=? AND record_id=? ORDER BY call_index')
      .all(threadId, recordId) as { call_index: number; call_id: string }[]
    if (response.value.kind !== 'assistant' || rows.length !== (response.value.calls?.length ?? 0)
      || rows.some((row, index) => row.call_index !== index || !row.call_id)) throw new Error('Model response has no complete application call identities.')
    return rows.map(row => row.call_id)
  }

  private retainModelCallIds(threadId: string, response: ExecutionMessageRecord, calls: readonly ExecutionToolCall[]): void {
    if (!calls.length) return
    const existing = this.database.prepare('SELECT 1 FROM execution_model_calls WHERE thread_id=? AND record_id=?').get(threadId, response.recordId)
    if (existing) {
      if (!isDeepStrictEqual(this.readModelCallIds(threadId, response.recordId), calls.map(call => call.id))) throw new Error('Model response application call identities changed.')
      return
    }
    const insert = this.database.prepare('INSERT INTO execution_model_calls(thread_id,record_id,call_index,call_id) VALUES (?,?,?,?)')
    calls.forEach((call, index) => insert.run(threadId, response.recordId, index, call.id))
  }

  /** A history edit has no owning run. Import it without inventing completion
   * or consuming the separately saved replacement input. */
  installHistory(snapshot: NativeHistorySnapshot): void {
    this.database.transaction(() => {
      if (!snapshot.threadId || !snapshot.revisionId
        || new Set(snapshot.messages.map(message => message.id)).size !== snapshot.messages.length) throw new Error('Invalid history snapshot identity or ordering.')
      const { summary } = snapshot
      const context: ExecutionContext = { modelCalls: 0, todos: [], ...(summary ? { summary: summary.reference } : {}) }
      const encoded = encodeExecutionValue(contextValue(context))
      if (summary && (summary.reference.messageRecordId !== summary.record.recordId
        || summary.reference.cutoffIndex > snapshot.messages.length || summary.record.value.kind !== 'user'
        || !summary.record.value.context?.summary || summary.record.value.context.summaryId !== summary.reference.id)) {
        throw new Error('The summary does not belong to the imported history.')
      }
      const records = [...snapshot.messages, ...(summary ? [summary.record] : [])]
      const bodies = records.map(record => {
        const body = this.prepareBody(record)
        if (body.recordId !== record.recordId) throw new Error('History snapshot body identity changed.')
        return body
      })
      const expected = { revisionId: snapshot.revisionId, messages: snapshot.messages, context }
      const existing = this.head(snapshot.threadId)
      if (existing) {
        if (existing.phase !== 'idle' || !isDeepStrictEqual(this.readHistory(snapshot.threadId), expected)
          || existing.response_record_id !== null || readApprovals(existing.approvals_value).length || this.callRows(snapshot.threadId).length) {
          throw new Error('History snapshot target has already changed.')
        }
      } else {
        for (const body of bodies) this.insertBody(snapshot.threadId, body)
        this.database.prepare(`INSERT INTO execution_state(thread_id,run_id,revision_id,phase,context_value,approvals_value)
          VALUES (?,NULL,?,'idle',?,?)`).run(snapshot.threadId, snapshot.revisionId, encoded, encodeExecutionValue([]))
        this.appendRecords(snapshot.threadId, snapshot.messages)
      }
      if (!isDeepStrictEqual(this.readHistory(snapshot.threadId), expected)) throw new Error('History snapshot did not retain the converted facts.')
      for (const record of records) if (!isDeepStrictEqual(this.requireBody(snapshot.threadId, record.recordId), record)) {
        throw new Error('History snapshot target body differs.')
      }
    })()
  }

  /** Inspect the current failure boundary without decoding the conversation bodies. */
  currentModelFailure(threadId: string, runId: string): boolean | undefined {
    const head = this.head(threadId)
    if (!head || head.phase === 'idle' || head.run_id !== runId) return undefined
    return head.phase === 'failed' && (readContext(head.context_value).modelRequestFailed ?? head.response_record_id === null)
  }

  /** Read execution metadata without materializing conversation or tool-result bodies. */
  readHead(threadId: string) {
    const row = this.head(threadId)
    return row && { threadId, runId: row.run_id, revisionId: row.revision_id, phase: row.phase,
      context: readContext(row.context_value), approvals: readApprovals(row.approvals_value), responseRecordId: row.response_record_id }
  }

  load(threadId: string): ExecutionState | undefined {
    return this.database.transaction(() => {
      const row = this.head(threadId)
      if (!row || row.phase === 'idle') return undefined
      const messages = this.historyMessages(threadId)
      const calls = this.callRows(threadId).map(call => {
        const value = readCall(call.call_value)
        if (call.prepared === 1 && !call.result_record_id) requireObjectToolCall(value)
        if (value.id !== call.call_id) throw new Error('Execution call identity does not match its body.')
        return { ...value, index: call.call_index, prepared: call.prepared === 1,
          ...(call.result_update_value ? { resultUpdate: this.readToolStateUpdate(call.result_update_value) } : {}),
          ...(call.result_record_id ? { result: this.requireBody(threadId, call.result_record_id) } : {}) }
      })
      return { threadId, runId: row.run_id, revisionId: row.revision_id, phase: row.phase,
        context: readContext(row.context_value), messages, calls, approvals: readApprovals(row.approvals_value),
        ...(row.response_record_id ? { response: this.requireBody(threadId, row.response_record_id) } : {}) }
    })()
  }

  /** History remains authoritative even after its last run is removed. There
   * is no synthetic completed run or second copy of the conversation. */
  readHistory(threadId: string) {
    return this.database.transaction(() => {
      const row = this.head(threadId)
      return row ? { revisionId: row.revision_id, messages: this.historyMessages(threadId), context: readContext(row.context_value) } : undefined
    })()
  }

  /** Bounded body reads for context previews. The caller checks the head
   * revision across batches before publishing an asynchronously built result. */
  readHistoryRange(threadId: string, startIndex: number, limit: number): ExecutionMessageRecord[] {
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Invalid history read range.')
    }
    return (this.database.prepare(`SELECT m.record_id,m.message_id,b.value FROM execution_messages m
      LEFT JOIN execution_message_bodies b ON b.thread_id=m.thread_id AND b.record_id=m.record_id
      WHERE m.thread_id=? AND m.position>=? ORDER BY m.position LIMIT ?`).all(threadId, startIndex, limit) as BodyRow[])
      .map(body => this.readBody(body))
  }

  /** The product owner supplies its exact activity/history/task references in
   * the same transaction. Never collect while a conversion is still staging
   * bodies or before all owners have published their references. */
  collectBodies(threadId: string, productRecordIds: readonly string[]): number {
    if (!this.database.inTransaction) throw new Error('Body collection requires the owning product transaction.')
    const head = this.head(threadId), summary = head && readContext(head.context_value).summary
    const roots = [...productRecordIds, ...(head?.response_record_id == null ? [] : [head.response_record_id]),
      ...(summary ? [summary.messageRecordId] : [])]
    if (roots.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid retained message body reference.')
    const references = `WITH retained(record_id) AS (
      SELECT record_id FROM execution_messages WHERE thread_id=@threadId
      UNION SELECT result_record_id FROM execution_calls WHERE thread_id=@threadId AND result_record_id IS NOT NULL
      UNION SELECT result_record_id FROM execution_effects WHERE thread_id=@threadId AND result_record_id IS NOT NULL
      UNION SELECT value FROM json_each(@roots)
    )`
    const parameters = { threadId, roots: JSON.stringify(roots) }
    const missing = this.database.prepare(`${references} SELECT retained.record_id FROM retained
      LEFT JOIN execution_message_bodies body ON body.thread_id=@threadId AND body.record_id=retained.record_id
      WHERE body.record_id IS NULL LIMIT 1`).get(parameters) as { record_id: string } | undefined
    if (missing) throw new Error(`Retained execution message body ${missing.record_id} is missing.`)
    return this.database.prepare(`${references} DELETE FROM execution_message_bodies
      WHERE thread_id=@threadId AND record_id NOT IN (SELECT record_id FROM retained)`).run(parameters).changes
  }

  /** Low-level history replacement. The product owner must call this inside
   * its transaction with run/resource cleanup and message-index publication. */
  reviseHistory(input: { threadId: string; expectedRevisionId: string; retainedCount: number; summary?: ExecutionContext['summary'] }): string {
    if (!this.database.inTransaction) throw new Error('History revision requires the owning product transaction.')
    return this.database.transaction(() => {
      const head = this.head(input.threadId)
      if (!head || head.revision_id !== input.expectedRevisionId) throw new Error('Conversation history changed before the revision could be committed.')
      if (!['idle', 'completed', 'cancelled', 'failed'].includes(head.phase)) throw new Error('Conversation execution is still active.')
      const count = this.messageCount(input.threadId)
      if (!Number.isSafeInteger(input.retainedCount) || input.retainedCount < 0 || input.retainedCount > count) throw new Error('Invalid conversation history revision boundary.')
      const saved = readContext(head.context_value)
      const retainedIds = new Set(saved.modelFailureBoundaries ? (this.database.prepare('SELECT message_id FROM execution_messages WHERE thread_id=? AND position<?')
        .all(input.threadId, input.retainedCount) as { message_id: string }[]).map(row => row.message_id) : [])
      const boundaries = Object.fromEntries(Object.entries(saved.modelFailureBoundaries ?? {}).filter(([, value]) => retainedIds.has(value.messageId)))
      const context: ExecutionContext = { modelCalls: 0, todos: [], ...(Object.keys(boundaries).length ? { modelFailureBoundaries: boundaries } : {}), ...(input.summary ? { summary: input.summary } : {}) }
      if (input.summary) {
        const body = this.requireBody(input.threadId, input.summary.messageRecordId)
        if (input.summary.cutoffIndex > input.retainedCount || body.value.kind !== 'user' || !body.value.context?.summary
          || body.value.context.summaryId !== input.summary.id) throw new Error('The summary does not belong to the retained history.')
      }
      const encoded = encodeExecutionValue(contextValue(context)), revisionId = randomUUID()
      this.database.prepare('DELETE FROM execution_messages WHERE thread_id=? AND position>=?').run(input.threadId, input.retainedCount)
      this.database.prepare('DELETE FROM execution_calls WHERE thread_id=?').run(input.threadId)
      this.database.prepare(`UPDATE execution_state SET run_id=NULL,revision_id=?,phase='idle',context_value=?,approvals_value=?,response_record_id=NULL WHERE thread_id=?`)
        .run(revisionId, encoded, encodeExecutionValue([]), input.threadId)
      return revisionId
    })()
  }

  start(input: { threadId: string; runId: string; expectedRevisionId?: string; messages: ExecutionMessageInput[]; context: ExecutionContext }): string {
    return this.database.transaction(() => {
      if (!input.threadId || !input.runId) throw new Error('Execution requires a conversation and run identity.')
      const current = this.head(input.threadId)
      if (current?.revision_id !== input.expectedRevisionId) throw new Error('Conversation revision changed before input could be accepted.')
      if (current && !['idle', 'completed', 'cancelled', 'failed'].includes(current.phase)) throw new Error('Conversation execution is still active.')
      const revisionId = randomUUID()
      this.database.prepare(`INSERT INTO execution_state(thread_id,run_id,revision_id,phase,context_value,approvals_value)
        VALUES (?,?,?,'prepare_model',?,?) ON CONFLICT(thread_id) DO UPDATE SET run_id=excluded.run_id,
        revision_id=excluded.revision_id,phase=excluded.phase,context_value=excluded.context_value,approvals_value=excluded.approvals_value,response_record_id=NULL`)
        .run(input.threadId, input.runId, revisionId, encodeExecutionValue(contextValue({ ...input.context, modelRequestFailed: undefined, modelRecovery: undefined })), encodeExecutionValue([]))
      const records = this.append(input.threadId, input.messages)
      this.onCommit?.({ threadId: input.threadId, runId: input.runId, revisionId, phase: 'prepare_model', inputAccepted: true, messageRecords: records })
      return revisionId
    })()
  }

  acceptModel(scope: ExecutionCommitScope, response: ExecutionMessageInput, calls: ExecutionToolCall[], context: ExecutionContext,
    summary?: ManualContextCompression & { id: string }): string {
    return this.mutate(scope, ['prepare_model'], () => {
      if (response.value.kind !== 'assistant' && response.value.kind !== 'custom') throw new Error('A model response must be an assistant or provider role message.')
      if (response.value.partial) throw new Error('An incomplete model response cannot create an executable batch.')
      const requested = response.value.calls ?? []
      if (requested.length !== calls.length || calls.some((call, index) => call.name !== requested[index].name
        || call.providerCallId !== requested[index].id || !isDeepStrictEqual(call.args, requested[index].args))) {
        throw new Error('Executable calls must match the complete model response in order.')
      }
      const priorCount = this.messageCount(scope.threadId)
      const records = this.append(scope.threadId, [response])
      this.retainModelCallIds(scope.threadId, records[0], calls)
      const insert = this.database.prepare('INSERT INTO execution_calls(thread_id,call_id,call_index,call_value) VALUES (?,?,?,?)')
      calls.forEach((call, index) => insert.run(scope.threadId, call.id, index, encodeExecutionValue(callValue(call))))
      const completedSummary = summary ? this.persistSummary(scope.threadId, summary, priorCount) : undefined
      const committedContext = completedSummary ? { ...context, summary: { id: summary!.id,
        messageRecordId: completedSummary.recordId, cutoffIndex: summary!.cutoffIndex } } : context
      this.database.prepare('UPDATE execution_state SET context_value=?,response_record_id=? WHERE thread_id=?')
        .run(encodeExecutionValue(contextValue(committedContext)), records[0].recordId, scope.threadId)
      return { phase: calls.length ? 'tools' : 'model_result', records: [...records, ...(completedSummary ? [completedSummary] : [])],
        ...(summary ? { summary: decodeExecutionValue(encodeExecutionValue(summary)) as typeof summary } : {}) }
    })
  }

  /** Review/background supervision may require another request after a model
   * answer. A durable answer alone must never trigger another model call. */
  continueAfterModel(scope: ExecutionCommitScope, messages: ExecutionMessageInput[], context: ExecutionContext): string {
    return this.mutate(scope, ['model_result'], () => {
      this.database.prepare('UPDATE execution_state SET context_value=?,response_record_id=NULL WHERE thread_id=?')
        .run(encodeExecutionValue(contextValue(context)), scope.threadId)
      return { phase: 'prepare_model', records: this.append(scope.threadId, messages) }
    })
  }

  prepareTools(scope: ExecutionCommitScope, preparation: ExecutionToolPreparation[], approvals: ExecutionApproval[] = [], context?: ExecutionContext): string {
    return this.mutate(scope, ['tools'], () => {
      const head = this.requireRun(scope), calls = this.callRows(scope.threadId)
      const pending = calls.filter(call => !call.prepared && !call.result_record_id)
      if (!pending.length || pending.length !== preparation.length || new Set(preparation.map(item => item.callId)).size !== pending.length
        || preparation.some(item => !pending.some(call => call.call_id === item.callId))) throw new Error('Preflight must cover the entire unprepared batch exactly once.')
      if (!head.response_record_id) throw new Error('A tool batch has no owning model response.')
      const response = this.requireBody(scope.threadId, head.response_record_id), updated = { ...response.value, calls: response.value.calls?.map(call => ({ ...call })) }
      const records: ExecutionMessageRecord[] = []
      for (const item of preparation) {
        const row = pending.find(call => call.call_id === item.callId)!, original = readCall(row.call_value)
        if (this.loadEffect({ ...scope, callId: item.callId })) throw new Error('Preflight cannot rewrite an existing effect intent.')
        const value: ExecutionToolCall = { ...original, args: item.args, authorization: item.authorization }
        if (!item.result) requireObjectToolCall(value)
        if (!updated.calls?.[row.call_index]) throw new Error('The tool batch does not match its model response.')
        updated.calls[row.call_index].args = item.args
        let resultRecordId: string | null = null
        if (item.result) {
          if (item.result.value.kind !== 'tool' || item.result.value.resultFor !== (value.providerCallId ?? value.id)) throw new Error('The preflight result does not answer this call.')
          const body = this.prepareBody(item.result)
          this.insertBody(scope.threadId, body)
          resultRecordId = body.recordId
          records.push(this.requireBody(scope.threadId, body.recordId))
        }
        this.database.prepare('UPDATE execution_calls SET call_value=?,prepared=1,result_record_id=? WHERE thread_id=? AND call_id=?')
          .run(encodeExecutionValue(callValue(value)), resultRecordId, scope.threadId, item.callId)
      }
      validApprovals(approvals)
      for (const approval of approvals) {
        if (approval.kind !== 'tool') throw new Error('Preflight can only create ordinary tool approvals.')
        for (const [index, id] of approval.callIds.entries()) {
          const preparedCall = this.callRows(scope.threadId).find(call => call.call_id === id)
          const call = preparedCall && readCall(preparedCall.call_value), action = approval.request.actionRequests[index]
          if (!call || action.name !== call.name || canonicalToolEffectJson(action.args) !== canonicalToolEffectJson(call.args)) {
            throw new Error('The approval request does not match the prepared tool arguments.')
          }
        }
      }
      const awaiting = new Set(approvals.flatMap(approval => approval.callIds))
      const prepared = this.callRows(scope.threadId)
      for (const id of awaiting) if (!prepared.some(call => call.call_id === id && !call.result_record_id)) throw new Error('Approval must belong to unanswered calls in the active batch.')
      for (const call of prepared) {
        if (!call.result_record_id && (readCall(call.call_value).authorization?.approval === 'pending') !== awaiting.has(call.call_id)) {
          throw new Error('Pending tool grants must match the saved approval request.')
        }
      }
      const body = this.prepareBody({ id: response.id, value: updated })
      this.insertBody(scope.threadId, body)
      this.retainModelCallIds(scope.threadId, this.requireBody(scope.threadId, body.recordId), prepared.map(call => readCall(call.call_value)))
      const replaced = this.database.prepare('UPDATE execution_messages SET record_id=? WHERE thread_id=? AND record_id=?')
        .run(body.recordId, scope.threadId, response.recordId)
      if (replaced.changes !== 1) throw new Error('The tool batch response no longer belongs to current history.')
      this.database.prepare('UPDATE execution_state SET response_record_id=?,approvals_value=? WHERE thread_id=?')
        .run(body.recordId, encodeExecutionValue(approvalsValue(approvals)), scope.threadId)
      if (context) this.database.prepare('UPDATE execution_state SET context_value=? WHERE thread_id=?').run(encodeExecutionValue(contextValue(context)), scope.threadId)
      return { phase: approvals.length ? 'waiting' : 'tools', records: [this.requireBody(scope.threadId, body.recordId), ...records],
        ...(body.recordId !== response.recordId ? { previousResponseRecordId: response.recordId } : {}) }
    })
  }

  /** Called by resolveWait's synchronous decision callback, in its transaction. */
  grantToolApprovals(scope: ExecutionCommitScope, callIds: readonly string[]): void {
    const head = this.requireRun(scope)
    if (!this.database.inTransaction || head.phase !== 'waiting' || head.revision_id !== scope.expectedRevisionId) throw new Error('Tool grants require the matching approval transaction.')
    const pending = new Set(readApprovals(head.approvals_value).filter(approval => approval.kind === 'tool').flatMap(approval => approval.callIds))
    if (new Set(callIds).size !== callIds.length || callIds.some(id => !pending.has(id))) throw new Error('The grant does not belong to this tool approval.')
    for (const id of callIds) {
      const row = this.callRows(scope.threadId).find(call => call.call_id === id)!
      const call = readCall(row.call_value)
      if (row.result_record_id || !row.prepared || call.authorization?.approval !== 'pending') throw new Error('The tool approval is no longer pending.')
      const authorization = { ...call.authorization, approval: 'granted' as const,
        ...(call.authorization.patch ? { patch: { ...call.authorization.patch, humanApproved: true } } : {}),
        ...(call.authorization.shell ? { shell: { ...call.authorization.shell, humanApproved: true } } : {}) }
      this.database.prepare('UPDATE execution_calls SET call_value=? WHERE thread_id=? AND call_id=?')
        .run(encodeExecutionValue(callValue({ ...call, authorization })), scope.threadId, id)
    }
  }

  commitSummary(scope: ExecutionCommitScope, summary: ManualContextCompression & { id: string },
    options: { sessionId?: string; completeRun?: boolean } = {}): string {
    return this.mutate(scope, ['prepare_model'], () => {
      const current = readContext(this.requireRun(scope).context_value)
      const body = this.persistSummary(scope.threadId, summary, this.messageCount(scope.threadId))
      current.summary = { id: summary.id, messageRecordId: body.recordId, cutoffIndex: summary.cutoffIndex,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) }
      if (options.completeRun) delete current.modelRecovery
      this.database.prepare('UPDATE execution_state SET context_value=? WHERE thread_id=?').run(encodeExecutionValue(contextValue(current)), scope.threadId)
      return { phase: options.completeRun ? 'completed' : 'prepare_model',
        records: [this.requireBody(scope.threadId, body.recordId)], summary: decodeExecutionValue(encodeExecutionValue(summary)) as ManualContextCompression & { id: string } }
    })
  }

  /** A result can commit while a sibling has already suspended the batch. */
  settleCall(scope: Omit<ExecutionCommitScope, 'expectedRevisionId'>, callId: string, result: ExecutionMessageInput, update?: ExecutionToolStateUpdate): string {
    return this.database.transaction(() => {
      const head = this.requireRun(scope)
      if (head.phase !== 'tools' && head.phase !== 'waiting' && head.phase !== 'waiting_context') throw new Error('No tool batch is accepting results.')
      const call = this.callRows(scope.threadId).find(value => value.call_id === callId)
      if (!call) throw new Error(`Tool call ${callId} does not belong to the active batch.`)
      const value = readCall(call.call_value)
      if (result.value.kind !== 'tool' || result.value.resultFor !== (value.providerCallId ?? value.id)) {
        throw new Error('The tool result does not answer this call.')
      }
      const prepared = this.prepareBody(result)
      const updateBytes = update === undefined ? null : encodeExecutionValue(update)
      if (updateBytes) this.readToolStateUpdate(updateBytes)
      if (call.result_record_id) {
        if (call.result_record_id !== prepared.recordId || Boolean(updateBytes) !== Boolean(call.result_update_value)
          || updateBytes && !Buffer.from(updateBytes).equals(Buffer.from(call.result_update_value!))) throw new Error('A saved tool result cannot be replaced by another result.')
        return head.revision_id
      }
      this.insertBody(scope.threadId, prepared)
      this.database.prepare('UPDATE execution_calls SET result_record_id=?,result_update_value=? WHERE thread_id=? AND call_id=?')
        .run(prepared.recordId, updateBytes, scope.threadId, callId)
      if (updateBytes) {
        const context = { ...readContext(head.context_value), ...this.readToolStateUpdate(updateBytes) }
        this.database.prepare('UPDATE execution_state SET context_value=? WHERE thread_id=?').run(encodeExecutionValue(contextValue(context)), scope.threadId)
      }
      return this.publish(scope, head.phase, [this.readBody({ record_id: prepared.recordId, message_id: result.id, value: prepared.bytes })])
    })()
  }

  prepareContext(scope: ExecutionCommitScope, context: ExecutionContext): string {
    return this.mutate(scope, ['prepare_model'], () => {
      if (context.rulePreparation && context.rulePreparation.runId !== scope.runId) throw new Error('Rule preparation belongs to another run.')
      this.database.prepare('UPDATE execution_state SET context_value=? WHERE thread_id=?').run(encodeExecutionValue(contextValue(context)), scope.threadId)
      return { phase: 'prepare_model', records: [] }
    })
  }

  wait(scope: ExecutionCommitScope, approvals: ExecutionApproval[]): string {
    return this.mutate(scope, ['tools', 'waiting'], () => {
      if (!approvals.length) throw new Error('Waiting requires a pending decision.')
      validApprovals(approvals)
      const calls = this.callRows(scope.threadId)
      for (const approval of approvals) {
        if (!approval.generation || !approval.callIds.length || approval.callIds.some(id => !calls.some(call => call.call_id === id && !call.result_record_id))) {
          throw new Error('Approval must belong to unanswered calls in the active batch.')
        }
        if (approval.kind === 'subagent') {
          const call = readCall(calls.find(call => call.call_id === approval.callIds[0])!.call_value)
          if (call.name !== 'wait_subagent' || requireObjectToolCall(call).args.subagent_id !== approval.subagentId) throw new Error('Subagent approval does not belong to this wait call.')
        }
      }
      this.database.prepare('UPDATE execution_state SET approvals_value=? WHERE thread_id=?')
        .run(encodeExecutionValue(approvalsValue(approvals)), scope.threadId)
      return { phase: 'waiting', records: [] }
    })
  }

  /** Rule discovery can pause before any model/tool dispatch. This is not a
   * model tool call and must never create a synthetic call or result. */
  waitForContext(scope: ExecutionCommitScope, approval: Extract<ExecutionApproval, { kind: 'context_read' }>, context: ExecutionContext): string {
    return this.mutate(scope, ['prepare_model', 'tools'], () => {
      const head = this.requireRun(scope), preparation = context.rulePreparation
      validApprovals([approval])
      if (approval.kind !== 'context_read' || approval.resumePhase !== head.phase || preparation?.runId !== scope.runId
        || context.projectRules?.runId !== scope.runId) throw new Error('Context approval does not belong to this preparation.')
      if (head.phase === 'tools' && !this.callRows(scope.threadId).some(call => !call.prepared && !call.result_record_id)) {
        throw new Error('Context discovery requires an unprepared tool call.')
      }
      const previous = readContext(head.context_value).rulePreparation
      if (canonicalToolEffectJson(preparation.reads) !== canonicalToolEffectJson(previous?.runId === scope.runId ? previous.reads : [])) {
        throw new Error('Context preparation cannot grant read approvals.')
      }
      if (preparation.reads.some(read => read.path === approval.path)) throw new Error('This context read already has a decision.')
      this.database.prepare('UPDATE execution_state SET context_value=?,approvals_value=? WHERE thread_id=?')
        .run(encodeExecutionValue(contextValue(context)), encodeExecutionValue(approvalsValue([approval])), scope.threadId)
      return { phase: 'waiting_context', records: [] }
    })
  }

  resolveContextWait(scope: ExecutionCommitScope, approvalId: string, generation: string, decision: 'approve' | 'reject', consumeIntent?: () => void): string {
    return this.mutate(scope, ['waiting_context'], () => {
      const head = this.requireRun(scope), approvals = readApprovals(head.approvals_value), approval = approvals[0]
      if (approvals.length !== 1 || approval.kind !== 'context_read' || approval.id !== approvalId || approval.generation !== generation) {
        throw new Error('The pending context approval generation changed.')
      }
      if (decision !== 'approve' && decision !== 'reject') throw new Error('Invalid context read decision.')
      const context = readContext(head.context_value), preparation = context.rulePreparation
      if (preparation?.runId !== scope.runId || preparation.reads.some(read => read.path === approval.path)) {
        throw new Error('Context read decision does not match this run.')
      }
      preparation.reads.push({ path: approval.path, approved: decision === 'approve' })
      consumeIntent?.()
      this.database.prepare('UPDATE execution_state SET context_value=?,approvals_value=? WHERE thread_id=?')
        .run(encodeExecutionValue(contextValue(context)), encodeExecutionValue([]), scope.threadId)
      return { phase: approval.resumePhase, records: [] }
    })
  }

  /** The caller validates and applies selected decisions in this transaction.
   * Recovery/child waits may resolve independently; ordinary access approvals
   * still require the complete batch. Never dispatch effects in this callback. */
  resolveWait(scope: ExecutionCommitScope, generations: Readonly<Record<string, string>>, apply: () => void): string {
    return this.mutate(scope, ['waiting'], () => {
      const approvals = readApprovals(this.requireRun(scope).approvals_value)
      const ids = Object.keys(generations)
      if (!ids.length || ids.length > approvals.length || ids.some(id => !approvals.some(value => value.id === id && generations[id] === value.generation))
        || ids.length !== approvals.length && approvals.some(value => value.kind !== 'effect_recovery' && value.kind !== 'subagent')) {
        throw new Error('The pending approval generation changed.')
      }
      apply()
      const remaining = approvals.filter(value => !ids.includes(value.id))
      this.database.prepare('UPDATE execution_state SET approvals_value=? WHERE thread_id=?').run(encodeExecutionValue(approvalsValue(remaining)), scope.threadId)
      return { phase: remaining.length ? 'waiting' : 'tools', records: [] }
    })
  }

  /** Called inside resolveWait so the answer and input consumption commit
   * together. Resuming the child happens afterwards through its owning service. */
  saveSubagentApproval(scope: Omit<ExecutionCommitScope, 'expectedRevisionId'>, approvalId: string,
    decisions: NonNullable<ExecutionToolCall['subagentApproval']>['decisions']): void {
    const head = this.requireRun(scope), approval = readApprovals(head.approvals_value).find(value => value.id === approvalId)
    // resolveWait checks the input revision before applying the batch. A sibling
    // rejection can publish a result inside this transaction and advance it.
    if (!this.database.inTransaction || head.phase !== 'waiting'
      || approval?.kind !== 'subagent') throw new Error('Subagent approval requires the matching waiting transaction.')
    if (!Array.isArray(decisions) || decisions.length !== approval.request.actionRequests.length
      || decisions.some((decision, index) => !decision || !approval.request.reviewConfigs[index].allowedDecisions.includes(decision.type))) {
      throw new Error('Subagent decisions do not match the saved actions.')
    }
    const row = this.callRows(scope.threadId).find(call => call.call_id === approval.callIds[0])
    if (!row || row.result_record_id) throw new Error('The subagent wait has already ended.')
    const call = readCall(row.call_value)
    call.subagentApproval = { subagentId: approval.subagentId, generation: approval.childGeneration, decisions }
    this.database.prepare('UPDATE execution_calls SET call_value=? WHERE thread_id=? AND call_id=?')
      .run(encodeExecutionValue(callValue(call)), scope.threadId, call.id)
  }

  finishBatch(scope: ExecutionCommitScope, directions: ExecutionMessageInput[] = [], response?: ExecutionMessageInput): string {
    return this.mutate(scope, ['tools'], () => {
      const calls = this.callRows(scope.threadId)
      if (!calls.length || calls.some(call => !call.result_record_id)) throw new Error('The tool batch still has unanswered calls.')
      if (response && (directions.length || response.value.kind !== 'assistant' || response.value.partial || response.value.calls?.length)) {
        throw new Error('A completed host response must be a complete assistant answer without new calls or directions.')
      }
      this.appendBatchResults(scope.threadId, calls.map(call => this.requireBody(scope.threadId, call.result_record_id!)))
      this.database.prepare('DELETE FROM execution_calls WHERE thread_id=?').run(scope.threadId)
      const records = this.append(scope.threadId, response ? [response] : directions)
      this.database.prepare('UPDATE execution_state SET response_record_id=? WHERE thread_id=?').run(response ? records[0].recordId : null, scope.threadId)
      return { phase: response ? 'model_result' : 'prepare_model', records }
    })
  }

  finish(scope: ExecutionCommitScope, outcome: 'completed' | 'cancelled' | 'failed', error?: string, options?: { modelRequestFailed?: boolean }): string {
    if (error !== undefined && (outcome !== 'failed' || typeof error !== 'string')) throw new Error('Only a failed run can carry a failure detail.')
    return this.mutate(scope, outcome === 'completed' ? ['prepare_model', 'model_result'] : ['prepare_model', 'model_result', 'tools', 'waiting', 'waiting_context'], () => {
      const head = this.requireRun(scope)
      const context = readContext(head.context_value)
      if (outcome === 'failed') context.modelRequestFailed = options?.modelRequestFailed === true && (head.phase === 'prepare_model'
        || head.phase === 'model_result' && Boolean(head.response_record_id)
          && modelOutputWasTruncated(this.requireBody(scope.threadId, head.response_record_id!).value))
      else delete context.modelRequestFailed
      // Entered operations have been drained by the executor. Preserve every
      // confirmed sibling result even when the remaining work was cancelled.
      const results = this.callRows(scope.threadId).flatMap(call => call.result_record_id ? [this.requireBody(scope.threadId, call.result_record_id)] : [])
      this.appendBatchResults(scope.threadId, results)
      const last = this.database.prepare('SELECT message_id FROM execution_messages WHERE thread_id=? ORDER BY position DESC LIMIT 1').get(scope.threadId) as { message_id: string } | undefined
      if (outcome === 'failed' && last) {
        context.modelFailureBoundaries = { ...context.modelFailureBoundaries, [scope.runId]: { messageId: last.message_id, modelRequestFailed: context.modelRequestFailed! } }
      }
      this.database.prepare('UPDATE execution_state SET context_value=? WHERE thread_id=?')
        .run(encodeExecutionValue(contextValue(context)), scope.threadId)
      this.database.prepare('DELETE FROM execution_calls WHERE thread_id=?').run(scope.threadId)
      this.database.prepare('UPDATE execution_state SET approvals_value=? WHERE thread_id=?').run(encodeExecutionValue([]), scope.threadId)
      return { phase: outcome, records: [], ...(error === undefined ? {} : { error }) }
    })
  }

  retryModel(scope: ExecutionCommitScope, withholdToolResults: boolean): string {
    return this.database.transaction(() => {
      const head = this.head(scope.threadId)
      if (!head || head.revision_id !== scope.expectedRevisionId) throw new Error('The execution revision changed.')
      const history = this.readHistory(scope.threadId)!, state = head.phase === 'idle' ? undefined : this.load(scope.threadId)
      const messages = history.messages.map(record => ({ ...record.value, id: record.id }))
      const savedFailure = history.context.modelFailureBoundaries?.[scope.runId]
      if (state ? state.runId !== scope.runId || !canRetryModelRequest(state)
        : !((savedFailure && savedFailure.messageId === messages.at(-1)?.id
          ? savedFailure.modelRequestFailed : undefined) ?? isCompleteModelInput(messages))) {
        throw new Error('This failure is not a retryable model request.')
      }
      const ids = lastToolResultBatch(messages).filter(id => !messages.find(message => message.id === id)?.context?.resultWithheld)
      if (withholdToolResults && !ids.length) throw new Error('There are no new tool results to withhold.')
      const inputIndex = messages.findIndex(message => message.kind === 'user' && message.context?.runId === scope.runId)
      if (!state && inputIndex < 0) throw new Error('The retained run has no saved input.')
      const context = { ...history.context, modelRequestFailed: false,
        modelRecovery: messages.at(-1) && modelOutputWasTruncated(messages.at(-1)!)
          ? { attempts: 0, retryAt: 0, inFlight: false, reason: 'text_continuation' as const, feedback: 'text_continuation' as const }
          : history.context.modelRecovery ? { ...history.context.modelRecovery, attempts: 0, retryAt: 0, inFlight: false } : undefined,
        // History edits reset context; restore this run's plan and counters without replaying tools.
        ...(!state ? { todos: modelRetryTodos(messages.slice(inputIndex)),
          modelCalls: messages.slice(inputIndex).filter(message => message.kind === 'assistant' && !message.partial).length,
          threadModelCalls: messages.filter(message => message.kind === 'assistant' && !message.partial).length } : {}) }
      const replacements: Record<string, string> = {}, records: ExecutionMessageRecord[] = []
      if (withholdToolResults) for (const original of history.messages.filter(record => ids.includes(record.id))) {
        const body = this.prepareBody({ id: original.id, value: withholdToolResult(original.value) })
        this.insertBody(scope.threadId, body)
        if (this.database.prepare('UPDATE execution_messages SET record_id=? WHERE thread_id=? AND message_id=? AND record_id=?')
          .run(body.recordId, scope.threadId, original.id, original.recordId).changes !== 1) throw new Error('The tool result changed before retry.')
        records.push(this.requireBody(scope.threadId, body.recordId))
        replacements[body.recordId] = original.recordId
      }
      this.database.prepare("UPDATE execution_state SET run_id=?,phase='prepare_model',context_value=?,response_record_id=NULL WHERE thread_id=?")
        .run(scope.runId, encodeExecutionValue(contextValue(context)), scope.threadId)
      return this.publish(scope, 'prepare_model', records, { replacedToolResults: replacements })
    })()
  }

  prepareEffect(key: ExecutionEffectKey, recoveryMode: ToolEffectRecoveryMode): ExecutionEffectRecord {
    return this.database.transaction(() => {
      this.requireActiveEffectRun(key)
      if (recoveryMode !== 'confirm' && recoveryMode !== 'idempotent') throw new Error('Invalid tool effect recovery mode.')
      const callRow = this.callRows(key.threadId).find(call => call.call_id === key.callId)
      if (!callRow) throw new Error('An effect must belong to the active tool batch.')
      const call = readCall(callRow.call_value), argsJson = canonicalToolEffectJson(call.args)
      if (!callRow.prepared || call.authorization?.approval === 'pending') throw new Error('The tool call has not completed preflight and approval.')
      const existing = this.loadEffect(key)
      if (existing) {
        if (existing.toolName !== call.name || existing.providerCallId !== call.providerCallId || existing.argsJson !== argsJson
          || canonicalToolEffectJson(existing.artifacts) !== canonicalToolEffectJson(call.artifacts)) {
          throw new Error('A prepared tool effect changed its immutable call identity.')
        }
        if (existing.state === 'prepared' && existing.effectAttempt === 0 && existing.recoveryMode !== recoveryMode) {
          this.database.prepare('UPDATE execution_effects SET recovery_mode=? WHERE thread_id=? AND run_id=? AND call_id=?')
            .run(recoveryMode, key.threadId, key.runId, key.callId)
        }
      } else {
        if (callRow.result_record_id) throw new Error('A settled call cannot prepare a new effect.')
        this.database.prepare(`INSERT INTO execution_effects(thread_id,run_id,call_id,tool_name,provider_call_id,args_json,resources_value,recovery_mode,state)
          VALUES (?,?,?,?,?,?,?,?,'prepared')`).run(key.threadId, key.runId, key.callId, call.name, call.providerCallId ?? null,
            argsJson, encodeExecutionValue(call.artifacts), recoveryMode)
      }
      return this.requireEffect(key)
    })()
  }

  loadEffect(key: ExecutionEffectKey): ExecutionEffectRecord | undefined {
    const row = this.database.prepare('SELECT * FROM execution_effects WHERE thread_id=? AND run_id=? AND call_id=?')
      .get(key.threadId, key.runId, key.callId) as EffectRow | undefined
    if (!row) return undefined
    const artifacts = decodeExecutionValue(row.resources_value) as ExecutionEffectRecord['artifacts']
    if (!artifacts || toolEffectArtifactPurposes.some(purpose => typeof artifacts[purpose] !== 'string' || !artifacts[purpose])
      || !['prepared', 'intent', 'result'].includes(row.state) || !['confirm', 'idempotent'].includes(row.recovery_mode)
      || [row.effect_attempt, row.confirmation_count, row.automatic_retry_count].some(value => !Number.isSafeInteger(value) || value < 0)
      || row.state === 'result' && !row.result_record_id || row.state === 'intent' && (!row.effect_kind || row.target_json === null)) {
      throw new Error('Invalid persisted execution effect.')
    }
    return { threadId: row.thread_id, runId: row.run_id, callKey: row.call_id, toolName: row.tool_name, argsJson: row.args_json,
      artifacts, recoveryMode: row.recovery_mode, state: row.state, effectAttempt: row.effect_attempt,
      confirmationCount: row.confirmation_count, automaticRetryCount: row.automatic_retry_count,
      ...(row.provider_call_id === null ? {} : { providerCallId: row.provider_call_id }),
      ...(row.effect_kind === null ? {} : { effectKind: row.effect_kind }),
      ...(row.target_json === null ? {} : { targetJson: row.target_json }),
      ...(row.idempotency_fingerprint === null ? {} : { idempotencyFingerprint: row.idempotency_fingerprint }),
      ...(row.result_record_id === null ? {} : { result: this.requireBody(key.threadId, row.result_record_id) }) }
  }

  armEffect(key: ExecutionEffectKey, effect: ToolEffectArm): ExecutionEffectRecord {
    return this.database.transaction(() => {
      const head = this.requireActiveEffectRun(key), phase = head.phase, row = this.requireEffect(key)
      const approvals = phase === 'waiting' ? readApprovals(head.approvals_value) : []
      // Recovery suspends the uncertain call, not siblings already dispatched
      // from the fully authorized batch. Ordinary approval still gates all calls.
      const activeCall = this.callRows(key.threadId).find(call => call.call_id === key.callId)
      const independentRecoverySibling = activeCall?.prepared && !activeCall.result_record_id
        && readCall(activeCall.call_value).authorization?.approval !== 'pending'
        && approvals.length > 0 && approvals.every(approval => (approval.kind === 'effect_recovery' || approval.kind === 'subagent') && !approval.callIds.includes(key.callId))
      if ((phase === 'waiting' || phase === 'waiting_context') && !independentRecoverySibling && !this.detachedEffectRunning?.(row)) {
        throw new Error('Only an owned detached call can arm an effect while waiting, unless it is an authorized independent recovery sibling.')
      }
      if (row.state !== 'prepared') throw new Error(`Cannot arm an effect from ${row.state}.`)
      const kind = effect.kind.trim(), targetJson = canonicalToolEffectJson(effect.target), recoveryMode = effect.recoveryMode ?? row.recoveryMode
      if (!kind || recoveryMode !== 'confirm' && recoveryMode !== 'idempotent'
        || effect.idempotencyFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(effect.idempotencyFingerprint)) throw new Error('Invalid tool effect boundary.')
      if (row.effectAttempt > 0 && (row.effectKind !== kind || row.targetJson !== targetJson || row.recoveryMode !== recoveryMode
        || row.idempotencyFingerprint !== effect.idempotencyFingerprint)) throw new Error('A retry resolved to a different effect boundary.')
      this.database.prepare(`UPDATE execution_effects SET state='intent',effect_kind=?,target_json=?,recovery_mode=?,
        idempotency_fingerprint=?,effect_attempt=effect_attempt+1 WHERE thread_id=? AND run_id=? AND call_id=?`)
        .run(kind, targetJson, recoveryMode, effect.idempotencyFingerprint ?? null, key.threadId, key.runId, key.callId)
      return this.requireEffect(key)
    })()
  }

  discardUnarmedEffect(key: ExecutionEffectKey): boolean {
    return this.database.transaction(() => {
      this.requireActiveEffectRun(key)
      const row = this.loadEffect(key)
      if (!row) return false
      if (row.state !== 'prepared' || row.effectAttempt !== 0) throw new Error('An effect cannot be discarded after its boundary.')
      return this.database.prepare('DELETE FROM execution_effects WHERE thread_id=? AND run_id=? AND call_id=?')
        .run(key.threadId, key.runId, key.callId).changes === 1
    })()
  }

  retryEffect(key: ExecutionEffectKey, retry: { kind: 'automatic'; expectedAutomaticRetryCount: number }
    | { kind: 'approved'; expectedConfirmationCount: number }): ExecutionEffectRecord {
    return this.database.transaction(() => {
      this.requireActiveEffectRun(key)
      const row = this.requireEffect(key)
      if (row.state !== 'intent') throw new Error(`Cannot retry an effect from ${row.state}.`)
      const approved = retry.kind === 'approved', expected = approved ? retry.expectedConfirmationCount : retry.expectedAutomaticRetryCount
      if (!Number.isSafeInteger(expected) || expected < 0 || row.recoveryMode !== (approved ? 'confirm' : 'idempotent')
        || expected !== (approved ? row.confirmationCount : row.automaticRetryCount)) throw new Error('The effect recovery ordinal or mode changed.')
      const column = approved ? 'confirmation_count' : 'automatic_retry_count'
      this.database.prepare(`UPDATE execution_effects SET state='prepared',${column}=${column}+1 WHERE thread_id=? AND run_id=? AND call_id=?`)
        .run(key.threadId, key.runId, key.callId)
      return this.requireEffect(key)
    })()
  }

  saveEffectResult(key: ExecutionEffectKey, result: ExecutionMessageInput,
    confirmation?: { kind: 'rejected'; expectedConfirmationCount: number }): ExecutionEffectRecord {
    return this.database.transaction(() => {
      this.requireActiveEffectRun(key)
      const row = this.requireEffect(key), body = this.prepareBody(result)
      if (result.value.kind !== 'tool' || result.value.resultFor !== (row.providerCallId ?? row.callKey)) throw new Error('An effect result must answer its tool call.')
      if (row.state === 'result') {
        if (row.result!.recordId !== body.recordId || confirmation && row.confirmationCount !== confirmation.expectedConfirmationCount + 1) {
          throw new Error('A saved effect result cannot be replaced.')
        }
        return row
      }
      if (confirmation && (confirmation.kind !== 'rejected' || row.recoveryMode !== 'confirm'
        || !Number.isSafeInteger(confirmation.expectedConfirmationCount) || confirmation.expectedConfirmationCount < 0
        || row.confirmationCount !== confirmation.expectedConfirmationCount)) throw new Error('The effect rejection ordinal or mode changed.')
      this.insertBody(key.threadId, body)
      this.database.prepare(`UPDATE execution_effects SET state='result',result_record_id=?,confirmation_count=confirmation_count+?
        WHERE thread_id=? AND run_id=? AND call_id=?`).run(body.recordId, confirmation ? 1 : 0, key.threadId, key.runId, key.callId)
      return this.requireEffect(key)
    })()
  }

  private requireEffect(key: ExecutionEffectKey): ExecutionEffectRecord {
    const row = this.loadEffect(key)
    if (!row) throw new Error('The tool effect journal entry is missing.')
    return row
  }
  private readToolStateUpdate(bytes: Uint8Array): ExecutionToolStateUpdate {
    const value = decodeExecutionValue(bytes) as ExecutionToolStateUpdate
    if (!value || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'todos')) throw new Error('Invalid tool state update.')
    validContext({ modelCalls: 0, todos: value.todos })
    return value
  }
  messageCount(threadId: string): number {
    return (this.database.prepare('SELECT count(*) AS total FROM execution_messages WHERE thread_id=?').get(threadId) as { total: number }).total
  }
  private persistSummary(threadId: string, summary: ManualContextCompression & { id: string }, count: number): ExecutionMessageRecord {
    if (!summary.id || typeof summary.modelContent !== 'string' || typeof summary.summaryText !== 'string'
      || !Number.isSafeInteger(summary.cutoffIndex) || summary.cutoffIndex < 0 || summary.cutoffIndex > count
      || !Number.isSafeInteger(summary.activatedAfterMessageIndex) || summary.activatedAfterMessageIndex < -1) {
      throw new Error('Invalid summary completion for this conversation.')
    }
    const body = this.prepareBody({ id: summary.id, value: { kind: 'user', content: summary.modelContent,
      context: { summary: true, summaryId: summary.id } } })
    this.insertBody(threadId, body)
    return this.requireBody(threadId, body.recordId)
  }
  private requireActiveEffectRun(key: ExecutionEffectKey): StateRow {
    const row = this.requireRun(key)
    if (['completed', 'cancelled', 'failed'].includes(row.phase)) throw new Error('The effect run is no longer active.')
    return row
  }

  private historyMessages(threadId: string): ExecutionMessageRecord[] {
    return (this.database.prepare(`SELECT m.record_id,m.message_id,b.value FROM execution_messages m
      LEFT JOIN execution_message_bodies b ON b.thread_id=m.thread_id AND b.record_id=m.record_id
      WHERE m.thread_id=? ORDER BY m.position`).all(threadId) as BodyRow[]).map(body => this.readBody(body))
  }
  private head(threadId: string): HistoryRow | undefined {
    return this.database.prepare('SELECT * FROM execution_state WHERE thread_id=?').get(threadId) as HistoryRow | undefined
  }
  private requireRun(scope: { threadId: string; runId: string }): StateRow {
    const row = this.head(scope.threadId)
    if (!row || row.phase === 'idle' || row.run_id !== scope.runId) throw new Error('The run does not own this conversation execution.')
    return row
  }
  private callRows(threadId: string): CallRow[] {
    return this.database.prepare('SELECT * FROM execution_calls WHERE thread_id=? ORDER BY call_index').all(threadId) as CallRow[]
  }
  private readBody(row: BodyRow): ExecutionMessageRecord {
    if (!(row.value instanceof Uint8Array)) throw new Error(`Missing execution message body ${row.record_id}.`)
    if (conversationMessageRecordId(row.message_id, row.value) !== row.record_id) throw new Error('Execution message body does not match its content identity.')
    const value = decodeConversationMessage(row.value)
    if (value.id !== undefined && value.id !== row.message_id) throw new Error('Execution message identity does not match its body.')
    return { id: row.message_id, recordId: row.record_id, value }
  }
  private requireBody(threadId: string, recordId: string): ExecutionMessageRecord {
    const row = this.database.prepare('SELECT * FROM execution_message_bodies WHERE thread_id=? AND record_id=?').get(threadId, recordId) as BodyRow | undefined
    if (!row) throw new Error(`Missing execution message body ${recordId}.`)
    return this.readBody(row)
  }
  private prepareBody(message: ExecutionMessageInput) {
    if (typeof message.id !== 'string' || !message.id) throw new Error('An execution message requires an application identity.')
    if (message.value.id !== undefined && message.value.id !== message.id) throw new Error('Execution message identity does not match its body.')
    const bytes = encodeConversationMessage(message.value)
    return { id: message.id, recordId: conversationMessageRecordId(message.id, bytes), bytes }
  }
  private insertBody(threadId: string, body: ReturnType<NativeExecutionStore['prepareBody']>): void {
    this.database.prepare('INSERT OR IGNORE INTO execution_message_bodies(thread_id,record_id,message_id,value) VALUES (?,?,?,?)')
      .run(threadId, body.recordId, body.id, body.bytes)
  }
  private append(threadId: string, messages: ExecutionMessageInput[]): ExecutionMessageRecord[] {
    const records = messages.map(message => {
      const body = this.prepareBody(message)
      this.insertBody(threadId, body)
      return this.readBody({ record_id: body.recordId, message_id: body.id, value: body.bytes })
    })
    this.appendRecords(threadId, records)
    return records
  }
  private appendRecords(threadId: string, records: ExecutionMessageRecord[]): void {
    let position = (this.database.prepare('SELECT coalesce(max(position)+1,0) AS next FROM execution_messages WHERE thread_id=?').get(threadId) as { next: number }).next
    const insert = this.database.prepare('INSERT INTO execution_messages(thread_id,position,message_id,record_id) VALUES (?,?,?,?)')
    for (const record of records) insert.run(threadId, position++, record.id, record.recordId)
  }
  private appendBatchResults(threadId: string, records: ExecutionMessageRecord[]): void {
    if (!records.length) return
    const responseId = this.head(threadId)?.response_record_id
    const response = this.database.prepare('SELECT position FROM execution_messages WHERE thread_id=? AND record_id=?')
      .get(threadId, responseId) as { position: number } | undefined
    if (!response) throw new Error('The tool batch response is missing from history.')
    const pending = records.filter(record => {
      const published = this.database.prepare('SELECT position,record_id FROM execution_messages WHERE thread_id=? AND message_id=?')
        .get(threadId, record.id) as { position: number; record_id: string } | undefined
      if (!published) return true
      if (published.position <= response.position || published.record_id !== record.recordId) {
        throw new Error('The saved tool result conflicts with conversation history.')
      }
      return false
    })
    this.appendRecords(threadId, pending)
  }
  private publish(scope: { threadId: string; runId: string }, phase: ExecutionPhase, records: ExecutionMessageRecord[],
    details: Pick<NativeExecutionCommit, 'summary' | 'previousResponseRecordId' | 'replacedToolResults' | 'error'> = {}): string {
    const revisionId = randomUUID()
    this.database.prepare('UPDATE execution_state SET revision_id=?,phase=? WHERE thread_id=?').run(revisionId, phase, scope.threadId)
    this.onCommit?.({ ...scope, revisionId, phase, inputAccepted: false, messageRecords: records, ...details })
    return revisionId
  }
  private mutate(scope: ExecutionCommitScope, allowed: ExecutionPhase[], mutation: () => { phase: ExecutionPhase; records: ExecutionMessageRecord[];
    summary?: NativeExecutionCommit['summary']; previousResponseRecordId?: string; error?: string }): string {
    return this.database.transaction(() => {
      const current = this.requireRun(scope)
      if (current.revision_id !== scope.expectedRevisionId) throw new Error('The execution revision changed.')
      if (!allowed.includes(current.phase)) throw new Error(`Cannot apply this transition during ${current.phase}.`)
      const { phase, records, ...details } = mutation()
      return this.publish(scope, phase, records, details)
    })()
  }
}
