import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getModelProviderConfig: vi.fn(),
  readModelListCache: vi.fn(),
  resolveModelApiKey: vi.fn(),
  writeModelListCache: vi.fn()
}))

vi.mock('./config/appConfig', () => ({ getModelProviderConfig: mocks.getModelProviderConfig }))
vi.mock('./config/apiKeys', () => ({ resolveModelApiKey: mocks.resolveModelApiKey }))
vi.mock('./modelListCache', () => ({
  readModelListCache: mocks.readModelListCache,
  writeModelListCache: mocks.writeModelListCache
}))

import { fetchAvailableModels, getCachedAvailableModels } from './modelListService'

describe('model list configuration', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('rejects an unknown provider before selecting credentials or a fallback protocol', async () => {
    await expect(getCachedAvailableModels({
      protocol: 'unknown' as never,
      baseUrl: 'https://example.com/v1',
    })).rejects.toThrow('modelList.protocol')
    expect(mocks.resolveModelApiKey).not.toHaveBeenCalled()
    expect(mocks.readModelListCache).not.toHaveBeenCalled()
  })

  it('uses an explicit model list URL instead of inferring from the Base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ data: [{ id: 'example-model' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    mocks.resolveModelApiKey.mockReturnValue(undefined)
    mocks.readModelListCache.mockResolvedValue({ models: ['example-model'] })

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
      mocks.readModelListCache.mockResolvedValue({ models: ['claude-example'] })

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
    mocks.readModelListCache.mockResolvedValue({ models: ['third-party-model'] })

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
    mocks.readModelListCache.mockResolvedValue({ models: ['example-model'] })

    await fetchAvailableModels({ protocol: 'anthropic_messages', baseUrl, modelListUrl })

    const endpoint = modelListUrl.replace('{origin}', new URL(baseUrl).origin)
    expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      headers: anthropic
        ? { 'x-api-key': 'test-secret', 'anthropic-version': '2023-06-01' }
        : { Authorization: 'Bearer test-secret' }
    }))
    expect(mocks.writeModelListCache).toHaveBeenCalledWith(endpoint, 'test-secret', ['example-model'])
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
    mocks.readModelListCache.mockResolvedValue({ models: ['first-model', 'second-model'] })

    await expect(fetchAvailableModels({
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.array.example/v1',
    })).resolves.toEqual({ models: ['first-model', 'second-model'] })

    expect(mocks.writeModelListCache).toHaveBeenCalledWith(
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
    mocks.readModelListCache.mockResolvedValue({ models: ['grok-example'] })

    await expect(fetchAvailableModels({
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.x.ai/v1',
      modelListUrl: 'https://api.x.ai/v1/language-models',
    })).resolves.toEqual({ models: ['grok-example'] })

    expect(mocks.writeModelListCache).toHaveBeenCalledWith(
      'https://api.x.ai/v1/language-models',
      'xai-secret',
      ['grok-example']
    )
  })
})
