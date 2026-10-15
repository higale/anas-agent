// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginWidgetContent } from '@shared/pluginWidgets'

const load = createRequire(import.meta.url)
const path = resolve('data/plugins/usage-meter/backend.cjs')
let backend: { activate(context: { dataDirectory: string }): void; call(method: string, params: unknown, context: { signal: AbortSignal }): Promise<PluginWidgetContent | null>; deactivate(): void }
let dataDirectory: string
const model = { id: 'm1', model: 'MiniMax-M2.7', providerId: 'p1', providerName: 'MiniMax CN', baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'test-secret' }
const row = { model_name: 'MiniMax-M*', current_interval_total_count: 1500, current_interval_usage_count: 1200,
  current_weekly_total_count: 0, current_weekly_usage_count: 0, end_time: 1776373200000 }
const payload = (changes = {}) => ({ base_resp: { status_code: 0 }, model_remains: [{ ...row, ...changes }] })
const fetcher = vi.fn()
// Observe the rendered HTML rather than a host-specific quota data schema.
const call = async (changes: Record<string, unknown> = {}) => {
  const result = await backend.call('quota', { model, language: 'zh-CN', action: null, ...changes }, { signal: new AbortController().signal })
  if (!result) return null
  const template = document.createElement('template')
  template.innerHTML = result.html
  const dom = template.content
  return { ...result, dom,
    lines: [...dom.querySelectorAll('progress')].map(progress => {
      const section = progress.closest('section')!
      return { label: progress.getAttribute('aria-label'), value: section.textContent?.match(/[\d.]+%/)?.[0], progress: progress.value,
        ...(section.querySelector('small') ? { description: section.querySelector('small')!.textContent } : {}),
        ...(section.getAttribute('title') ? { detail: section.getAttribute('title') } : {}) }
    }),
    error: dom.querySelector('[role="status"]')?.textContent,
    updatedAt: dom.querySelector('time')?.getAttribute('datetime')
  }
}
beforeEach(() => {
  delete load.cache[path]
  backend = load(path)
  dataDirectory = mkdtempSync(join(tmpdir(), 'anas-usage-test-'))
  writeFileSync(join(dataDirectory, 'display.json'), JSON.stringify({ version: 0, display_mode: 'detailed' }))
  backend.activate({ dataDirectory })
  fetcher.mockReset().mockImplementation(async () => Response.json(payload()))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { backend.deactivate(); vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(dataDirectory, { recursive: true, force: true }) })

it('recognizes exact provider hosts across protocols and hides other providers without a request', async () => {
  for (const baseUrl of ['https://example.com/minimax', 'https://api.minimaxi.com.evil.test/v1', 'invalid']) {
    expect(await call({ model: { ...model, baseUrl } })).toBeNull()
  }
  expect(fetcher).not.toHaveBeenCalled()
  for (const [baseUrl, host] of [['https://api.minimaxi.com/v1', 'www.minimaxi.com'], ['https://api.minimax.io/anthropic', 'www.minimax.io'], ['https://api.minimax.cn/v1', 'www.minimax.cn']]) {
    await call({ model: { ...model, baseUrl }, action: 'refresh' })
    expect(fetcher).toHaveBeenLastCalledWith(`https://${host}/v1/token_plan/remains`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }) }))
  }
})

it('shows legacy remaining counts and authoritative percentages, including zero-count plans', async () => {
  const legacy = await call()
  expect(legacy?.lines).toHaveLength(1)
  expect(legacy?.lines[0]).toMatchObject({ value: '80%', progress: .8 })
  fetcher.mockResolvedValueOnce(Response.json(payload({ current_interval_remaining_percent: 0, current_interval_total_count: 0,
    current_weekly_remaining_percent: 42 })))
  const current = await call({ action: 'refresh' })
  expect(current?.lines.map(line => line.value)).toEqual(['0%', '42%'])
  expect(current?.error).toBeUndefined()
})

it('reads the account general bucket regardless of the selected model and reuses its cache across models', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ base_resp: { status_code: 0 }, model_remains: [
    { ...row, model_name: 'video', current_interval_remaining_percent: 20, current_weekly_remaining_percent: 30 },
    { ...row, model_name: 'general', current_interval_total_count: 0, current_interval_usage_count: 0,
      current_interval_remaining_percent: 100, current_weekly_remaining_percent: 99 }
  ] }))
  const first = await call({ model: { ...model, model: 'MiniMax-M3.1-Flash-Preview' } })
  expect(first?.lines.map(line => line.value)).toEqual(['100%', '99%'])
  const next = await call({ model: { ...model, id: 'another', model: 'MiniMax-M3' } })
  expect(next?.lines).toEqual(first?.lines)
  expect(next?.error).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('shows plan quota categories and recomputes reset countdowns from cached data in both languages', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-10-15T08:00:00Z')
  vi.setSystemTime(now)
  fetcher.mockResolvedValueOnce(Response.json(payload({ model_name: 'general', start_time: now - 4 * 3600000,
    end_time: now + 3600000, weekly_start_time: now - 4 * 86400000, weekly_end_time: now + 3 * 86400000,
    current_weekly_remaining_percent: 99 })))
  const initial = await call({ model: { ...model, providerName: 'MiniMax' } })
  expect(initial?.title).toBe('MiniMax Token Plan')
  expect(initial?.lines).toMatchObject([
    { label: '5 小时额度剩余', value: '80%', description: '约 1 小时后重置', detail: expect.stringContaining('重置时间') },
    { label: '每周额度剩余', value: '99%', description: '约 3 天后重置' }
  ])
  vi.setSystemTime(now + 60000)
  const cached = await call({ language: 'en' })
  expect(cached?.lines).toMatchObject([
    { label: '5-hour quota remaining', description: 'Resets in 59m' },
    { label: 'Weekly quota remaining', description: 'Resets in 2d 23h' }
  ])
  expect(cached?.updatedAt).toBe(initial?.updatedAt)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps the five-hour category when the API returns a shorter current interval', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-10-15T12:00:00Z')
  vi.setSystemTime(now)
  fetcher.mockResolvedValueOnce(Response.json(payload({ model_name: 'general', start_time: now, end_time: now + 4 * 3600000 })))
  const detailed = await call()
  expect(detailed?.lines[0]).toMatchObject({ label: '5 小时额度剩余', description: '约 4 小时后重置' })
  expect(detailed?.lines[0].detail).toContain(new Date(now + 4 * 3600000).toLocaleString('zh-CN'))
  const compact = await call({ action: 'show_compact' })
  expect(compact?.dom.textContent).toContain('5h 80%')
  const english = await call({ action: 'show_detailed', language: 'en' })
  expect(english?.lines[0]).toMatchObject({ label: '5-hour quota remaining', description: 'Resets in 4h' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('does not invent missing reset times or plan expiry, and marks elapsed windows without assuming replenishment', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-10-15T08:00:00Z')
  vi.setSystemTime(now)
  fetcher.mockResolvedValueOnce(Response.json(payload({ start_time: now - 86370000, end_time: now + 30000 })))
  expect((await call())?.lines[0]).toMatchObject({ label: '5 小时额度剩余', description: '不到 1 分钟后重置' })
  vi.setSystemTime(now + 60000)
  const elapsed = await call()
  expect(elapsed?.lines[0]).toMatchObject({ value: '80%', description: '周期已结束，待刷新' })
  fetcher.mockResolvedValueOnce(Response.json(payload({ end_time: null })))
  const missing = await call({ action: 'refresh' })
  expect(missing?.lines).toEqual([{ label: '5 小时额度剩余', value: '80%', progress: .8 }])
  fetcher.mockResolvedValueOnce(Response.json(payload({ end_time: 'invalid', weekly_end_time: -1 })))
  expect((await call({ action: 'refresh' }))?.lines).toEqual(missing?.lines)
})

it('coalesces refreshes, caches automatically, and invalidates when credentials change', async () => {
  let complete!: (value: Response) => void
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve }))
  const first = call(), second = call({ action: 'refresh' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  complete(Response.json(payload()))
  await Promise.all([first, second])
  await call()
  expect(fetcher).toHaveBeenCalledTimes(1)
  await call({ model: { ...model, apiKey: 'replacement' } })
  expect(fetcher).toHaveBeenCalledTimes(2)
  await call({ action: 'refresh' })
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('preserves the last successful reading on malformed responses, backs off, and exposes no raw errors', async () => {
  const initial = await call()
  fetcher.mockResolvedValueOnce(Response.json(payload({ current_interval_remaining_percent: -1 })))
  const failed = await call({ action: 'refresh' })
  expect(failed?.lines).toEqual(initial?.lines)
  expect(failed?.updatedAt).toBe(initial?.updatedAt)
  expect(failed?.error).toBeTruthy()
  await call()
  expect(fetcher).toHaveBeenCalledTimes(2)
  fetcher.mockRejectedValueOnce(new Error('Bearer test-secret'))
  expect(JSON.stringify(await call({ action: 'refresh' }))).not.toContain('test-secret')
})

it('does not substitute another quota bucket and reports missing credentials and auth failures', async () => {
  expect((await call({ model: { ...model, apiKey: '' } }))?.error).toContain('API Key')
  expect(fetcher).not.toHaveBeenCalled()
  fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
  expect((await call())?.error).toContain('API Key')
  fetcher.mockResolvedValueOnce(Response.json({ base_resp: { status_code: 0 }, model_remains: [{ ...row, model_name: 'speech-hd' }] }))
  expect((await call({ action: 'refresh' }))?.lines).toEqual([])
})

it('aborts network work when stopped and prevents subsequent queries', async () => {
  fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')))
  }))
  const pending = call()
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  backend.deactivate()
  await expect(pending).rejects.toThrow('stopped')
  await expect(call()).rejects.toThrow('stopped')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('bounds response size and request time', async () => {
  fetcher.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)))
  expect((await call())?.error).toBeTruthy()
  vi.useFakeTimers()
  fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')))
  }))
  const pending = call({ action: 'refresh' })
  await vi.advanceTimersByTimeAsync(15_000)
  expect((await pending)?.error).toContain('超时')
})

it('escapes provider text and puts layout and refresh markup in the plugin HTML', async () => {
  const providerName = '<script>alert("name")</script> & Quota'
  const result = await call({ model: { ...model, providerName } })
  expect(result?.dom.querySelector('script')).toBeNull()
  expect(result?.dom.textContent).toContain(providerName)
  expect(result?.dom.querySelector('button')?.getAttribute('data-action')).toBe('refresh')
  expect(result?.dom.querySelector('img')?.getAttribute('src')).toBe('assets/refresh.svg')
})

it('defaults to a compact summary with reset details on hover and switches layouts without refetching quota', async () => {
  rmSync(join(dataDirectory, 'display.json'))
  delete load.cache[path]
  backend = load(path)
  backend.activate({ dataDirectory })
  const now = Date.now()
  fetcher.mockResolvedValueOnce(Response.json(payload({ model_name: 'general', start_time: now - 4 * 3600000,
    end_time: now + 3600000, weekly_start_time: now - 6 * 86400000, weekly_end_time: now + 86400000,
    current_weekly_remaining_percent: 99 })))
  const compact = await call()
  expect(compact?.dom.textContent).toContain('5h 80% · 周 99%')
  expect(compact?.dom.querySelector('progress')).toBeNull()
  const details = compact?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')
  expect(details).toContain('MiniMax CN')
  expect(details).toContain('重置时间')
  expect(details).toContain('更新于')
  expect(compact?.dom.querySelector('button')?.getAttribute('data-action')).toBe('refresh')
  const detailed = await call({ action: 'show_detailed' })
  expect(detailed?.dom.querySelectorAll('progress')).toHaveLength(2)
  const english = await call({ language: 'en', action: 'show_compact' })
  expect(english?.dom.textContent).toContain('5h 80% · 1w 99%')
  expect(english?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')).toContain('Resets')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps compact cached quota with an accessible failure indicator', async () => {
  await call({ action: 'show_compact' })
  fetcher.mockResolvedValueOnce(new Response('', { status: 429 }))
  const failed = await call({ action: 'refresh' })
  expect(failed?.dom.textContent).toContain('80%')
  expect(failed?.dom.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('限流')
  expect(failed?.dom.querySelector('[role="status"]')?.getAttribute('title')).toContain('限流')
})

it('persists in-widget choices across backend restarts and keeps the current mode when saving fails', async () => {
  await call({ action: 'show_compact' })
  expect(JSON.parse(readFileSync(join(dataDirectory, 'display.json'), 'utf8'))).toEqual({ version: 0, display_mode: 'compact' })
  backend.deactivate()
  delete load.cache[path]
  backend = load(path)
  backend.activate({ dataDirectory })
  expect((await call())?.dom.querySelector('progress')).toBeNull()
  await call({ action: 'show_detailed' })
  const saved = readFileSync(join(dataDirectory, 'display.json'), 'utf8')
  rmSync(join(dataDirectory, 'display.json'))
  mkdirSync(join(dataDirectory, 'display.json'))
  await expect(call({ action: 'show_compact' })).rejects.toThrow()
  expect((await call())?.dom.querySelector('progress')).not.toBeNull()
  rmSync(join(dataDirectory, 'display.json'), { recursive: true })
  writeFileSync(join(dataDirectory, 'display.json'), saved)
  writeFileSync(join(dataDirectory, 'display.json'), '{invalid')
  delete load.cache[path]
  const broken = load(path)
  expect(() => broken.activate({ dataDirectory })).toThrow()
  expect(readFileSync(join(dataDirectory, 'display.json'), 'utf8')).toBe('{invalid')
})

const deepseek = { ...model, providerName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }
const balance = { currency: 'CNY', total_balance: '110.00001', granted_balance: '10.00', topped_up_balance: '100.00001' }
const balancePayload = (changes = {}) => ({ is_available: true, balance_infos: [balance], ...changes })

it('recognizes DeepSeek URLs and displays exact balances and breakdowns without quota progress', async () => {
  fetcher.mockImplementation(async () => Response.json(balancePayload()))
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/anthropic']) {
    const result = await call({ model: { ...deepseek, baseUrl }, action: 'refresh' })
    expect(fetcher).toHaveBeenLastCalledWith('https://api.deepseek.com/user/balance', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }) }))
    expect(result?.title).toBe('DeepSeek 余额')
    expect(result?.dom.textContent).toContain('CNY 可用余额')
    expect(result?.dom.textContent).toContain('110.00001')
    expect(result?.dom.textContent).toContain('赠金余额')
    expect(result?.dom.textContent).toContain('100.00001')
    expect(result?.dom.querySelector('progress')).toBeNull()
    expect(result?.dom.textContent).not.toMatch(/重置|%/)
    expect(result?.error).toBeUndefined()
  }
  const compact = await call({ model: { ...deepseek, model: 'another-model' }, action: 'show_compact' })
  expect(compact?.dom.textContent).toContain('CNY 110.00001')
  expect(compact?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')).toContain('赠金余额: 10.00\n充值余额: 100.00001')
  expect(fetcher).toHaveBeenCalledTimes(3)
  for (const baseUrl of ['https://api.deepseek.com.example/v1', 'https://proxy.example/deepseek']) expect(await call({ model: { ...deepseek, baseUrl } })).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(3)
  await call()
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(fetcher.mock.calls[3][0]).toContain('minimaxi.com')
})

it('keeps currencies separate and reports zero or negative unavailable balances', async () => {
  fetcher.mockResolvedValueOnce(Response.json(balancePayload({ balance_infos: [balance, { ...balance, currency: 'USD', total_balance: '0.000001' }] })))
  const multi = await call({ model: deepseek, action: 'show_compact', language: 'en' })
  expect(multi?.dom.textContent).toContain('CNY 110.00001 · USD 0.000001')
  expect(multi?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')).toContain('Granted balance')
  fetcher.mockResolvedValueOnce(Response.json(balancePayload({ is_available: false, balance_infos: [{ ...balance, total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] })))
  const empty = await call({ model: deepseek, action: 'refresh' })
  expect(empty?.dom.textContent).toContain('CNY 0.00')
  expect(empty?.dom.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('余额不足')
  fetcher.mockResolvedValueOnce(Response.json(balancePayload({ is_available: false, balance_infos: [{ ...balance, total_balance: '-0.001' }] })))
  expect((await call({ model: deepseek, action: 'refresh' }))?.dom.textContent).toContain('CNY -0.001')
})

it('retains the last DeepSeek balance on invalid responses and clears notices after recovery', async () => {
  fetcher.mockResolvedValueOnce(Response.json(balancePayload()))
  const initial = await call({ model: deepseek })
  for (const data of [null, { error: { message: 'secret' } }, balancePayload({ is_available: 'false' }), balancePayload({ balance_infos: [balance, balance] }),
    balancePayload({ balance_infos: [{ ...balance, total_balance: 'NaN' }] }), balancePayload({ balance_infos: [{ ...balance, granted_balance: null }] })]) {
    fetcher.mockResolvedValueOnce(Response.json(data))
    const failed = await call({ model: deepseek, action: 'refresh' })
    expect(failed?.dom.textContent).toContain('110.00001')
    expect(failed?.updatedAt).toBe(initial?.updatedAt)
    expect(failed?.error).toBeTruthy()
    expect(failed?.html).not.toContain('secret')
  }
  fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
  expect((await call({ model: deepseek, action: 'refresh' }))?.error).toContain('API Key')
  fetcher.mockResolvedValueOnce(Response.json(balancePayload({ is_available: false, balance_infos: [] })))
  expect((await call({ model: deepseek, action: 'refresh' }))?.error).toContain('余额不足')
  fetcher.mockResolvedValueOnce(Response.json(balancePayload()))
  expect((await call({ model: deepseek, action: 'refresh' }))?.error).toBeUndefined()
})

it('queries Moonshot regional balances without summing negative cash and vouchers', async () => {
  const data = { code: 0, status: true, scode: '0x0', data: { available_balance: 46.58893, voucher_balance: 46.58893, cash_balance: -3.00001 } }
  fetcher.mockImplementation(async () => Response.json(data))
  for (const [host, currency] of [['api.moonshot.cn', 'CNY'], ['api.moonshot.ai', 'USD']]) {
    const provider = { ...model, providerName: 'Kimi', baseUrl: `https://${host}/v1` }
    const result = await call({ model: provider })
    expect(fetcher).toHaveBeenLastCalledWith(`https://${host}/v1/users/me/balance`, expect.anything())
    expect(result?.dom.textContent).toContain(`${currency} 可用余额`)
    expect(result?.dom.textContent).toContain('46.58893')
    expect(result?.dom.textContent).toContain('-3.00001')
    expect(result?.dom.querySelector('progress')).toBeNull()
    const compact = await call({ model: provider, action: 'show_compact', language: 'en' })
    expect(compact?.dom.textContent).toContain(`${currency} 46.58893`)
    expect(compact?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')).toContain('Voucher balance')
    await call({ model: provider, action: 'show_detailed' })
  }
  expect(fetcher).toHaveBeenCalledTimes(2)
  const provider = { ...model, baseUrl: 'https://api.moonshot.cn/v1' }
  fetcher.mockResolvedValueOnce(Response.json({ ...data, code: 1 }))
  const failed = await call({ model: provider, action: 'refresh' })
  expect(failed?.dom.textContent).toContain('46.58893')
  expect(failed?.error).toBeTruthy()
  fetcher.mockResolvedValueOnce(Response.json({ ...data, data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 } }))
  expect((await call({ model: provider, action: 'refresh' }))?.error).toContain('余额不足')
})

it('shows OpenRouter key limits and spend without presenting them as account balance', async () => {
  const provider = { ...model, providerName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }
  const data = { limit: 100, limit_remaining: 74.5, limit_reset: 'monthly', usage: 25.5, usage_daily: 0, usage_weekly: 3.5, usage_monthly: 5.5, expires_at: '2027-12-31T23:59:59Z' }
  fetcher.mockResolvedValueOnce(Response.json({ data }))
  const result = await call({ model: provider })
  expect(fetcher).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.anything())
  expect(result?.dom.textContent).toContain('USD 74.5')
  expect(result?.dom.textContent).toContain('今日消费（UTC）')
  expect(result?.dom.textContent).toContain('额度重置周期')
  expect(result?.dom.textContent).toContain('每月')
  expect(result?.dom.textContent).toContain('密钥到期时间')
  expect(result?.dom.textContent).toContain('不代表账户余额')
  expect(result?.dom.querySelector('progress')).toBeNull()
  await call({ model: provider, action: 'show_compact' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  fetcher.mockResolvedValueOnce(Response.json({ data: { ...data, limit: null, limit_remaining: null, limit_reset: null, expires_at: null } }))
  const unlimited = await call({ model: provider, action: 'refresh', language: 'en' })
  expect(unlimited?.dom.textContent).toContain('Key No cap')
  expect(unlimited?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')).toContain('not the account balance')
  fetcher.mockResolvedValueOnce(Response.json({ data: { ...data, limit: 0, limit_remaining: 0 } }))
  expect((await call({ model: provider, action: 'refresh' }))?.dom.textContent).toContain('密钥 USD 0')
  fetcher.mockResolvedValueOnce(Response.json({ data: { ...data, limit_remaining: null } }))
  expect((await call({ model: provider, action: 'refresh' }))?.dom.querySelector('[role="status"]')).not.toBeNull()
})

const glm = { ...model, providerName: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3' }
const glmPayload = (limits: unknown[]) => ({ code: 200, success: true, data: { limits } })
const glmOrdinary = { ...glm, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }
const glmBalancePayload = (changes = {}) => ({ code: 200, success: true, data: {
  availableBalance: 0.123456789, balance: 99, rechargeAmount: 20, totalSpendAmount: 18.5, frozenBalance: .25, ...changes
} })

it.each(['open.bigmodel.cn', 'api.z.ai'])('reads GLM quotas from %s with raw-key authentication across model protocols', async host => {
  fetcher.mockImplementation(async () => Response.json(glmPayload([
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 15 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 40 },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 25 }
  ])))
  for (const path of ['/api/anthropic', '/api/anthropic/', '/api/coding/paas/v4', '/api/coding/paas/v4/']) {
    const result = await call({ model: { ...glm, providerName: '', baseUrl: `https://${host}${path}` }, action: 'refresh' })
    expect(fetcher).toHaveBeenLastCalledWith(`https://${host}/api/monitor/usage/quota/limit`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'test-secret' }), redirect: 'error'
    }))
    expect(result?.title).toBe(`${host === 'api.z.ai' ? 'Z.ai' : 'GLM'} Coding Plan`)
    expect(result?.lines).toMatchObject([
      { label: '5 小时额度剩余', value: '75%', progress: .75 },
      { label: '每周额度剩余', value: '85%', progress: .85 },
      { label: 'MCP 每月额度剩余', value: '60%', progress: .6 }
    ])
    expect(result?.dom.textContent).not.toMatch(/余额|重置/)
  }
  for (const baseUrl of [`https://${host}.example/api/anthropic`, `https://proxy.example/${host}`]) {
    expect(await call({ model: { ...glm, baseUrl } })).toBeNull()
  }
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it.each(['open.bigmodel.cn', 'api.z.ai'])('hides unsupported %s API paths without a request', async host => {
  for (const path of [...(host === 'api.z.ai' ? ['/api/paas/v4', '/api/paas/v4/'] : []), '/', '/api',
    '/api/paas/v40', '/api/paas/v4-other',
    '/api/coding/paas/v40', '/api/anthropic-other', '/proxy/api/coding/paas/v4']) {
    expect(await call({ model: { ...glm, baseUrl: `https://${host}${path}` }, action: 'refresh' })).toBeNull()
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('keeps balance and plan caches separate when switching paths with the same key', async () => {
  fetcher.mockResolvedValueOnce(Response.json(glmPayload([{ type: 'CREDIT_LIMIT', unit: 3, percentage: 25 }])))
  const plan = await call({ model: glm })
  expect(plan?.lines[0].value).toBe('75%')
  fetcher.mockResolvedValueOnce(Response.json(glmBalancePayload()))
  const balance = await call({ model: glmOrdinary })
  expect(balance?.title).toBe('GLM 余额')
  expect(balance?.dom.textContent).toContain('0.123456789')
  expect(balance?.dom.querySelector('progress')).toBeNull()
  expect((await call({ model: glm }))?.lines).toEqual(plan?.lines)
  expect((await call({ model: glmOrdinary }))?.html).toBe(balance?.html)
  expect(fetcher).toHaveBeenCalledTimes(2)
  fetcher.mockResolvedValueOnce(Response.json(glmBalancePayload({ availableBalance: 8 })))
  expect((await call({ model: { ...glmOrdinary, apiKey: 'replacement' } }))?.dom.textContent).toContain('8')
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('queries the domestic GLM wallet with a raw key and preserves small balances in both display modes', async () => {
  fetcher.mockImplementation(async () => Response.json(glmBalancePayload()))
  for (const suffix of ['', '/', '?route=/api/coding/paas/v4']) {
    const result = await call({ model: { ...glmOrdinary, baseUrl: glmOrdinary.baseUrl + suffix }, action: 'refresh' })
    expect(fetcher).toHaveBeenLastCalledWith('https://open.bigmodel.cn/api/biz/account/query-customer-account-report', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'test-secret' }), redirect: 'error'
    }))
    expect(result?.title).toBe('GLM 余额')
    expect(result?.dom.textContent).toContain('CNY 可用余额')
    expect(result?.dom.textContent).toContain('0.123456789')
    expect(result?.dom.textContent).toContain('累计充值CNY 20')
    expect(result?.dom.textContent).toContain('累计消费CNY 18.5')
    expect(result?.dom.textContent).toContain('冻结余额CNY 0.25')
    expect(result?.dom.querySelector('progress')).toBeNull()
    expect(result?.error).toBeUndefined()
  }
  const compact = await call({ model: glmOrdinary, action: 'show_compact', language: 'en' })
  expect(compact?.title).toBe('GLM Balance')
  expect(compact?.dom.textContent).toContain('CNY 0.123456789')
  expect(compact?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')).toContain('Total top-ups: CNY 20')
  expect(compact?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')).toContain('excludes resource packages and Coding Plan quotas')
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('keeps zero and negative GLM balances without inferring model availability or inventing missing breakdowns', async () => {
  fetcher.mockResolvedValueOnce(Response.json(glmBalancePayload({ availableBalance: 0, rechargeAmount: null, totalSpendAmount: undefined, frozenBalance: 0 })))
  const result = await call({ model: glmOrdinary })
  expect(result?.dom.textContent).toContain('冻结余额CNY 0')
  expect(result?.dom.textContent).not.toMatch(/累计充值|累计消费|余额不足/)
  expect(result?.error).toBeUndefined()
  fetcher.mockResolvedValueOnce(Response.json(glmBalancePayload({ availableBalance: -0.001 })))
  const negative = await call({ model: glmOrdinary, action: 'refresh' })
  expect(negative?.dom.textContent).toContain('-0.001')
  expect(negative?.error).toBeUndefined()
})

it('retains the last GLM wallet reading on bad data and reports errors without raw diagnostics', async () => {
  fetcher.mockResolvedValueOnce(Response.json(glmBalancePayload()))
  const initial = await call({ model: glmOrdinary })
  for (const data of [null, { code: 200, success: true }, { ...glmBalancePayload(), success: false },
    glmBalancePayload({ availableBalance: null }), glmBalancePayload({ availableBalance: undefined }),
    glmBalancePayload({ availableBalance: '0.1' }), glmBalancePayload({ frozenBalance: 'invalid' }),
    { code: 500, success: false, msg: 'test-secret' }]) {
    fetcher.mockResolvedValueOnce(Response.json(data))
    const failed = await call({ model: glmOrdinary, action: 'refresh' })
    expect(failed?.dom.textContent).toContain('0.123456789')
    expect(failed?.updatedAt).toBe(initial?.updatedAt)
    expect(failed?.error).toBeTruthy()
    expect(failed?.html).not.toContain('test-secret')
  }
  for (const [code, error] of [[401, 'API Key'], [403, 'API Key'], [1001, 'API Key'], [1002, 'API Key'], [1003, 'API Key'], [429, '限流']]) {
    fetcher.mockResolvedValueOnce(Response.json({ code, success: false, msg: 'test-secret' }))
    expect((await call({ model: glmOrdinary, action: 'refresh' }))?.error).toContain(error)
  }
  fetcher.mockResolvedValueOnce(Response.json(glmBalancePayload({ availableBalance: 1 })))
  expect((await call({ model: glmOrdinary, action: 'refresh' }))?.error).toBeUndefined()
})

it('uses credit-plan percentages without mixing in old token or MCP allowances', async () => {
  fetcher.mockResolvedValueOnce(Response.json(glmPayload([
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 80 },
    { type: 'TIME_LIMIT', unit: 5, percentage: 50 },
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 0, usage: 0, currentValue: 0 },
    { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 100 }
  ])))
  const result = await call({ model: glm })
  expect(result?.lines.map(line => line.value)).toEqual(['100%', '0%'])
  const compact = await call({ model: { ...glm, id: 'next', model: 'glm-5.3-flash' }, action: 'show_compact', language: 'en' })
  expect(compact?.dom.textContent).toContain('5h 100% · 1w 0%')
  expect(compact?.dom.querySelector('[tabindex="0"]')?.getAttribute('title')).toContain('Weekly quota remaining 0%')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('uses GLM reset timestamps independently and recomputes countdowns from the cached response', async () => {
  vi.useFakeTimers()
  const now = Date.parse('2026-10-15T12:00:00Z')
  vi.setSystemTime(now)
  fetcher.mockResolvedValueOnce(Response.json(glmPayload([
    { type: 'CREDIT_LIMIT', unit: 3, percentage: 12.3, nextResetTime: now + 3600000 },
    { type: 'CREDIT_LIMIT', unit: 6, percentage: 42, nextResetTime: now + 86400000 }
  ])))
  const initial = await call({ model: glm })
  expect(initial?.lines).toMatchObject([
    { value: '87.7%', description: '约 1 小时后重置', detail: expect.stringContaining(new Date(now + 3600000).toLocaleString('zh-CN')) },
    { value: '58%', description: '约 1 天后重置' }
  ])
  vi.setSystemTime(now + 60000)
  const cached = await call({ model: glm, language: 'en' })
  expect(cached?.lines).toMatchObject([{ description: 'Resets in 59m' }, { description: 'Resets in 23h 59m' }])
  expect(cached?.updatedAt).toBe(initial?.updatedAt)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('reports a missing GLM plan and API failures without exposing raw diagnostics', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ code: 500, success: false, msg: '当前用户不存在coding plan' }))
  expect((await call({ model: glm }))?.error).toBe('当前账户未开通 GLM Coding Plan。')
  expect((await call({ model: glm, language: 'en' }))?.error).toBe('This account has no GLM Coding Plan.')
  expect(fetcher).toHaveBeenCalledTimes(1)
  for (const code of [401, 403, 1001, 1002, 1003]) {
    fetcher.mockResolvedValueOnce(Response.json({ code, success: false, msg: 'test-secret' }))
    expect((await call({ model: glm, action: 'refresh' }))?.error).toContain('API Key')
  }
  fetcher.mockResolvedValueOnce(Response.json({ code: 429, success: false }))
  expect((await call({ model: glm, action: 'refresh' }))?.error).toContain('限流')
  for (const data of [glmPayload([]), glmPayload([{ type: 'NEW_LIMIT', percentage: 0 }]),
    { code: 500, success: false, msg: 'test-secret' }, { ...glmPayload([{ type: 'CREDIT_LIMIT', unit: 3, percentage: 0 }]), success: false }]) {
    fetcher.mockResolvedValueOnce(Response.json(data))
    const result = await call({ model: glm, action: 'refresh' })
    expect(result?.lines).toHaveLength(0)
    expect(result?.error).toBeTruthy()
    expect(result?.html).not.toContain('test-secret')
  }
})

it('retains GLM readings on malformed quota values without inventing periods or reset times', async () => {
  const row = { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 25 }
  fetcher.mockResolvedValueOnce(Response.json(glmPayload([row])))
  const initial = await call({ model: glm })
  for (const invalid of [{ percentage: -1 }, { percentage: 101 }, { percentage: '25' }, { percentage: null }, { number: 1 }, { unit: 99 }]) {
    fetcher.mockResolvedValueOnce(Response.json(glmPayload([{ ...row, ...invalid }])))
    const failed = await call({ model: glm, action: 'refresh' })
    expect(failed?.lines).toEqual(initial?.lines)
    expect(failed?.updatedAt).toBe(initial?.updatedAt)
    expect(failed?.error).toBeTruthy()
  }
  fetcher.mockResolvedValueOnce(Response.json(glmPayload([row, row])))
  expect((await call({ model: glm, action: 'refresh' }))?.error).toBeTruthy()
  fetcher.mockResolvedValueOnce(Response.json(glmPayload([{ ...row, percentage: 0, nextResetTime: 'invalid' }])))
  const recovered = await call({ model: glm, action: 'refresh' })
  expect(recovered?.lines).toEqual([{ label: '5 小时额度剩余', value: '100%', progress: 1 }])
  expect(recovered?.error).toBeUndefined()
})
