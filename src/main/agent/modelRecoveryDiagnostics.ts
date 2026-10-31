import { runtimeLog } from '../runtimeLogger'
import { errorCauses } from '../../runtime/errors'
import { modelFailureEvidence, type ModelRecoveryEvent } from '../../runtime/modelRecoveryDiagnostics'

const maximumString = 3600
function diagnostic(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (typeof value === 'string') {
    if (value.length <= maximumString) return value
    return { head: value.slice(0, maximumString / 2), tail: value.slice(-maximumString / 2),
      characters: value.length, truncated: true }
  }
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value
  if (seen.has(value)) return '[circular]'
  if (depth >= 8) return '[depth limit]'
  seen.add(value)
  const entries = Array.isArray(value) ? value.slice(0, 32).map(item => diagnostic(item, depth + 1, seen))
    : Object.fromEntries(Object.entries(value).slice(0, 48).map(([key, item]) => [key,
      /^(?:authorization|api_?key|password|secret|access_token|refresh_token|cookie|set-cookie)$/i.test(key)
        ? '[redacted]' : diagnostic(item, depth + 1, seen)]))
  seen.delete(value)
  if (Array.isArray(value) && value.length > 32) (entries as unknown[]).push({ omittedItems: value.length - 32 })
  return entries
}

function errorEvidence(error: unknown): unknown {
  const chain = errorCauses(error)
  if (!chain.length) return diagnostic(error)
  return chain.slice(0, 8).map(cause => {
    const fields = cause as Record<string, unknown>, headers = fields.headers as Headers | Record<string, unknown> | undefined
    const header = (name: string) => headers && (typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get(name) : Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1])
    const evidence = modelFailureEvidence(cause)
    return diagnostic({ name: fields.name, message: fields.message, stack: fields.stack, code: fields.code,
      status: fields.status ?? fields.statusCode, requestId: fields.request_id ?? fields.requestID ?? header('x-request-id') ?? header('request-id'),
      // Ordinary file logging limits object depth. Keep bounded response details
      // as text so nested tool arguments survive formatting, including both ends.
      retryAfter: header('retry-after'), evidence: evidence && JSON.stringify(diagnostic(evidence)) })
  })
}

/** Use ordinary application logs, including their configured level and retention. */
export function recordModelRecovery(event: ModelRecoveryEvent): void {
  const { error, ...facts } = event
  const level = event.event === 'exhausted' || event.event === 'manual_rejected' ? 'error'
    : event.event === 'scheduled' ? 'warn' : 'info'
  runtimeLog(level, 'agent-model', `Model recovery: ${event.event}.`, {
    ...diagnostic(facts) as object, ...(error === undefined ? {} : { error: errorEvidence(error) })
  })
}
