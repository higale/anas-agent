import { beforeEach, expect, it, vi } from 'vitest'
import type { PluginStore } from './pluginStore'
import type { PluginBackends } from './pluginBackend'
import { readPluginWidget } from './pluginWidgets'
import { resolveModelApiKey } from '../config/apiKeys'
import { beginApplicationDataTransition, finishApplicationDataTransition } from '../applicationDataLifecycle'

const mocks = vi.hoisted(() => ({ model: { id: 'model', model: 'MiniMax-M2.7', providerId: 'provider', providerName: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', apiKey: 'secret' }, call: vi.fn(), prepare: vi.fn(), allowed: true }))
vi.mock('../config/appConfig', () => ({ getAppConfigSnapshot: async () => ({ settings: { language: 'en' } }), findResolvedModelConfig: (_config: unknown, id: string) => id === 'model' ? mocks.model : undefined }))
vi.mock('../languageStore', () => ({ resolveConfiguredLanguage: async () => ({ code: 'en' }) }))
vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: vi.fn() }))
const store = { exclusive: async (fn: () => unknown) => fn(), requireEnabled: async () => ({ widgets: [
  { id: 'quota', handler: 'quota', actions: ['refresh'], modelHosts: ['api.minimaxi.com'] }
] }) } as unknown as PluginStore
const backends = { canStartAutomatically: () => mocks.allowed, prepare: mocks.prepare, call: mocks.call } as unknown as PluginBackends
beforeEach(() => {
  mocks.model.apiKey = 'secret'
  vi.mocked(resolveModelApiKey).mockReset().mockImplementation(model => model.apiKey)
  mocks.allowed = true
  mocks.prepare.mockReset().mockResolvedValue({ ready: Promise.resolve() })
  mocks.call.mockReset().mockResolvedValue({ title: 'Quota', html: '<p>Remaining</p>' })
})
it('passes the resolved credential to widgets and stops before starting a backend when a reference is missing', async () => {
  mocks.model.apiKey = '${WIDGET_TOKEN}'
  vi.mocked(resolveModelApiKey).mockReturnValue('resolved-secret')
  await readPluginWidget(store, backends, 'usage', 'quota', 'model', undefined)
  expect(resolveModelApiKey).toHaveBeenCalledWith(mocks.model)
  expect(mocks.call).toHaveBeenCalledWith('usage', 'quota', expect.objectContaining({
    model: { ...mocks.model, apiKey: 'resolved-secret' }
  }), expect.anything(), undefined, { concurrent: true })
  mocks.prepare.mockClear()
  mocks.call.mockClear()
  vi.mocked(resolveModelApiKey).mockImplementation(() => { throw new Error('API key environment variable WIDGET_TOKEN is missing or empty.') })
  await expect(readPluginWidget(store, backends, 'usage', 'quota', 'model', undefined)).rejects.toThrow('WIDGET_TOKEN is missing')
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
})
it('resolves model credentials in the host and projects only validated presentation data', async () => {
  mocks.call.mockResolvedValue({ title: 'Quota', html: '<p>Remaining</p>', apiKey: 'secret' })
  const result = await readPluginWidget(store, backends, 'usage', 'quota', 'model', 'refresh')
  expect(mocks.call).toHaveBeenCalledWith('usage', 'quota', expect.objectContaining({ model: mocks.model, action: 'refresh' }), expect.anything(), undefined, { concurrent: true })
  expect(result).toEqual({ title: 'Quota', html: '<p>Remaining</p>' })
})
it('does not start unsupported or explicitly stopped plugins', async () => {
  expect(await readPluginWidget(store, backends, 'usage', 'quota', 'missing', undefined)).toBeNull()
  mocks.allowed = false
  expect(await readPluginWidget(store, backends, 'usage', 'quota', 'model', undefined)).toBeNull()
  expect(mocks.prepare).not.toHaveBeenCalled()
})
it('rejects undeclared actions before executing plugin code', async () => {
  await expect(readPluginWidget(store, backends, 'usage', 'quota', 'model', 'delete')).rejects.toThrow('not declared')
  expect(mocks.call).not.toHaveBeenCalled()
})

it('allows data shutdown during an in-flight widget call and rejects new work until reopened', async () => {
  let complete!: (value: unknown) => void
  mocks.call.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const pending = readPluginWidget(store, backends, 'usage', 'quota', 'model', undefined)
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled())
  try {
    await beginApplicationDataTransition()
    await expect(readPluginWidget(store, backends, 'usage', 'quota', 'model', undefined)).rejects.toThrow('unavailable')
  } finally {
    complete(null)
    await pending
    finishApplicationDataTransition()
  }
})
