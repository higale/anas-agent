import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAiResponses } from '../../providers/openAiResponses'

const traceMocks = vi.hoisted(() => ({
  directory: '',
  runtimeLog: vi.fn()
}))

vi.mock('../config/dataDir', () => ({
  getDeveloperHttpTraceDir: () => traceMocks.directory
}))

vi.mock('../runtimeLogger', () => ({
  runtimeLog: traceMocks.runtimeLog
}))

async function onlyTraceDirectory(): Promise<string> {
  const entries = await readdir(traceMocks.directory)
  expect(entries).toHaveLength(1)
  return join(traceMocks.directory, entries[0])
}

describe('provider HTTP trace', () => {
  beforeEach(async () => {
    traceMocks.directory = await mkdtemp(join(tmpdir(), 'anas-provider-http-trace-'))
    traceMocks.runtimeLog.mockReset()
  })

  afterEach(async () => {
    await rm(traceMocks.directory, { recursive: true, force: true })
  })

  it('records exact request bytes and streaming response bytes without changing the response', async () => {
    const first = new TextEncoder().encode('event: message\ndata: {"text":"hel')
    const second = new TextEncoder().encode('lo"}\n\n')
    const baseFetch = vi.fn(async (request: Request) => {
      expect(await request.clone().text()).toBe('{"messages":["hello"]}')
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first)
          controller.enqueue(second)
          controller.close()
        }
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      })
    }) as typeof fetch
    const { createProviderHttpTraceFetch } = await import('./providerHttpTrace')
    const tracedFetch = createProviderHttpTraceFetch(baseFetch, {
      model: 'model-a',
      protocol: 'openai_responses',
      providerName: 'Provider A',
      requestId: 'run-a',
      requestRole: 'main'
    })

    const response = await tracedFetch('https://provider.example/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer complete-secret',
        'content-type': 'application/json'
      },
      body: '{"messages":["hello"]}'
    })

    expect(await response.text()).toBe('event: message\ndata: {"text":"hello"}\n\n')
    expect(baseFetch).toHaveBeenCalledOnce()
    const directory = await onlyTraceDirectory()
    const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')) as Record<string, unknown>
    const responseMetadata = JSON.parse(await readFile(join(directory, 'response.json'), 'utf8')) as Record<string, unknown>
    expect(request).toMatchObject({
      requestId: 'run-a',
      role: 'main',
      provider: 'Provider A',
      protocol: 'openai_responses',
      model: 'model-a',
      method: 'POST',
      bodyFile: 'request-body.json',
      bodyBytes: 22,
      headers: {
        authorization: 'Bearer complete-secret',
        'content-type': 'application/json'
      }
    })
    expect(await readFile(join(directory, 'request-body.json'), 'utf8')).toBe('{"messages":["hello"]}')
    expect(responseMetadata).toMatchObject({
      status: 200,
      bodyFile: 'response-body.sse',
      captureStatus: 'completed',
      bodyBytes: first.byteLength + second.byteLength
    })
    expect(await readFile(join(directory, 'response-body.sse'), 'utf8'))
      .toBe('event: message\ndata: {"text":"hello"}\n\n')
  })

  it('preserves a provider failure and records its original error', async () => {
    const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    const baseFetch = vi.fn(async () => { throw failure }) as typeof fetch
    const { createProviderHttpTraceFetch } = await import('./providerHttpTrace')
    const tracedFetch = createProviderHttpTraceFetch(baseFetch, {
      model: 'model-b',
      protocol: 'anthropic_messages',
      providerName: 'Provider B'
    })

    await expect(tracedFetch('https://provider.example/v1/messages', { method: 'POST' }))
      .rejects.toBe(failure)
    const directory = await onlyTraceDirectory()
    await expect(readFile(join(directory, 'error.json'), 'utf8')).resolves.toContain('ECONNRESET')
  })

  it.each(['close', 'error'] as const)('records cancellation when aborting a response makes its body %s', async ending => {
    const abort = new AbortController()
    const reason = new Error('Consumer stopped after a parse error')
    const baseFetch = vi.fn(async (request: Request) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial response'))
        request.signal.addEventListener('abort', () => {
          if (ending === 'close') controller.close()
          else controller.error(request.signal.reason)
        }, { once: true })
      }
    }), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
    const { createProviderHttpTraceFetch } = await import('./providerHttpTrace')
    const tracedFetch = createProviderHttpTraceFetch(baseFetch, {
      model: 'fixture', protocol: 'openai_responses', providerName: 'Fixture'
    })
    const response = await tracedFetch('https://provider.example/v1/responses', { signal: abort.signal })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('partial response')
    const pending = reader.read()
    abort.abort(reason)
    if (ending === 'close') await expect(pending).resolves.toMatchObject({ done: true })
    else await expect(pending).rejects.toBe(reason)

    const directory = await onlyTraceDirectory()
    expect(JSON.parse(await readFile(join(directory, 'response.json'), 'utf8'))).toMatchObject({
      captureStatus: 'cancelled', bodyBytes: 16
    })
    expect(await readFile(join(directory, 'response-body.sse'), 'utf8')).toBe('partial response')
  })

  it.each(['complete', 'break', 'consumer_error', 'network_error'] as const)(
    'finishes the HTTP record before SDK cleanup returns (%s)', async ending => {
      const failure = new Error(ending === 'consumer_error' ? 'Consumer could not parse the item' : 'Connection reset')
      const cancel = vi.fn()
      let source!: ReadableStreamDefaultController<Uint8Array>
      const delta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"m","content_index":0,"delta":"Hi"}\n\n'
      const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n'
      const wire = delta + (ending === 'complete' ? completed : '')
      const baseFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller
          controller.enqueue(new TextEncoder().encode(wire))
          if (ending === 'complete') controller.close()
        }, cancel
      }), { headers: { 'content-type': 'text/event-stream' } }))
      const { createProviderHttpTraceFetch } = await import('./providerHttpTrace')
      const provider = new OpenAiResponses({ apiKey: 'fixture', baseURL: 'https://provider.example/v1',
        fetch: createProviderHttpTraceFetch(baseFetch, {
          model: 'fixture', protocol: 'openai_responses', providerName: 'Fixture'
        }) })
      const events: string[] = []
      const consume = async () => {
        for await (const event of provider.stream({ model: 'fixture', input: 'Hello' })) {
          events.push(event.type)
          if (ending === 'break') break
          if (ending === 'consumer_error') throw failure
          if (ending === 'network_error') source.error(failure)
        }
      }
      if (ending.endsWith('_error')) await expect(consume()).rejects.toBe(failure)
      else await consume()

      expect(events).toEqual(ending === 'complete'
        ? ['response.output_text.delta', 'response.completed'] : ['response.output_text.delta'])
      expect(cancel).toHaveBeenCalledTimes(ending === 'break' || ending === 'consumer_error' ? 1 : 0)
      const directory = await onlyTraceDirectory()
      expect(JSON.parse(await readFile(join(directory, 'response.json'), 'utf8'))).toMatchObject({
        captureStatus: ending === 'complete' ? 'completed' : ending === 'network_error' ? 'failed' : 'cancelled',
        bodyBytes: new TextEncoder().encode(wire).byteLength
      })
      expect(await readFile(join(directory, 'response-body.sse'), 'utf8')).toBe(wire)
      expect(traceMocks.runtimeLog).not.toHaveBeenCalled()
    }
  )

  it('streams full provider payloads while bounding diagnostic body files', async () => {
    const baseFetch = vi.fn(async (request: Request) => {
      expect(await request.text()).toBe('123456789')
      return new Response('abcdefghi', {
        headers: { 'content-type': 'text/plain' }
      })
    }) as typeof fetch
    const { createProviderHttpTraceFetch } = await import('./providerHttpTrace')
    const tracedFetch = createProviderHttpTraceFetch(baseFetch, {
      model: 'bounded-model',
      protocol: 'openai_responses',
      providerName: 'Bounded Provider'
    }, {
      maximumBodyBytes: 5
    })

    const response = await tracedFetch('https://provider.example/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '123456789'
    })

    await expect(response.text()).resolves.toBe('abcdefghi')
    const directory = await onlyTraceDirectory()
    const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')) as Record<string, unknown>
    const responseMetadata = JSON.parse(await readFile(join(directory, 'response.json'), 'utf8')) as Record<string, unknown>
    expect(request).toMatchObject({
      captureStatus: 'truncated',
      bodyBytes: 5,
      observedBodyBytes: 9,
      maximumBodyBytes: 5
    })
    expect(await readFile(join(directory, 'request-body.txt'), 'utf8')).toBe('12345')
    expect(responseMetadata).toMatchObject({
      captureStatus: 'truncated',
      bodyBytes: 5,
      observedBodyBytes: 9,
      maximumBodyBytes: 5
    })
    expect(await readFile(join(directory, 'response-body.txt'), 'utf8')).toBe('abcde')
  })

  it('keeps the provider call working when the diagnostic directory cannot be created', async () => {
    const unavailablePath = join(traceMocks.directory, 'not-a-directory')
    await writeFile(unavailablePath, 'occupied', 'utf8')
    traceMocks.directory = unavailablePath
    const baseFetch = vi.fn(async () => new Response('provider-ok')) as typeof fetch
    const { createProviderHttpTraceFetch } = await import('./providerHttpTrace')
    const tracedFetch = createProviderHttpTraceFetch(baseFetch, {
      model: 'model-c',
      protocol: 'openai_chat_completions',
      providerName: 'Provider C'
    })

    await expect((await tracedFetch('https://provider.example/v1/chat/completions')).text())
      .resolves.toBe('provider-ok')
    expect(traceMocks.runtimeLog).toHaveBeenCalledWith(
      'warn',
      'agent-model-http-trace',
      'Failed to start provider HTTP trace.',
      expect.any(Object)
    )
  })
})
