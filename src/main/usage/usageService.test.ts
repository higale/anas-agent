import { afterEach, expect, it, vi } from 'vitest'
import { normalizeUsageSettings } from '@shared/usageMeter'
import { createUsageService } from './usageService'
const model = { id: 'model', providerId: 'provider', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture' }
const balance = (value: string) => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: value, granted_balance: '0', topped_up_balance: value }] })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('aborts discarded contexts and prevents late old-account results from being published', async () => {
  const service = createUsageService()
  let complete!: (value: Response) => void
  let signal!: AbortSignal
  const fetcher = vi.fn((_url, options) => { signal = options.signal; return new Promise<Response>(resolve => { complete = resolve }) })
  vi.stubGlobal('fetch', fetcher)
  const pending = service.read(model, 'en')
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  service.reconcile([{ ...model, apiKey: 'replacement' }])
  expect(signal.aborted).toBe(true)
  complete(balance('123'))
  expect(await pending).toBeNull()
  service.clear()
})
it('does not query when disabled or unsupported and allows refresh after a missing-credential failure', async () => {
  const service = createUsageService(), fetcher = vi.fn(async () => balance('1'))
  vi.stubGlobal('fetch', fetcher)
  expect(await service.read({ ...model, usage: normalizeUsageSettings({ enabled: false }, model.baseUrl) }, 'en')).toBeNull()
  expect(await service.read({ ...model, baseUrl: 'https://unknown.test' }, 'en')).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
  expect((await service.read({ ...model, apiKey: '' }, 'en'))?.error).toBeTruthy()
  expect((await service.read(model, 'en', true))?.lines[0].value).toBe('1')
  service.clear()
})
it('keeps language and layout redraws independent of expired network caches', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const service = createUsageService(), fetcher = vi.fn(async () => balance('1'))
  vi.stubGlobal('fetch', fetcher)
  await service.read(model, 'en')
  vi.setSystemTime(Date.now() + 360_000)
  expect((await service.read(model, 'zh-CN', false, true))?.title).toContain('余额')
  expect(fetcher).toHaveBeenCalledOnce()
  service.clear()
})
