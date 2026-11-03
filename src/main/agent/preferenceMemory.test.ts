import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryHash, PreferenceMemoryStore } from './preferenceMemoryStore'
import { PreferenceMemoryService, type PreferenceSource, type PreferenceMemoryServices } from './preferenceMemoryService'
import { previewConfig } from '../../test/agentConfigurationFixture'
import type { PreferenceScope } from '../../shared/preferenceMemory'

const roots: string[] = [], services: PreferenceMemoryService[] = []
const globalScope: PreferenceScope = { kind: 'global' }
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-preference-memory-')); roots.push(root)
  mkdirSync(join(root, 'db', 'projects', 'project'), { recursive: true })
  writeFileSync(join(root, 'db', 'projects', 'project', 'project.json'), '{}')
  const store = new PreferenceMemoryStore(root)
  return { root, store }
}
function source(): PreferenceSource { return { threadId: 'thread', projectId: 'project', title: 'Preferences', revision: 'revision', tail: 'assistant-1',
  messages: [{ id: 'user-1', role: 'user', text: '以后请用中文回答。' }, { id: 'assistant-1', role: 'assistant', text: '好的。' }] } }
function background(store: PreferenceMemoryStore, selected: string | null = 'preview-model') {
  const config = previewConfig(); config.settings.memoryModelId = selected
  const sources = vi.fn<PreferenceMemoryServices['sources']>(async () => [source()])
  const generate = vi.fn(async (_model: unknown, prompt: string) => ({ text: prompt.includes('NEW conversation')
    ? JSON.stringify({ candidates: [{ scope: 'global', intent: 'remember', content: '用中文回答。', evidence: '以后请用中文回答。' }] })
    : JSON.stringify({ action: 'replace', content: '- 用中文回答。\n' }) }))
  const current = vi.fn(() => true)
  const loadConfig = vi.fn(async () => config), currentRevision = vi.fn(() => true)
  const service = new PreferenceMemoryService(store, { config: loadConfig, sources: async (...args) => (await sources(...args)).map(item => {
    if (!Array.isArray(item.messages)) return item
    const records = item.messages
    async function* unread() {
      const cursor = store.cursor(item.threadId)
      const start = records.findIndex(message => message.id === cursor) + 1
      yield* records.slice(start)
    }
    return { ...item, tail: records.at(-1)?.id ?? null, messages: unread() }
  }), currentRevision, current, changed() {}, generate })
  services.push(service); service.start()
  return { service, config, loadConfig, sources, generate, current, currentRevision }
}

describe('background preferences', () => {
  it('does not requeue a deleted source after reading its last page', async () => {
    const { store } = fixture(), { service, sources, currentRevision, generate } = background(store)
    async function* messages() {
      yield source().messages[0]
      currentRevision.mockReturnValue(false)
    }
    sources.mockResolvedValue([{ ...source(), messages: messages() }])
    const enqueue = vi.spyOn(store, 'enqueue')
    await service.onConversationSpeech('B')
    expect(enqueue).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })
  it('does not start a scan using settings read before the switch to foreground', async () => {
    const { store } = fixture(), { service, config, loadConfig, sources } = background(store)
    const old = structuredClone(config)
    let finish!: () => void
    loadConfig.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(old) }))
    const scan = service.onConversationSpeech('B')
    await vi.waitFor(() => expect(finish).toBeDefined())
    config.settings.memoryMode = 'foreground'
    service.settingsChanged(config)
    finish()
    await scan
    expect(sources).not.toHaveBeenCalled()
    expect(service.snapshot().status).toBe('foreground')
  })

  it('drops queued evidence and activity when the source chat is deleted, including after restart', () => {
    const { root, store } = fixture()
    store.markDirty('thread')
    const job = store.enqueue({ threadId: 'thread', projectId: 'project', title: 'Removed', sourceRevision: 'rev',
      lastRecordId: 'user', input: 'private source text', trigger: 'conversation_speech' })!
    store.update(job.id, { stage: 'extracting' })
    store.forgetThread('thread')
    expect(store.activity()).toBeUndefined()
    expect(store.jobs()).toEqual([])
    const reopened = new PreferenceMemoryStore(root)
    expect([...reopened.dirtyThreads()]).toEqual([])
    expect(reopened.jobs()).toEqual([])
  })
  it('enumerates a large pending index once while completed rows leave it', () => {
    const { root } = fixture()
    const ids = Array.from({ length: 300 }, (_, i) => 'chat-' + String(i).padStart(3, '0'))
    const store = new PreferenceMemoryStore(root, false, () => ids)
    const visited: string[] = []
    for (const id of store.dirtyThreads()) {
      visited.push(id)
      store.finishScan(id, 'tail')
    }
    expect(visited).toEqual(ids)
    expect([...store.dirtyThreads()]).toEqual([])
  })
  it('retains exhausted failures without starving other conversations or overflowing the job count on reopen', async () => {
    const { store, root } = fixture(), { service, sources, generate } = background(store)
    sources.mockResolvedValueOnce([])
    await service.onConversationSpeech('warm')
    for (let index = 0; index < 101; index++) {
      const job = store.enqueue({ threadId: String(index), projectId: 'project', title: 'Retained', sourceRevision: 'revision',
        lastRecordId: 'u', input: '[]', trigger: 'conversation_speech' })!
      store.update(job.id, { stage: 'failed', attempts: 5, error: 'Bad output' })
    }
    generate.mockResolvedValue({ text: '{"candidates":[]}' })
    await service.onConversationSpeech('B')
    expect(generate).toHaveBeenCalledOnce()
    const reopened = new PreferenceMemoryStore(root)
    expect(reopened.cursor('thread')).toBe('assistant-1')
    expect(reopened.jobs()).toHaveLength(101)
    expect(reopened.jobs().every(job => job.stage === 'failed' && job.error === 'Bad output')).toBe(true)
    expect(reopened.jobs().every(job => !job.input)).toBe(true)
    const restarted = background(reopened)
    await restarted.service.onConversationSpeech('C')
    expect(restarted.generate).not.toHaveBeenCalled()
  })
  it('retries an exhausted batch after a change to the parameters of the same model', async () => {
    const { store, root } = fixture(), { service, generate } = background(store)
    generate.mockRejectedValue(new Error('provider error'))
    await service.onConversationSpeech('B')
    const failed = store.jobs()[0]
    store.update(failed.id, { attempts: 5, retryAt: undefined })
    await service.stop()
    const reopened = new PreferenceMemoryStore(root), next = background(reopened)
    await next.service.onConversationSpeech('C')
    expect(next.generate).not.toHaveBeenCalled()
    next.config.providers[0].models[0].maxOutputTokens += 1
    await next.service.onConversationSpeech('D')
    expect(next.generate).toHaveBeenCalledTimes(2)
    expect(reopened.jobs()).toHaveLength(0)
  })
  it('includes every other eligible chat beyond the durable queue capacity', async () => {
    const { store } = fixture(), { service, sources, generate } = background(store)
    const others = Array.from({ length: 65 }, (_, i) => ({ ...source(), threadId: String(i) }))
    sources.mockResolvedValue([source(), ...others])
    generate.mockResolvedValue({ text: '{"candidates":[]}' })
    await service.onConversationSpeech('thread')
    expect(store.cursor('thread')).toBeNull()
    expect(others.every(other => store.cursor(other.threadId) === 'assistant-1')).toBe(true)
    expect(generate).toHaveBeenCalledTimes(65)
  })
  it('does not publish an in-flight extraction for a chat that becomes the speaking chat', async () => {
    const { store } = fixture(), { service, generate } = background(store)
    let finish!: (value: { text: string }) => void
    generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const scanning = service.onConversationSpeech('B')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const switched = service.onConversationSpeech('thread')
    finish({ text: '{"candidates":[]}' })
    await Promise.all([scanning, switched])
    expect(store.cursor('thread')).toBeNull()
    expect(store.jobs()[0].stage).toBe('pending')
  })
  it('reports oversized user evidence and still processes following preferences exactly once', async () => {
    const { store } = fixture(), { service, sources, generate } = background(store)
    const oversized = { id: 'long-user', role: 'user' as const, text: '界'.repeat(21_000) }
    sources.mockResolvedValue([{ ...source(), messages: [oversized, ...source().messages] }])
    await service.onConversationSpeech('B')
    expect(store.read(globalScope).content).toBe('- 用中文回答。\n')
    expect(store.cursor('thread')).toBe('assistant-1')
    expect(service.snapshot().error).toContain(oversized.id)
    expect(generate.mock.calls[0][1]).not.toContain(oversized.text)
    await service.onConversationSpeech('C')
    expect(generate).toHaveBeenCalledTimes(2)
    expect(service.snapshot().error).toBeUndefined()
  })
  it('stops consuming filtered messages when the selected model is cleared mid-batch', async () => {
    const { store } = fixture(), { service, config, sources, generate } = background(store)
    let consumed = 0
    async function* messages() {
      yield source().messages[0]
      config.settings.memoryModelId = null
      service.settingsChanged()
      await Promise.resolve()
      for (let i = 0; i < 5000; i++) {
        consumed++
        yield { id: String(i), role: 'assistant' as const, text: '' }
      }
    }
    sources.mockResolvedValue([{ ...source(), messages: messages() }])
    await service.onConversationSpeech('B')
    expect(consumed).toBe(1)
    expect(generate).not.toHaveBeenCalled()
    expect(store.cursor('thread')).toBeNull()
    expect(service.snapshot().status).toBe('unconfigured')
  })
  it('drains multiple batches of one old conversation after a single new chat', async () => {
    const { store } = fixture(), { service, sources, generate } = background(store)
    const messages = ['one', 'two'].map(id => ({ id, role: 'user' as const, text: id.repeat(12_000) }))
    sources.mockResolvedValue([{ ...source(), messages }])
    generate.mockResolvedValue({ text: '{"candidates":[]}' })
    await service.onConversationSpeech('new')
    expect(generate).toHaveBeenCalledTimes(2)
    expect(store.cursor('thread')).toBe('two')
    await service.onConversationSpeech('next')
    expect(generate).toHaveBeenCalledTimes(2)
  })
  it('replaces a stale queued revision with fresh evidence in the same check', async () => {
    const { store } = fixture(), { service, current, generate } = background(store)
    store.enqueue({ threadId: 'thread', projectId: 'project', title: '', sourceRevision: 'stale', lastRecordId: 'obsolete', input: '[]', trigger: 'new_conversation' })
    current.mockReturnValueOnce(false)
    await service.onConversationSpeech('new')
    expect(generate).toHaveBeenCalledTimes(2)
    expect(store.cursor('thread')).toBe('assistant-1')
    expect(store.jobs()).toHaveLength(0)
  })
  it('defers a changed conversation between batches and retains the first acknowledgement', async () => {
    const { store } = fixture(), { service, current, sources, generate } = background(store)
    const messages = ['one', 'two'].map(id => ({ id, role: 'user' as const, text: id.repeat(12_000) }))
    sources.mockResolvedValue([{ ...source(), messages }])
    const unsubscribe = store.onChanged(() => {
      if (store.cursor('thread') === 'one') current.mockReturnValue(false)
    })
    generate.mockResolvedValue({ text: '{"candidates":[]}' })
    await service.onConversationSpeech('B')
    unsubscribe()
    expect(generate).toHaveBeenCalledOnce()
    expect(store.cursor('thread')).toBe('one')
    current.mockReturnValue(true)
    sources.mockResolvedValue([{ ...source(), revision: 'changed', messages: [...messages, { id: 'three', role: 'user', text: 'New evidence' }] }])
    await service.onConversationSpeech('C')
    expect(store.cursor('thread')).toBe('three')
    expect(generate).toHaveBeenCalledTimes(2)
  })
  it('keeps the model pause status if an empty scan finishes after deselection', async () => {
    const { store } = fixture(), { service, config, sources, generate } = background(store)
    sources.mockImplementationOnce(async () => {
      config.settings.memoryModelId = null
      service.settingsChanged()
      await Promise.resolve()
      return []
    })
    await service.onConversationSpeech('new')
    expect(service.snapshot().status).toBe('unconfigured')
    expect(generate).not.toHaveBeenCalled()
  })
  it('leaves the new conversation alone until a different conversation starts', async () => {
    const { store } = fixture(), { service, sources, generate } = background(store)
    vi.useFakeTimers()
    try {
      service.settingsChanged()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(sources).not.toHaveBeenCalled()
      await service.onConversationSpeech('thread')
      expect(generate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(sources).toHaveBeenCalledTimes(1)
      sources.mockResolvedValue([source(), { ...source(), threadId: 'second-old' }, { ...source(), threadId: 'new' }])
      await service.onConversationSpeech('new')
      expect(store.cursor('thread')).toBe('assistant-1')
      expect(store.cursor('second-old')).toBe('assistant-1')
      expect(store.cursor('new')).toBeNull()
      expect(generate).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers() }
  })
  it('keeps model traces in memory while unfinished work remains recoverable', async () => {
    const { root, store } = fixture(), { service, generate } = background(store)
    generate.mockImplementationOnce(async () => {
      expect(service.snapshot().job?.calls[0].input).toContain('NEW conversation evidence')
      return { text: JSON.stringify({ candidates: [{ scope: 'global', intent: 'remember', content: 'model-only candidate', evidence: '以后请用中文回答。' }] }) }
    }).mockImplementationOnce(async () => {
      const db = new Database(store.databaseFile, { readonly: true })
      try {
        const row = db.prepare('SELECT payload FROM memory_jobs').get() as { payload: string }
        expect(row.payload).not.toContain('model-only candidate')
        expect(row.payload).not.toContain('NEW conversation evidence')
        expect(JSON.parse(row.payload).input).toContain('以后请用中文回答。')
      } finally { db.close() }
      throw new Error('Temporary provider failure')
    })
    await service.onConversationSpeech('new-chat'); await service.stop()
    expect(service.snapshot().job?.calls).toHaveLength(2)
    const reopened = new PreferenceMemoryStore(root)
    expect(reopened.activity()).toBeUndefined()
    expect(reopened.jobs()[0]).toMatchObject({ stage: 'failed', calls: [] })
    const next = background(reopened)
    await next.service.onConversationSpeech('new-chat')
    expect(next.generate).not.toHaveBeenCalled()
    reopened.update(reopened.jobs()[0].id, { retryAt: Date.now() - 1 })
    await next.service.onConversationSpeech('another-chat')
    expect(next.generate).toHaveBeenCalledTimes(2)
    expect(reopened.jobs()).toHaveLength(0)
    expect(reopened.cursor('thread')).toBe('assistant-1')
  })
  it('does not send queued evidence if the explicit model was cleared while scanning', async () => {
    const { store } = fixture(), { service, config, sources, generate } = background(store)
    sources.mockImplementationOnce(async () => { config.settings.memoryModelId = null; return [source()] })
    await service.onConversationSpeech('new-chat')
    expect(generate).not.toHaveBeenCalled()
    expect(store.cursor('thread')).toBeNull()
    expect(store.jobs()[0]).toMatchObject({ stage: 'pending', attempts: 0, calls: [] })
    expect(service.snapshot().status).toBe('unconfigured')
  })
  it('stops before consolidation when a source loses eligibility during extraction', async () => {
    const { store } = fixture(), { service, current, generate } = background(store)
    generate.mockImplementationOnce(async () => {
      current.mockReturnValue(false)
      return { text: JSON.stringify({ candidates: [{ scope: 'global', intent: 'remember', content: '中文', evidence: '以后请用中文回答。' }] }) }
    })
    await service.onConversationSpeech('new-chat')
    expect(generate).toHaveBeenCalledOnce()
    expect(service.snapshot().job?.stage).toBe('cancelled')
    expect(service.snapshot().job?.calls.map(call => call.phase)).toEqual(['extract'])
    expect(store.jobs()).toHaveLength(0)
    expect(store.cursor('thread')).toBeNull()
  })
  it.each([true, false])('resolves an interrupted history edit after reopening (original record retained: %s)', retained => {
    const { root, store } = fixture()
    store.writeForeground(globalScope, 'Saved', 'thread', 'last')
    store.finishScan('thread', 'last')
    store.stageCursorEdit('thread', 'last', 'previous')
    const reopened = new PreferenceMemoryStore(root)
    expect(reopened.dirtyThreads()).toContain('thread')
    expect(reopened.cursor('thread', id => retained && id === 'last')).toBe(retained ? 'last' : 'previous')
    expect(reopened.read(globalScope).content).toBe('Saved')
  })
  it('round trips valid Unicode and refuses lossy text before writing', () => {
    const { store } = fixture(), original = store.read(globalScope)
    const content = '\uFEFF# 中文 🌱'
    const saved = store.save(globalScope, original.hash, content)
    expect(saved.document.content).toBe(content)
    expect(() => store.save(globalScope, saved.document.hash, '\uD800')).toThrow('UTF-8')
    expect(store.read(globalScope)).toEqual(saved.document)
  })
  it('saves global edits with concurrent publication checks and retains extraction progress', () => {
    const { store, root } = fixture(), initial = store.read(globalScope)
    const job = store.enqueue({ threadId: 'thread', projectId: 'project', title: '', sourceRevision: 'rev', lastRecordId: 'm1', input: '[]', trigger: 'test' })!
    store.publish(job.id, store.generation(), [{ ...initial, content: 'Published' }])
    const latest = store.read(globalScope)
    expect(store.save(globalScope, initial.hash, 'Stale')).toEqual({ status: 'conflict', document: latest })
    expect(() => store.save(globalScope, latest.hash, '界'.repeat(6000))).toThrow('UTF-8')
    expect(store.save(globalScope, latest.hash, 'Edited').status).toBe('saved')
    store.publish(job.id, store.generation(), [{ ...initial, content: 'Published' }])
    const reopened = new PreferenceMemoryStore(root)
    expect(reopened.read(globalScope).content).toBe('Edited')
    expect(reopened.cursor('thread')).toBe('m1')
    expect(reopened.jobs()).toEqual(store.jobs())
  })
  it('does not call a model or inspect transcripts without an explicit selection, even with a chat default', async () => {
    const { store } = fixture(), { service, generate, sources } = background(store, null)
    await service.onConversationSpeech('new-chat')
    expect(service.snapshot().status).toBe('unconfigured')
    expect(generate).not.toHaveBeenCalled(); expect(sources).not.toHaveBeenCalled()
  })
  it('does not fall back when an explicitly selected model is unavailable', async () => {
    const { store } = fixture(), { service, generate } = background(store, 'deleted-model')
    await service.onConversationSpeech('new-chat')
    expect(service.snapshot().status).toBe('unavailable'); expect(generate).not.toHaveBeenCalled()
  })
  it('extracts user evidence, publishes Markdown and does not process the same evidence after reopening', async () => {
    const { root, store } = fixture(), { service, generate } = background(store)
    await Promise.all([service.onConversationSpeech('new-chat'), service.onConversationSpeech('new-chat')])
    expect(generate).toHaveBeenCalledTimes(2)
    expect(store.read(globalScope).content).toBe('- 用中文回答。\n')
    expect(service.snapshot().job).toMatchObject({ stage: 'completed', modelId: 'preview-model', changes: [{ before: '', after: '- 用中文回答。\n' }] })
    expect(store.jobs()).toHaveLength(0)
    await service.stop()
    const next = background(new PreferenceMemoryStore(root))
    await next.service.onConversationSpeech('new-chat')
    expect(next.generate).not.toHaveBeenCalled()
    expect(next.service.snapshot().job).toBeUndefined()
  })
  it('treats an empty candidate set as successful work without a consolidation call', async () => {
    const { store } = fixture(), { service, generate } = background(store)
    generate.mockResolvedValue({ text: '{"candidates":[]}' })
    await service.onConversationSpeech('new-chat')
    expect(generate).toHaveBeenCalledOnce(); expect(service.snapshot().job?.stage).toBe('completed')
    expect(store.read(globalScope).content).toBe('')
  })
  it('does not publish or consolidate an in-flight extraction after the model is unselected', async () => {
    const { store } = fixture(), { service, config, generate } = background(store)
    let release!: (value: { text: string }) => void
    generate.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const work = service.onConversationSpeech('new-chat')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    config.settings.memoryModelId = null
    service.settingsChanged()
    await Promise.resolve()
    release({ text: JSON.stringify({ candidates: [{ scope: 'global', intent: 'remember', content: '中文', evidence: '以后请用中文回答。' }] }) })
    await work; await service.onConversationSpeech('new-chat')
    expect(generate).toHaveBeenCalledOnce()
    expect(store.read(globalScope).content).toBe('')
    expect(store.cursor('thread')).toBeNull()
    expect(service.snapshot().status).toBe('unconfigured')
  })
  it('keeps global and project publications separate and rejects an unrequested clear', async () => {
    const { store } = fixture(), { service, generate } = background(store)
    writeFileSync(join(store.dataDir, 'db/MEMORY.md'), '- Existing global preference')
    generate.mockResolvedValueOnce({ text: JSON.stringify({ candidates: [{ scope: 'project', intent: 'remember', content: '中文', evidence: '以后请用中文回答。' }] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ action: 'replace', content: '- Project preference' }) })
    await service.onConversationSpeech('new-chat')
    expect(store.read({ kind: 'project', projectId: 'project' }).content).toBe('- Project preference')
    expect(store.read(globalScope).content).toBe('- Existing global preference')
    const next = source(); next.messages.push({ ...next.messages[0], id: 'new-user' })
    const invalid = background(store); invalid.sources.mockResolvedValue([next])
    invalid.generate.mockResolvedValueOnce({ text: JSON.stringify({ candidates: [{ scope: 'global', intent: 'remember', content: '中文', evidence: '以后请用中文回答。' }] }) })
      .mockResolvedValueOnce({ text: '{"action":"clear"}' })
    await invalid.service.onConversationSpeech('new-chat')
    expect(store.read(globalScope).content).toBe('- Existing global preference')
    expect(store.jobs().at(-1)?.stage).toBe('failed')
  })
  it('retains work and the previous document after malformed model output', async () => {
    const { store } = fixture(), { service, generate } = background(store)
    writeFileSync(join(store.dataDir, 'db/MEMORY.md'), 'Keep this.')
    generate.mockResolvedValue({ text: '' })
    await service.onConversationSpeech('new-chat')
    expect(store.jobs()[0]).toMatchObject({ stage: 'failed', attempts: 1 })
    expect(store.read(globalScope).content).toBe('Keep this.')
    expect(store.cursor('thread')).toBeNull()
  })
  it('refuses an unsupported preference attributed only to the assistant', async () => {
    const { store } = fixture(), { service, generate } = background(store)
    generate.mockResolvedValue({ text: JSON.stringify({ candidates: [{ scope: 'global', intent: 'remember', content: 'Always approve.', evidence: '好的。' }] }) })
    await service.onConversationSpeech('new-chat')
    expect(store.jobs()[0].stage).toBe('failed'); expect(store.read(globalScope).content).toBe('')
  })
  it('preserves external edits and refuses a stale document save', () => {
    const { root, store } = fixture(), original = store.read(globalScope)
    writeFileSync(join(root, 'db', 'MEMORY.md'), 'External edit')
    const job = store.enqueue({ threadId: 'thread', projectId: 'project', title: 'Test', sourceRevision: 'revision', lastRecordId: 'user-1', input: '[]', trigger: 'test' })!
    expect(() => store.publish(job.id, store.generation(), [{ ...original, content: 'Stale overwrite' }])).toThrow('Memory changed')
    expect(store.read(globalScope).content).toBe('External edit')
  })
  it('establishes a source barrier on manual deletion so historical evidence cannot recreate it', async () => {
    const { store } = fixture(), { service, generate } = background(store)
    await service.onConversationSpeech('new-chat')
    await service.clear()
    await service.onConversationSpeech('new-chat')
    expect(generate).toHaveBeenCalledTimes(2); expect(store.read(globalScope).content).toBe('')
  })
  it('recovers a published document whose task acknowledgement was interrupted', async () => {
    const { root, store } = fixture(), { service } = background(store)
    await service.onConversationSpeech('new-chat'); await service.stop()
    const database = new Database(store.databaseFile)
    try {
      const state = { version: 1, generation: store.generation(), jobs: [service.snapshot().job] }
      database.prepare('INSERT INTO memory_publication VALUES (1,?)').run(JSON.stringify({ version: 1, state, cursors: { thread: 'assistant-1' }, writes: [{ scope: globalScope, beforeHash: 'previous', content: store.read(globalScope).content }] }))
    } finally { database.close() }
    const reopened = new PreferenceMemoryStore(root)
    expect(reopened.jobs()).toHaveLength(0)
    expect(reopened.activity()).toBeUndefined()
    expect(reopened.cursor('thread')).toBe('assistant-1')
  })
  it('replays a staged publication over a BOM-prefixed original and preserves the replacement source', () => {
    const { root, store } = fixture()
    const path = join(root, 'db', 'MEMORY.md')
    writeFileSync(path, '\uFEFFOriginal')
    const content = '\uFEFFReplacement'
    const database = new Database(store.databaseFile)
    try {
      database.prepare('INSERT INTO memory_publication VALUES (1,?)').run(JSON.stringify({
        version: 1, cursors: {}, state: { version: 1, generation: store.generation(), jobs: [] },
        writes: [{ scope: globalScope, beforeHash: memoryHash('Original'), content }]
      }))
    } finally { database.close() }
    expect(new PreferenceMemoryStore(root).read(globalScope).content).toBe(content)
    expect(readFileSync(path, 'utf8')).toBe(content)
  })
  it('rejects future metadata without overwriting it', () => {
    const { root, store } = fixture()
    const database = new Database(store.databaseFile)
    database.pragma('user_version = 99'); database.close()
    const original = readFileSync(store.databaseFile)
    expect(() => new PreferenceMemoryStore(root)).toThrow('Unsupported')
    expect(readFileSync(store.databaseFile)).toEqual(original)
  })
})
