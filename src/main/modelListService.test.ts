import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getModelProviderConfig: vi.fn(),
  cacheDir: '',
  resolveModelApiKey: vi.fn()
}))

vi.mock('./config/appConfig', () => ({ getModelProviderConfig: mocks.getModelProviderConfig }))
vi.mock('./config/apiKeys', () => ({ resolveModelApiKey: mocks.resolveModelApiKey }))
vi.mock('./config/dataDir', () => ({ getCacheDir: () => mocks.cacheDir }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('./modelListCache', { spy: true })

import { readModelListCache, writeModelListCache } from './modelListCache'
import { fetchAvailableModels, getCachedAvailableModels } from './modelListService'

describe('model list configuration', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.cacheDir = await mkdtemp(join(tmpdir(), 'anas-model-list-'))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(mocks.cacheDir, { recursive: true, force: true })
  })

  it('does not request models or read cached results when resolving a variable fails', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    mocks.resolveModelApiKey.mockImplementationOnce(() => { throw new Error('API key environment variable MISSING is missing or empty.') })
    await expect(fetchAvailableModels({ protocol: 'openai_chat_completions', baseUrl: 'https://example.com/v1', apiKey: '${MISSING}' }))
      .rejects.toThrow('MISSING is missing or empty')
    expect(fetch).not.toHaveBeenCalled()
    expect(readModelListCache).not.toHaveBeenCalled()
  })

  it('rejects an unknown provider before selecting credentials or a fallback protocol', async () => {
    await expect(getCachedAvailableModels({
      protocol: 'unknown' as never,
      baseUrl: 'https://example.com/v1',
    })).rejects.toThrow('modelList.protocol')
    expect(mocks.resolveModelApiKey).not.toHaveBeenCalled()
    expect(readModelListCache).not.toHaveBeenCalled()
  })

  it('retains the latest refresh in the disk cache when an earlier response arrives last', async () => {
    const request = { protocol: 'openai_responses' as const, baseUrl: 'https://example.test' }
    const fetch = vi.fn()
    let finishOld!: (response: Response) => void
    fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce(Response.json([{ id: 'new' }]))
    vi.stubGlobal('fetch', fetch)
    const old = fetchAvailableModels(request)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await expect(fetchAvailableModels(request)).resolves.toEqual({ models: ['new'] })
    finishOld(Response.json([{ id: ' old ' }, { id: 'OLD' }]))
    await expect(old).resolves.toEqual({ models: ['old'] })
    await expect(getCachedAvailableModels(request)).resolves.toEqual({ models: ['new'] })
  })

  it('orders overlapping writes for one cache without delaying another endpoint', async () => {
    const request = { protocol: 'openai_responses' as const, baseUrl: 'https://first.test' }
    const other = { ...request, baseUrl: 'https://other.test' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([{ id: 'old' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'new' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'independent' }])))
    const actualCache = await vi.importActual<typeof import('./modelListCache')>('./modelListCache')
    let release!: () => void
    const writing = new Promise<void>(resolve => { release = resolve })
    vi.mocked(writeModelListCache).mockImplementationOnce(async (...args) => {
      await writing
      await actualCache.writeModelListCache(...args)
    })
    const old = fetchAvailableModels(request)
    await vi.waitFor(() => expect(writeModelListCache).toHaveBeenCalledOnce())
    const latest = fetchAvailableModels(request)
    try {
      await fetchAvailableModels(other)
      await expect(getCachedAvailableModels(other)).resolves.toEqual({ models: ['independent'] })
    } finally { release() }
    await Promise.all([old, latest])
    await expect(getCachedAvailableModels(request)).resolves.toEqual({ models: ['new'] })
  })

  it('preserves invocation order even if earlier provider settings resolve after the newer write', async () => {
    const request = { protocol: 'openai_responses' as const, baseUrl: 'https://example.test', providerId: 'example' }
    let finishSettings!: () => void
    mocks.getModelProviderConfig.mockReturnValueOnce(new Promise<void>(resolve => { finishSettings = resolve }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([{ id: 'new' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'old' }])))
    const old = fetchAvailableModels(request)
    await fetchAvailableModels(request)
    finishSettings()
    await old
    await expect(getCachedAvailableModels(request)).resolves.toEqual({ models: ['new'] })
  })

  it('uses an explicit model list URL instead of inferring from the Base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ data: [{ id: 'example-model' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    mocks.resolveModelApiKey.mockReturnValue(undefined)

    await expect(fetchAvailableModels({
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.example.com/v1',
      modelListUrl: ' https://catalog.example.com/models ',
    })).resolves.toEqual({ models: ['example-model'] })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://catalog.example.com/models',
      expect.objectContaining({ headers: {} })
    )
  })

  it.each(['anthropic_messages', 'openai_chat_completions', 'openai_responses'] as const)(
    'uses Anthropic headers for the official endpoint with %s', async (protocol) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ data: [{ id: 'claude-example' }] })
      })
      vi.stubGlobal('fetch', fetchMock)
      mocks.resolveModelApiKey.mockReturnValue('anthropic-secret')

      await fetchAvailableModels({
        protocol,
        baseUrl: 'https://api.anthropic.com',
      })

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/models',
        expect.objectContaining({
          headers: {
            'x-api-key': 'anthropic-secret',
            'anthropic-version': '2023-06-01'
          }
        })
      )
  })

  it('keeps Bearer authentication for a third-party Anthropic-compatible provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ data: [{ id: 'third-party-model' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    mocks.resolveModelApiKey.mockReturnValue('third-party-secret')

    await fetchAvailableModels({
      protocol: 'anthropic_messages',
      baseUrl: 'https://api.third-party.example/anthropic',
      modelListUrl: 'https://api.third-party.example/v1/models',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.third-party.example/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer third-party-secret' } })
    )
  })

  it.each([
    ['https://api.third-party.example/v1', 'https://api.anthropic.com/v1/models', true],
    ['https://api.anthropic.com', 'https://catalog.example.com/models', false],
    ['https://api.anthropic.com', 'https://api.anthropic.com.example/v1/models', false],
    ['https://api.anthropic.com', 'https://example.com/api.anthropic.com/models', false],
    ['https://api.anthropic.com', '{origin}/v1/models', true]
  ] as const)('chooses headers from the resolved URL: %s → %s', async (baseUrl, modelListUrl, anthropic) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ data: [{ id: 'example-model' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    mocks.resolveModelApiKey.mockReturnValue('test-secret')

    await fetchAvailableModels({ protocol: 'anthropic_messages', baseUrl, modelListUrl })

    const endpoint = modelListUrl.replace('{origin}', new URL(baseUrl).origin)
    expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      headers: anthropic
        ? { 'x-api-key': 'test-secret', 'anthropic-version': '2023-06-01' }
        : { Authorization: 'Bearer test-secret' }
    }))
    expect(writeModelListCache).toHaveBeenCalledWith(endpoint, 'test-secret', ['example-model'])
  })

  it('accepts a top-level model array while strictly ignoring entries without a non-empty string id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify([
        { id: 'first-model' },
        { id: '' },
        { id: 42 },
        'not-a-model',
        { id: 'second-model' }
      ])
    })
    vi.stubGlobal('fetch', fetchMock)
    mocks.resolveModelApiKey.mockReturnValue(undefined)

    await expect(fetchAvailableModels({
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.array.example/v1',
    })).resolves.toEqual({ models: ['first-model', 'second-model'] })

    expect(writeModelListCache).toHaveBeenCalledWith(
      'https://api.array.example/v1/models',
      undefined,
      ['first-model', 'second-model']
    )
  })

  it('accepts an xAI-style models wrapper', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        models: [
          { id: 'grok-example' },
          { id: '' },
          { name: 'missing-id' }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    mocks.resolveModelApiKey.mockReturnValue('xai-secret')

    await expect(fetchAvailableModels({
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.x.ai/v1',
      modelListUrl: 'https://api.x.ai/v1/language-models',
    })).resolves.toEqual({ models: ['grok-example'] })

    expect(writeModelListCache).toHaveBeenCalledWith(
      'https://api.x.ai/v1/language-models',
      'xai-secret',
      ['grok-example']
    )
  })
})
