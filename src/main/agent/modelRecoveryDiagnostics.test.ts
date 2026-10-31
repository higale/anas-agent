import { beforeEach, expect, it, vi } from 'vitest'
import { runtimeLog } from '../runtimeLogger'
import { annotateModelFailure } from '../../runtime/modelRecoveryDiagnostics'
import { recordModelRecovery } from './modelRecoveryDiagnostics'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

it('logs the retry decision, original error chain, provider identity and request ID through the ordinary logger', () => {
  const cause = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })
  const error = Object.assign(new Error('Provider unavailable', { cause }), {
    status: 503, headers: new Headers({ 'x-request-id': 'provider-request', 'retry-after': '12', authorization: 'secret' })
  })
  annotateModelFailure(error, { providerId: 'provider', model: 'fixture', protocol: 'openai_chat_completions' })
  recordModelRecovery({ event: 'scheduled', threadId: 'thread', runId: 'run', revisionId: 'revision', modelId: 'activity',
    recovery: { attempts: 1, reason: 'server', retryAt: 123 }, maxRetries: 2, delayMs: 12000, error })
  expect(runtimeLog).toHaveBeenCalledWith('warn', 'agent-model', expect.any(String), expect.objectContaining({
    event: 'scheduled', threadId: 'thread', runId: 'run', revisionId: 'revision', modelId: 'activity', delayMs: 12000,
    maxRetries: 2, recovery: { attempts: 1, reason: 'server', retryAt: 123 }, error: [
      expect.objectContaining({ message: 'Provider unavailable', status: 503, requestId: 'provider-request', retryAfter: '12',
        evidence: JSON.stringify({ providerId: 'provider', model: 'fixture', protocol: 'openai_chat_completions' }) }),
      expect.objectContaining({ message: 'Connection reset', code: 'ECONNRESET' })
    ]
  }))
  expect(JSON.stringify(vi.mocked(runtimeLog).mock.calls)).not.toContain('secret')
})

it('retains bounded malformed response evidence without serializing cyclic objects or credential fields', () => {
  const response: Record<string, unknown> = { args: 'start' + 'x'.repeat(10000) + 'end', api_key: 'do-not-log' }
  response.self = response
  const error = annotateModelFailure(new Error('Invalid tool call'), { response })
  recordModelRecovery({ event: 'exhausted', threadId: 'thread', runId: 'run', error })
  const payload = vi.mocked(runtimeLog).mock.calls[0][3] as { error: { evidence: { head: string; tail: string; truncated: boolean } }[] }
  expect(payload.error[0].evidence).toMatchObject({ head: expect.stringContaining('start'), tail: expect.stringContaining('end'), truncated: true })
  expect(payload.error[0].evidence.tail).toContain('[redacted]')
  expect(payload.error[0].evidence.tail).toContain('[circular]')
  expect(JSON.stringify(payload)).not.toContain('do-not-log')
  expect(JSON.stringify(payload).length).toBeLessThan(6500)
  expect(vi.mocked(runtimeLog).mock.calls[0][0]).toBe('error')
})

it.each(['attempt_started', 'response_accepted', 'run_finished', 'manual_requested', 'manual_started'] as const)(
  'keeps %s visible at the default info level', event => {
    recordModelRecovery({ event, threadId: 'thread', runId: 'run', outcome: 'completed' })
    expect(runtimeLog).toHaveBeenCalledWith('info', 'agent-model', expect.any(String), expect.objectContaining({ event, outcome: 'completed' }))
  })
