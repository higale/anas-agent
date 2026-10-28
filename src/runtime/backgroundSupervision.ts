import { z } from 'zod'

/** Only complete committed calls/results can satisfy a supervision obligation. */
export type SupervisionMessage =
  | { kind: 'calls'; calls: readonly { id?: string; name: string; args: unknown }[] }
  | { kind: 'result'; callId: string; name?: string; content: unknown }

export type ObservedTasks = Record<string, true>
interface ManagedCall { id: string; kind: string; status: string; summary: string }
interface SubagentCall { id: string; agentName: string; status: string; description: string }
const observationToolNames = new Set(['read_call', 'wait_call'])
const supervisionToolNames = new Set(['read_call', 'read_call_output', 'wait_call', 'cancel_call'])
const observationTools = new Set(['read_subagent', 'wait_subagent'])
const supervisionTools = new Set(['read_subagent', 'wait_subagent', 'cancel_subagent'])
const terminalCallStatuses = new Set(['completed', 'failed', 'cancelled', 'uncertain'])
const maximumPromptSummaryChars = 200

interface ObservationRequest {
  name: string
  callId?: string
}

function callLabel(call: ManagedCall): string {
  const summary = call.summary.replaceAll(/\s+/g, ' ').trim().slice(0, maximumPromptSummaryChars)
  return `- ${call.id} (${call.kind}, ${call.status})${summary ? `: ${JSON.stringify(summary)}` : ''}`
}

export function managedCallSupervision(calls: readonly ManagedCall[], toolNames: readonly string[]): string {
  if (!calls.length) return ''
  if (!toolNames.some(name => supervisionToolNames.has(name))) throw new Error('Background call supervision tools are unavailable for this model request.')
  return [
    '<background_call_supervision>',
    'Background calls in this conversation still require a terminal status to be observed:',
    ...calls.map(callLabel),
    'Do not finish the run yet. Use wait_call or read_call until every call reaches a terminal status. Use read_call_output only when the call details are needed; reading output is not required for supervision. If a call is no longer needed, call cancel_call and then observe its terminal status.',
    '</background_call_supervision>'
  ].join('\n')
}

function observationRequest(call: { name?: unknown; args?: unknown }): ObservationRequest | undefined {
  if (typeof call.name !== 'string' || !observationToolNames.has(call.name)) return undefined
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return undefined
  const callId = (call.args as Record<string, unknown>).call_id
  if (typeof callId === 'string' && callId.length > 0) return { name: call.name, callId }
  return call.name === 'read_call' ? { name: call.name } : undefined
}

function terminalCallId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  return result.terminal === true
    && typeof result.call_id === 'string'
    && z.string().uuid().safeParse(result.call_id).success
    && typeof result.status === 'string'
    && terminalCallStatuses.has(result.status)
    && typeof result.output_chars_total === 'number'
    && Number.isSafeInteger(result.output_chars_total)
    && result.output_chars_total >= 0
    ? result.call_id
    : undefined
}

function terminalObservationCallIds(
  request: ObservationRequest,
  message: Extract<SupervisionMessage, { kind: 'result' }>
): string[] {
  if (
    typeof message.content !== 'string'
    || (message.name !== undefined && message.name !== request.name)
  ) return []
  const result = parseRecord(message.content)
  if (!result || result.ok !== true) return []
  if (request.callId) {
    return terminalCallId(result) === request.callId ? [request.callId] : []
  }
  if (!Array.isArray(result.calls)) return []
  return result.calls.flatMap((call) => {
    const callId = terminalCallId(call)
    return callId ? [callId] : []
  })
}

export function observedManagedCalls(
  messages: readonly SupervisionMessage[],
  eligibleCallIds: ReadonlySet<string> | undefined,
  initial: ObservedTasks
): ObservedTasks {
  const calls = new Map<string, ObservationRequest>()
  const observed = new Set(Object.keys(initial).filter((callId) => (
    !eligibleCallIds || eligibleCallIds.has(callId)
  )))
  for (const message of messages) {
    if (message.kind === 'calls') {
      for (const call of message.calls) {
        if (typeof call.id !== 'string' || call.id.length === 0) continue
        const request = observationRequest(call)
        if (request && (
          !request.callId || !eligibleCallIds || eligibleCallIds.has(request.callId)
        )) {
          calls.set(call.id, request)
        }
      }
      continue
    }
    const request = calls.get(message.callId)
    if (!request) continue
    calls.delete(message.callId)
    for (const callId of terminalObservationCallIds(request, message)) {
      if (!eligibleCallIds || eligibleCallIds.has(callId)) observed.add(callId)
    }
  }
  return Object.fromEntries([...observed].map((callId) => [callId, true]))
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

export function observedSubagents(
  messages: readonly SupervisionMessage[],
  eligibleIds: ReadonlySet<string>,
  initial: ObservedTasks
): ObservedTasks {
  const requests = new Map<string, { name: string; subagentId?: string }>()
  const observed = new Set(Object.keys(initial).filter((id) => eligibleIds.has(id)))
  for (const message of messages) {
    if (message.kind === 'calls') {
      for (const call of message.calls) {
        if (typeof call.id !== 'string' || !observationTools.has(call.name)) continue
        if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) continue
        const subagentId = (call.args as Record<string, unknown>).subagent_id
        if (typeof subagentId === 'string' && !eligibleIds.has(subagentId)) continue
        requests.set(call.id, {
          name: call.name,
          ...(typeof subagentId === 'string' ? { subagentId } : {})
        })
      }
      continue
    }
    const request = requests.get(message.callId)
    if (!request || (message.name !== undefined && message.name !== request.name)) continue
    requests.delete(message.callId)
    const result = parseRecord(message.content)
    if (!result || result.ok !== true) continue
    const candidates = request.subagentId
      ? [result]
      : Array.isArray(result.subagents) ? result.subagents : []
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const record = candidate as Record<string, unknown>
      if (
        record.terminal === true
        && typeof record.subagent_id === 'string'
        && (!request.subagentId || record.subagent_id === request.subagentId)
      ) {
        if (eligibleIds.has(record.subagent_id)) observed.add(record.subagent_id)
      }
    }
  }
  return Object.fromEntries([...observed].map((id) => [id, true]))
}

export function sameObservedTasks(left: ObservedTasks, right: ObservedTasks): boolean {
  const leftIds = Object.keys(left)
  const rightIds = Object.keys(right)
  return leftIds.length === rightIds.length && leftIds.every((id) => right[id] === true)
}

/** Acknowledge only completed history evidence, then re-read the authority.
 * No observed task is removed from the retained facts until its owner confirms
 * resolution. An unchanged result does not require another state write. */
export async function reconcileTaskObservations(options: {
  messages: readonly SupervisionMessage[]
  previous: ObservedTasks
  unresolved(): readonly { id: string }[] | Promise<readonly { id: string }[]>
  resolve?(id: string): void | Promise<void>
  observe(messages: readonly SupervisionMessage[], eligible: ReadonlySet<string>, previous: ObservedTasks): ObservedTasks
}): Promise<ObservedTasks | undefined> {
  let unresolved = await options.unresolved()
  const observed = options.observe(options.messages, new Set(unresolved.map(call => call.id)), options.previous)
  const ids = Object.keys(observed)
  if (options.resolve && ids.length) {
    let failure: { reason: unknown } | undefined
    const pending: Promise<void>[] = []
    for (const id of ids) {
      try {
        pending.push(Promise.resolve(options.resolve(id)).catch(reason => { failure ??= { reason } }))
      } catch (reason) {
        failure ??= { reason }
        break
      }
    }
    await Promise.all(pending)
    if (failure) throw failure.reason
    unresolved = await options.unresolved()
  }
  const remaining = new Set(unresolved.map(call => call.id))
  const retained = Object.fromEntries(ids.filter(id => remaining.has(id)).map(id => [id, true])) as ObservedTasks
  return sameObservedTasks(options.previous, retained) ? undefined : retained
}

export function subagentSupervision(calls: readonly SubagentCall[], toolNames: readonly string[]): string {
  if (!calls.length) return ''
  if (!toolNames.some(name => supervisionTools.has(name))) throw new Error('Subagent supervision tools are unavailable for this model request.')
  return [
    '<subagent_supervision>',
    'Background subagents still require a terminal status to be observed:',
    ...calls.map((call) => `- ${call.id} (${call.agentName}, ${call.status}): ${JSON.stringify(call.description.slice(0, 200))}`),
    'Do not finish the run yet. Use wait_subagent or read_subagent until every subagent reaches a terminal status. Cancel a subagent that is no longer needed, then observe its terminal status.',
    '</subagent_supervision>'
  ].join('\n')
}
