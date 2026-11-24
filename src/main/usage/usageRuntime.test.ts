import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import defaults from '../../../data/config/models.json'
import { normalizeModelProvider } from '../config/modelConfigMapper'
import { beginApplicationDataTransition, finishApplicationDataTransition } from '../applicationDataLifecycle'
import { clearUsageRuntime, registerUsageIpc } from './usageRuntime'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  config: vi.fn(), language: vi.fn(), envFile: vi.fn()
}))
vi.mock('../config/appConfig', () => ({ getAppConfigSnapshot: state.config, onAppConfigChanged: vi.fn(), updateUsageDisplayMode: vi.fn() }))
vi.mock('../config/dataDir', () => ({ getEnvFile: state.envFile, getBundledEnvFile: state.envFile }))
vi.mock('../languageStore', () => ({ resolveConfiguredLanguage: state.language }))
vi.mock('../ipcSecurity', () => ({ handleMainIpc: (name: string, handler: (...args: any[]) => Promise<any>) => state.handlers.set(name, handler) }))
let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'anas-usage-runtime-'))
  state.envFile.mockReturnValue(join(directory, 'missing.env'))
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })
afterEach(() => { clearUsageRuntime(); finishApplicationDataTransition(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('does not start a prepared old-data query after restore has cleared the runtime', async () => {
  const provider = normalizeModelProvider({ ...defaults.provider_defaults, id: 'provider', name: 'Provider', protocol: 'openai_chat_completions',
    base_url: 'https://api.deepseek.com', api_key: 'fixture', models: [{ ...defaults.model_defaults, id: 'model', model: 'deepseek-chat' }] }, 0)
  state.config.mockResolvedValue({ providers: [provider], settings: { language: 'en' } })
  let release!: (value: { code: string }) => void
  state.language.mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue({ code: 'en' })
  const fetcher = vi.fn(async () => Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] }))
  vi.stubGlobal('fetch', fetcher)
  registerUsageIpc()
  const pending = state.handlers.get('usage:read')!({}, 'model')
  await vi.waitFor(() => expect(release).toBeDefined())
  clearUsageRuntime()
  const transition = beginApplicationDataTransition()
  release({ code: 'en' })
  expect(await pending).toBeNull()
  await transition
  expect(fetcher).not.toHaveBeenCalled()
  finishApplicationDataTransition()
  expect((await state.handlers.get('usage:read')!({}, 'model')).lines[0].value).toBe('1')
})

it.each(['bailian', 'tencent', 'deepseek'])('keeps independent queries available when the %s model key reference is missing', async kind => {
  vi.stubEnv('ANAS_USAGE_TEST_MISSING_MODEL_KEY', '')
  const baseUrl = kind === 'bailian' ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    : kind === 'tencent' ? 'https://api.lkeap.cloud.tencent.com/coding/v3' : 'https://api.deepseek.com'
  const provider = normalizeModelProvider({ ...defaults.provider_defaults, id: 'provider', name: 'Provider', protocol: 'openai_chat_completions',
    base_url: baseUrl, api_key: '${ANAS_USAGE_TEST_MISSING_MODEL_KEY}',
    usage: { bailian_access_key_id: 'fixture-id', bailian_access_key_secret: 'fixture-secret', bailian_show_balance: true,
      tencent_secret_id: 'fixture-id', tencent_secret_key: 'fixture-secret', tencent_show_balance: true },
    models: [{ ...defaults.model_defaults, id: 'model', model: 'fixture' }] }, 0)
  state.config.mockResolvedValue({ providers: [provider], settings: { language: 'en' } })
  state.language.mockResolvedValue({ code: 'en' })
  const fetcher = vi.fn(async (_url: string) => kind === 'bailian'
    ? Response.json({ Success: true, Code: '200', Data: { Currency: 'CNY', AvailableAmount: '12.34', AvailableCashAmount: '12.34' } })
    : Response.json({ Response: { RealBalance: 1234 } }))
  vi.stubGlobal('fetch', fetcher)
  registerUsageIpc()
  const result = await state.handlers.get('usage:read')!({}, 'model')
  if (kind === 'deepseek') {
    expect(result.lines).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  } else {
    expect(result.lines[0].value).toBe('12.34')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(kind === 'bailian' ? 'https://business.aliyuncs.com/' : 'https://billing.tencentcloudapi.com/')
  }
  if (kind !== 'tencent') {
    expect(result.error).toContain('model API key')
    expect(result.configurationRequired).toBe(true)
  } else expect(result.error).toBeUndefined()
})
