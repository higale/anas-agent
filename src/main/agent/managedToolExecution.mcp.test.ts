import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import { invokeCapability } from '../../runtime/toolInvocation'
import { toolResultMessage } from '../../runtime/toolResultMessage'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { isToolImageBlock } from '../../runtime/conversationHistory'
import { managedCallToolDefinitions } from '../llm/runtimeTools'
import { projectConversationToolImages } from './conversationContext'
import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mcpToolDefinitions } from '../mcpTools'
import { listMcpTools } from '../../mcp/session'

afterEach(() => vi.useRealTimers())
const hasToolImages = (message: ConversationMessage) => message.kind === 'tool' && Array.isArray(message.content) && message.content.some(isToolImageBlock)

it.each(['schema', 'referenced_schema', 'server'])('returns MCP %s argument errors to the model and accepts its correction', async source => {
  const client = new Client({ name: 'anas-test', version: '1.0.0' })
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'lookup',
    inputSchema: source === 'referenced_schema'
      ? { type: 'object', $defs: { selection: { anyOf: [{ type: 'string', enum: ['available'] }, { type: 'number', minimum: 100 }] } },
          properties: { name: { $ref: '#/$defs/selection' } }, required: ['name'] }
      : { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    annotations: { readOnlyHint: true } }] }))
  const received: unknown[] = []
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.arguments?.name
    received.push(name)
    return name === 'available'
      ? { content: [{ type: 'text', text: 'Found available' }] }
      : { isError: true, content: [{ type: 'text', text: 'Unknown name. Choose available.' }] }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const h = nativeCapabilityFixture('mcp-input-errors')
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const [native] = mcpToolDefinitions('test', client, await listMcpTools(client))
    if (source === 'referenced_schema') expect(native.inputSchema).toMatchObject({
      $defs: { selection: { anyOf: [{ type: 'string', enum: ['available'] }, { type: 'number', minimum: 100 }] } },
      properties: { name: { $ref: '#/$defs/selection' } }
    })
    const result = await h.executeCalls([native], [
      [{ id: 'invalid', name: native.name, args: { name: source === 'server' ? 'missing' : 42 } }],
      [{ id: 'corrected', name: native.name, args: { name: 'available' } }]
    ], true)
    const responses = result.messages.filter(message => message.value.kind === 'tool').map(message => message.value)
    expect(responses).toMatchObject([
      { resultFor: 'invalid', resultStatus: 'error' }, { resultFor: 'corrected', resultStatus: 'success' }
    ])
    expect(JSON.stringify(responses[0].content)).toContain(source === 'server' ? 'Unknown name' : 'name')
    expect(JSON.stringify(responses[1].content)).toContain('Found available')
    expect(received).toEqual(source === 'server' ? ['missing', 'available'] : ['available'])
    expect(h.database.runs.store.load(h.thread.id)?.approvals).toEqual([])
  } finally {
    await h.service.waitForIdle()
    await Promise.all([client.close(), server.close()])
    await h.close()
  }
})

it.each([false, true])('keeps MCP identity, cancellation and late image lifetime (standard blocks: %s)', async (useStandardContentBlocks) => {
  const client = new Client({ name: 'anas-test', version: '1.0.0' })
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
  const requests: Array<{ id: string | number; signal: AbortSignal; finish(): void }> = []
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'work',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true } }] }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    requests.push({ id: extra.requestId, signal: extra.signal, finish })
    extra.signal.addEventListener('abort', finish, { once: true })
    const token = request.params._meta?.progressToken
    if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress',
      params: { progressToken: token, progress: 0.5, total: 1 } })
    await done
    extra.signal.removeEventListener('abort', finish)
    return { content: [{ type: 'text', text: 'finished' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }],
      structuredContent: { finished: true } }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const progress = vi.fn()
  const [native] = mcpToolDefinitions('test', client, await listMcpTools(client), { onProgress: progress, imageFormat: useStandardContentBlocks ? 'native' : 'data_url' })
  const h = nativeCapabilityFixture('mcp-test-run'), { service, thread } = h
  vi.useFakeTimers()
  try {
    const managed = h.managed(native, true)
    const args = { text: 'identical' }
    const starts = ['one', 'two'].map((id) => invokeCapability(managed, args, { callId: id }))
    await vi.advanceTimersByTimeAsync(10_000)
    const handles = (await Promise.all(starts)).map((result) => JSON.parse(String(result.content)))
    expect(requests).toHaveLength(2)
    expect(requests[0].id).not.toBe(requests[1].id)
    expect(handles[0].call_id).not.toBe(handles[1].call_id)
    expect(progress).toHaveBeenCalledTimes(2)
    await service.cancel(handles[0].call_id, thread.id)
    expect(requests[0].signal.aborted).toBe(true)
    expect(requests[1].signal.aborted).toBe(false)
    requests[1].finish()
    await vi.advanceTimersByTimeAsync(1)
    const result = await service.readResult(handles[1].call_id, thread.id)
    expect(result?.resultFor).toBe('two')
    expect(result?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: useStandardContentBlocks ? 'image' : 'image_url' })]))
    expect(result?.artifact).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'mcp_structured_content' })]))
    const read = managedCallToolDefinitions({ managedCalls: service, threadId: thread.id })
      .find((tool) => tool.name === 'read_call_output')!
    const retrieve = async (id: string) => toolResultMessage(await invokeCapability(read,
      { summary: 'Inspect captured image', call_id: handles[1].call_id, output_offset: 0, output_length: 1000 }, { callId: id }),
      { name: read.name, callId: id })
    const observed: ConversationMessage = { kind: 'assistant', content: 'The background call has completed' }
    const delivered = await retrieve('read-image')
    expect(projectConversationToolImages([observed, delivered])[1]).toBe(delivered)
    const processed: ConversationMessage = { kind: 'assistant', content: 'Image observed' }
    expect(hasToolImages(projectConversationToolImages([observed, delivered, processed])[1])).toBe(false)
    const reread = await retrieve('read-image-again')
    expect(hasToolImages(projectConversationToolImages([observed, delivered, processed, reread])[3])).toBe(true)
    expect((await service.readResult(handles[1].call_id, thread.id))?.content).toEqual(result?.content)
    await expect(client.ping()).resolves.toBeDefined()
  } finally {
    for (const request of requests) request.finish()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([client.close(), server.close()])
    await h.close()
  }
})
