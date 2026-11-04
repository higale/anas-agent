import { getModelProviderConfig } from './config/appConfig'
import { resolveModelApiKey } from './config/apiKeys'
import { modelListCacheFileName, normalizeModelList, readModelListCache, writeModelListCache } from './modelListCache'
import { requireModelProtocol } from '@shared/modelConfig'
import { resolveModelListEndpoint } from '@shared/modelListEndpoint'
import type { ModelListRequest, ModelListResponse, ModelProviderConfig } from '@shared/types'

function modelListHeaders(endpoint: string, apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {}
  if (new URL(endpoint).hostname === 'api.anthropic.com') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  }
  return {
    Authorization: `Bearer ${apiKey}`
  }
}

interface ModelListRequestRuntime {
  endpoint: string
  apiKey: string | undefined
}

async function modelListRequestRuntime(request: ModelListRequest): Promise<ModelListRequestRuntime> {
  const existing = request.providerId === undefined ? undefined : await getModelProviderConfig(request.providerId)
  const provider: ModelProviderConfig = {
    id: existing?.id ?? 'model-list-request',
    name: request.name?.trim() || existing?.name || 'Model',
    protocol: requireModelProtocol(request.protocol, 'modelList.protocol'),
    baseUrl: request.baseUrl.trim(),
    modelListUrl: request.modelListUrl === undefined
      ? existing?.modelListUrl ?? ''
      : request.modelListUrl.trim(),
    apiKey: request.apiKey?.trim() || existing?.apiKey,
    parameters: existing?.parameters ?? {},
    models: existing?.models ?? []
  }
  if (!provider.baseUrl) throw new Error('Base URL is required.')
  const endpoint = resolveModelListEndpoint(provider.baseUrl, provider.modelListUrl)
  const apiKey = resolveModelApiKey(provider)
  return { endpoint, apiKey }
}

function modelListItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data
  return Array.isArray(record.models) ? record.models : []
}

function modelListItemId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined
}

export async function getCachedAvailableModels(request: ModelListRequest): Promise<ModelListResponse | null> {
  const { endpoint, apiKey } = await modelListRequestRuntime(request)
  const cache = await readModelListCache(endpoint, apiKey)
  return cache
    ? {
        models: cache.models
      }
    : null
}

async function requestModelList({ endpoint, apiKey }: ModelListRequestRuntime): Promise<string[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const headers = modelListHeaders(endpoint, apiKey)
    const response = await fetch(endpoint, { headers, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`)
    const models = normalizeModelList(modelListItems(JSON.parse(text)).map(modelListItemId))
    if (models.length === 0) throw new Error('No models were returned.')
    return models
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('Model list request timed out.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

// Assign order before resolving provider settings, which can also finish out of order.
let nextRefreshId = 0
let activeRefreshes = 0
const cacheWrites = new Map<string, { latestId: number; pending: Promise<void> }>()

export async function fetchAvailableModels(request: ModelListRequest): Promise<ModelListResponse> {
  const id = ++nextRefreshId
  activeRefreshes++
  try {
    const runtime = await modelListRequestRuntime(request)
    const key = modelListCacheFileName(runtime.endpoint, runtime.apiKey)
    const writes = cacheWrites.get(key) ?? { latestId: id, pending: Promise.resolve() }
    writes.latestId = Math.max(writes.latestId, id)
    cacheWrites.set(key, writes)
    const models = await requestModelList(runtime)
    if (writes.latestId === id) {
      const published = writes.pending.then(() => {
        if (writes.latestId === id) return writeModelListCache(runtime.endpoint, runtime.apiKey, models)
      })
      writes.pending = published.catch(() => undefined)
      await published
    }
    return { models }
  } finally {
    // A still-resolving older refresh may yet resolve to any cached key.
    if (--activeRefreshes === 0) cacheWrites.clear()
  }
}
