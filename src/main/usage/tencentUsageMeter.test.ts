import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UsageMeterContent } from '../../renderer/src/ui/model/UsageMeter'
import { normalizeUsageSettings } from '@shared/usageMeter'
import { createUsageService } from './usageService'
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let service: ReturnType<typeof createUsageService>
let displayMode: 'compact' | 'detailed' = 'detailed'
let settings: Record<string, string | undefined>
const fetcher = vi.fn()
const model = { id: 'm1', model: 'hy4-flash', providerId: 'p1', providerName: 'Tencent', baseUrl: 'https://tokenhub.tencentmaas.com/v1', apiKey: 'model-key-unused-by-cloud-api' }
const balance = { RealBalance: 10963, CashAccountBalance: 10963, PresentAccountBalance: 0, FreezeAmount: 0, OweAmount: 0 }
const usage = { TotalStats: { TotalToken: 1200, InputTotalToken: 1000, OutputTotalToken: 200, CacheTotalToken: 500 } }
const personalPlan = { ProductType: 'personal-hunyuan', PackageStatus: 'ACTIVE', TotalCredits: '560', TotalUsed: '2.46858', CycleCredits: '560',
  TotalCycles: 1, CurrentCycle: 1, StartTime: '2026-11-24 16:03:37', ExpireTime: '2026-12-24 16:03:36', PeriodEndDate: '2026-12-24',
  AutoRenewFlag: 0, InputToken: 70291, OutputToken: 110 }
const planModel = { ...model, baseUrl: 'https://tokenhub.tencentmaas.com/plan/v3' }
const call = async (changes: Record<string, unknown> = {}) => {
  const selected = (changes.model ?? model) as typeof model
  const language = typeof changes.language === 'string' ? changes.language : 'zh-CN'
  const action = changes.action
  if (action === 'show_compact') displayMode = 'compact'
  if (action === 'show_detailed') displayMode = 'detailed'
  const usage = normalizeUsageSettings({ tencentSecretId: settings.tencent_secret_id, tencentSecretKey: settings.tencent_secret_key, tencentShowBalance: changes.showBalance }, selected.baseUrl)
  const content = await service.read({ ...selected, usage }, language, action === 'refresh', ['redisplay', 'show_compact', 'show_detailed'].includes(String(action)))
  const result = content && { title: content.title, html: renderToStaticMarkup(createElement(UsageMeterContent, { content, language, compact: displayMode === 'compact', onRefresh() {}, onToggle() {}, onSettings() {} })) }
  if (!result) return null
  const template = document.createElement('template')
  template.innerHTML = result.html
  return { ...result, text: template.content.textContent!, details: template.content.querySelector('[tabindex="0"]')?.getAttribute('data-tooltip'),
    error: template.content.querySelector('[role="status"]')?.textContent }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1795492800 * 1000)
  service = createUsageService()
  displayMode = 'detailed'
  settings = { tencent_secret_id: 'AKIDfixture', tencent_secret_key: 'fixture-secret-key' }
  fetcher.mockReset().mockImplementation(async (_url, options) => Response.json({ Response:
    options.headers['X-TC-Action'] === 'DescribeAccountBalance' ? balance
      : options.headers['X-TC-Action'] === 'DescribeTokenPlanPersonalPackage'
        ? { ProductType: JSON.parse(options.body).ProductType, PackageStatus: 'UNPURCHASED' }
      : JSON.parse(options.body).Period === 60 ? usage : { TotalStats: { TotalToken: 0, InputTotalToken: 0, OutputTotalToken: 0, CacheTotalToken: 0 } } }))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { service.clear(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('signs read-only Cloud API calls, converts fen to yuan and explains the account/region scope', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1795492800 * 1000)
  const result = await call({ model: { ...model, apiKey: '' } })
  expect(result?.title).toBe('Tencent TokenHub')
  expect(result?.text).toContain('109.63')
  expect(result?.text).toContain('1,200 tokens')
  expect(result?.details).toContain('缓存命中: 500 tokens')
  expect(result?.details).toContain('ap-guangzhou')
  expect(result?.details).toContain('不是当前模型密钥或对话的用量')
  expect(result?.error).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(fetcher).toHaveBeenCalledWith('https://billing.tencentcloudapi.com/', expect.objectContaining({
    method: 'POST', body: '{}', redirect: 'error', headers: expect.objectContaining({ 'X-TC-Version': '2018-07-09',
      // Fixed TC3 fixture, independently calculated with Python's hashlib/hmac.
      Authorization: 'TC3-HMAC-SHA256 Credential=AKIDfixture/2026-11-24/billing/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=f0c124d6e3ed9cb37afaa432bafda447af6410a59037313e39bc49421250dd41'
    })
  }))
  const [, request] = fetcher.mock.calls.find(([, options]) => options.headers['X-TC-Action'] === 'DescribeUsageRankList')!
  expect(JSON.parse(request.body)).toMatchObject({ Dimension: 'model', StartTime: '2026-11-01T00:00:00+08:00', Period: 86400, ShowAll: true })
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('fixture-secret-key')
  expect(result?.html).not.toContain('AKIDfixture')
  expect(result?.html).not.toContain(model.apiKey)
})

it('asks for model settings without making requests when either credential is missing', async () => {
  for (const next of [{}, { tencent_secret_id: 'id' }, { tencent_secret_id: 'id', tencent_secret_key: '  ' }]) {
    settings = next
    expect((await call())?.error).toContain('模型设置')
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('reuses cached data across layouts and models, and uses changed settings without restarting', async () => {
  const initial = await call()
  await call({ action: 'show_compact', language: 'en' })
  await call({ model: { ...model, model: 'other-model', apiKey: 'another-model-key' } })
  expect(fetcher).toHaveBeenCalledTimes(3)
  settings.tencent_secret_id = 'AKIDother-account'
  fetcher.mockImplementation(async (_url, options) => Response.json({ Response: options.headers['X-TC-Action'] === 'DescribeAccountBalance'
    ? { RealBalance: 500 } : { TotalStats: { TotalToken: 0 } } }))
  const switched = await call({ action: 'show_detailed' })
  expect(switched?.html).not.toContain('109.63')
  expect(fetcher).toHaveBeenCalledTimes(3) // Presentation changes cannot query the provider.
  expect((await call())?.text).toContain('5.00')
  expect(fetcher).toHaveBeenCalledTimes(6)
  settings.tencent_secret_key = 'different-secret-key'
  await call()
  expect(fetcher).toHaveBeenCalledTimes(9)
  settings.tencent_secret_key = ''
  const cleared = await call()
  expect(cleared?.error).toContain('模型设置')
  expect(cleared?.html).not.toContain('5.00')
  expect(initial?.text).toContain('109.63')
})

it('queries the selected ordinary TokenHub region, and keeps Singapore and Coding Plan URLs limited to cloud account balance', async () => {
  await call({ model: { ...model, baseUrl: 'https://tokenhub-intl.tencentmaas.com/' } })
  expect(fetcher.mock.calls.find(([, options]) => options.headers['X-TC-Action'] === 'DescribeUsageRankList')?.[1].headers['X-TC-Region']).toBe('ap-singapore')
  for (const baseUrl of ['https://tokenhub-intl.tencentmaas.com/plan/v3', 'https://tokenhub-intl.tencentmaas.com/plan/anthropic',
    'https://api.lkeap.cloud.tencent.com/coding/v3', 'https://api.lkeap.cloud.tencent.com/coding/anthropic']) {
    fetcher.mockClear()
    const result = await call({ model: { ...model, baseUrl }, action: 'refresh' })
    expect(result?.text).toContain('云账户可用余额')
    expect(result?.text).not.toContain('本月用量')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1].headers['X-TC-Action']).toBe('DescribeAccountBalance')
  }
  fetcher.mockClear()
  for (const baseUrl of ['https://tokenhub.tencentmaas.com.evil.test/v1', 'https://tokenhub.tencentmaas.com/unrecognized', 'https://api.lkeap.cloud.tencent.com/v1']) {
    expect(await call({ model: { ...model, baseUrl } })).toBeNull()
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('turns off the independent balance call while preserving monthly usage and refreshing the correct cache', async () => {
  const initial = await call()
  expect(initial?.text).toContain('109.63')
  fetcher.mockClear()
  const off = await call({ showBalance: false })
  expect(off?.text).toContain('1,200 tokens')
  expect(off?.text).not.toContain('109.63')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls.every(([, options]) => options.headers['X-TC-Action'] === 'DescribeUsageRankList')).toBe(true)
  const restored = await call({ showBalance: true, action: 'show_compact' })
  expect(restored?.text).toContain('￥ 109.63')
})

it('keeps personal plan queries enabled with balance off and makes no calls for balance-only URLs', async () => {
  mockPlans(personalPlan)
  const plan = await call({ model: planModel, showBalance: false })
  expect(plan?.text).toContain('99.56%')
  expect(plan?.text).not.toContain('109.63')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls.every(([, options]) => options.headers['X-TC-Action'] === 'DescribeTokenPlanPersonalPackage')).toBe(true)
  fetcher.mockClear()
  for (const baseUrl of ['https://tokenhub-intl.tencentmaas.com/plan/v3', 'https://api.lkeap.cloud.tencent.com/coding/v3']) {
    expect(await call({ model: { ...model, baseUrl }, showBalance: false })).toBeNull()
  }
  expect(fetcher).not.toHaveBeenCalled()
})

function mockPlans(hy: Record<string, unknown>, general: Record<string, unknown> = { ProductType: 'personal', PackageStatus: 'UNPURCHASED' }) {
  fetcher.mockImplementation(async (_url, options) => {
    if (options.headers['X-TC-Action'] === 'DescribeAccountBalance') return Response.json({ Response: balance })
    return Response.json({ Response: JSON.parse(options.body).ProductType === 'personal' ? general : hy })
  })
}

it.each(['/plan/v3', '/plan/anthropic'])('shows personal plan credits and time precision through %s', async path => {
  vi.setSystemTime(new Date('2026-11-24T08:30:00Z'))
  mockPlans(personalPlan)
  const result = await call({ model: { ...model, baseUrl: 'https://tokenhub.tencentmaas.com' + path } })
  expect(result?.text).toContain('Hy Token Plan')
  expect(result?.text).toContain('99.56%')
  expect(result?.text).toContain('周期结束: 2026-12-24')
  expect(result?.text).not.toContain('通用 Token Plan')
  expect(result?.details).toContain('通用 Token Plan\n状态: 未购买')
  expect(result?.details).toContain('总额度: 560 积分')
  expect(result?.details).toContain('已用: 2.46858 积分')
  expect(result?.details).toContain('剩余额度: 557.53142 积分')
  expect(result?.text).toContain('109.63')
  expect(result!.text.indexOf('云账户可用余额')).toBeLessThan(result!.text.indexOf('Hy Token Plan'))
  expect(result?.details).toContain('云账户可用余额 109.63')
  expect(result?.details).toContain('输入: 70,291 tokens')
  expect(result?.details).toContain('输出: 110 tokens')
  expect(result?.details).not.toContain('缓存命中:')
  expect(result?.details).toContain('自动续费: 关闭')
  expect(result?.details).toContain(new Date('2026-12-24T08:03:36Z').toLocaleString('zh-CN'))
  expect(result?.details).toContain('未与当前模型 API Key 核对')
  expect(result?.html).toContain('<progress')
  expect(result?.error).toBeUndefined()
  expect(fetcher).toHaveBeenCalledTimes(3)
  const queries = fetcher.mock.calls.filter(([, options]) => options.headers['X-TC-Action'] === 'DescribeTokenPlanPersonalPackage')
  expect(queries.map(([, options]) => JSON.parse(options.body))).toEqual([{ ProductType: 'personal' }, { ProductType: 'personal-hunyuan' }])
  for (const [url, options] of queries) {
    expect(url).toBe('https://tokenhub.tencentcloudapi.com/')
    expect(options.headers['X-TC-Region']).toBe('ap-guangzhou')
    expect(options.headers['X-TC-Version']).toBe('2026-03-22')
    expect(options.headers.Authorization).toContain('TC3-HMAC-SHA256 Credential=AKIDfixture/')
  }
  const english = await call({ model: planModel, language: 'en', action: 'show_compact' })
  expect(english?.text).toContain('Hy 99.56%')
  expect(english?.details).toContain('557.53142 Credits')
  expect(english?.details).toContain('Auto-renew: Off')
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('keeps General and Hy quota independent when both subscriptions exist, without using the selected model to choose a plan', async () => {
  mockPlans(personalPlan, { ...personalPlan, ProductType: 'personal', TotalCredits: '1560', TotalUsed: '780', CycleCredits: '780', TotalCycles: 2, CurrentCycle: 2 })
  const result = await call({ model: { ...planModel, model: 'hy4' } })
  expect(result?.text).toContain('通用 Token Plan')
  expect(result?.text).toContain('50%')
  expect(result?.text).toContain('99.56%')
  expect(result?.details).toContain('本计费周期内较早到期')
  expect((result?.html.match(/<progress /g) ?? [])).toHaveLength(2)
  const other = await call({ model: { ...planModel, model: 'glm-5.3' } })
  expect(other?.text).toEqual(result?.text)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('does not reuse Coding Plan balance-only cache for personal plans and vice versa', async () => {
  mockPlans(personalPlan)
  const codingModel = { ...model, baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3' }
  await call({ model: codingModel })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect((await call({ model: planModel }))?.text).toContain('99.56%')
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect((await call({ model: codingModel }))?.text).not.toContain('99.56%')
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it('preserves a successful plan when another query lacks permission', async () => {
  mockPlans(personalPlan, { Error: { Code: 'UnauthorizedOperation.CamNoAuth', Message: 'private upstream text' } })
  const result = await call({ model: planModel })
  expect(result?.text).toContain('99.56%')
  expect(result?.details).toContain('109.63')
  expect(result?.error).toContain('通用 Token Plan')
  expect(result?.error).toContain('查询权限')
  expect(result?.html).not.toContain('private upstream text')
})

it('does not invent quota for unpurchased, processing or stopped subscriptions', async () => {
  const unpurchased = await call({ model: planModel })
  expect(unpurchased?.html).not.toContain('<progress')
  expect(unpurchased?.details).toContain('未购买')
  for (const [status, text] of [['PROCESSING', '处理中'], ['STOPPED', '已停止'], ['USED_UP', '额度用尽']]) {
    mockPlans({ ProductType: 'personal-hunyuan', PackageStatus: status })
    const result = await call({ model: planModel, action: 'refresh' })
    expect(result?.text).toContain(text)
    expect(result?.html).not.toContain('<progress')
    expect(result?.details).not.toContain('剩余额度: 0')
    expect(result?.error).toBeUndefined()
  }
})

it.each([
  { TotalCredits: '' }, { TotalUsed: undefined }, { TotalUsed: '-1' }, { TotalCredits: 'Infinity' },
  { ProductType: 'personal' }, { PeriodEndDate: '2026-02-30' }, { ExpireTime: '2026-12-24 24:00:00' },
  { InputToken: -1 }, { AutoRenewFlag: '0' }
])('reports malformed plan data instead of displaying false quota: %j', async change => {
  mockPlans({ ...personalPlan, ...change })
  const result = await call({ model: planModel })
  expect(result?.text).toContain('109.63')
  expect(result?.error).toContain('Hy Token Plan')
  expect(result?.html).not.toContain('<progress')
  expect(result?.html).not.toContain('NaN')
})

it('shows zero and overspent credits as zero remaining without negative progress', async () => {
  mockPlans({ ...personalPlan, TotalCredits: '0', TotalUsed: '0' })
  const zero = await call({ model: planModel })
  expect(zero?.text).toContain('0 积分')
  expect(zero?.html).not.toContain('<progress')
  expect(zero?.error).toBeUndefined()
  mockPlans({ ...personalPlan, TotalUsed: '561' })
  const overspent = await call({ model: planModel, action: 'refresh' })
  expect(overspent?.text).toContain('0%')
  expect(overspent?.html).toContain('value="0"')
  expect(overspent?.details).toContain('已用: 561 积分')
})

it('does not reset credits or display expired cached quota as usable', async () => {
  mockPlans({ ...personalPlan, ExpireTime: '2026-11-24T04:01:00Z', StartTime: '2026-10-24 12:01:00', PeriodEndDate: '2026-11-24' })
  vi.setSystemTime(new Date('2026-11-24T04:00:00Z'))
  expect((await call({ model: planModel }))?.text).toContain('99.56%')
  vi.setSystemTime(new Date('2026-11-24T04:02:00Z'))
  const expired = await call({ model: planModel })
  expect(expired?.text).toContain('已到期，请刷新')
  expect(expired?.html).not.toContain('<progress')
  expect(fetcher).toHaveBeenCalledTimes(3)
  mockPlans({ ...personalPlan, PeriodEndDate: '2026-11-23' })
  const ended = await call({ model: planModel, action: 'refresh' })
  expect(ended?.text).toContain('周期已结束，请刷新')
  expect(ended?.html).not.toContain('<progress')
})

it('refreshes the monthly window at the China-time month boundary even while cached', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-30T15:59:30Z'))
  await call()
  vi.setSystemTime(new Date('2026-11-30T16:01:30Z'))
  await call()
  const requests = fetcher.mock.calls.filter(([, options]) => options.headers['X-TC-Action'] === 'DescribeUsageRankList')
  expect(requests).toHaveLength(3)
  expect(JSON.parse(requests[2][1].body).StartTime).toBe('2026-12-01T00:00:00+08:00')
  expect(JSON.parse(requests[2][1].body).Period).toBe(60)
})

it('adds disjoint historical and minute-level current-day usage instead of showing the daily rollup zero', async () => {
  const windows: { StartTime: string; EndTime: string; Period: number }[] = []
  fetcher.mockImplementation(async (_url, options) => {
    if (options.headers['X-TC-Action'] === 'DescribeAccountBalance') return Response.json({ Response: balance })
    const window = JSON.parse(options.body)
    windows.push(window)
    const stats = window.Period === 60
      ? { TotalToken: 1152567, InputTotalToken: 1141362, OutputTotalToken: 11205, CacheTotalToken: 977664 }
      : { TotalToken: 300, InputTotalToken: 280, OutputTotalToken: 20, CacheTotalToken: 100 }
    return Response.json({ Response: { TotalStats: stats } })
  })
  const result = await call()
  expect(result?.text).toContain('1,152,867 tokens')
  expect(result?.details).toContain('输入: 1,141,642 tokens')
  expect(result?.details).toContain('缓存命中: 977,764 tokens')
  expect(windows).toHaveLength(2)
  expect(windows[0]).toMatchObject({ StartTime: '2026-11-01T00:00:00+08:00', EndTime: '2026-11-24T00:00:00+08:00', Period: 86400 })
  expect(windows[1]).toMatchObject({ StartTime: windows[0].EndTime, Period: 60 })
  expect(Date.parse(windows[1].EndTime)).toBeLessThanOrEqual(Date.now())
  expect(result?.error).toBeUndefined()
})

it('does not present a successful segment as the entire month when another segment fails', async () => {
  fetcher.mockImplementation(async (_url, options) => {
    if (options.headers['X-TC-Action'] === 'DescribeAccountBalance') return Response.json({ Response: balance })
    return Response.json({ Response: JSON.parse(options.body).Period === 60 ? usage
      : { Error: { Code: 'UnauthorizedOperation.CamNoAuth', Message: 'denied' } } })
  })
  const result = await call()
  expect(result?.text).toContain('109.63')
  expect(result?.error).toContain('本月用量')
  expect(result?.error).toContain('查询权限')
  expect(result?.html).not.toContain('1,200 tokens')
  expect(result?.html).not.toContain('0 tokens')
})

it('does not invent missing breakdown fields or accept overflowing aggregate counts', async () => {
  fetcher.mockImplementation(async (_url, options) => {
    if (options.headers['X-TC-Action'] === 'DescribeAccountBalance') return Response.json({ Response: balance })
    return Response.json({ Response: { TotalStats: JSON.parse(options.body).Period === 60 ? usage.TotalStats : { TotalToken: 300 } } })
  })
  const initial = await call()
  expect(initial?.text).toContain('1,500 tokens')
  expect(initial?.details).not.toContain('缓存命中:')
  fetcher.mockImplementation(async (_url, options) => Response.json({ Response: options.headers['X-TC-Action'] === 'DescribeAccountBalance'
    ? balance : { TotalStats: { TotalToken: Number.MAX_SAFE_INTEGER } } }))
  const overflow = await call({ action: 'refresh' })
  expect(overflow?.error).toBeTruthy()
  expect(overflow?.text).toContain('109.63')
  expect(overflow?.text).not.toContain('tokens')
})

it('reports pending statistics during the first minute of a new month without an invalid time range', async () => {
  vi.setSystemTime(new Date('2026-11-30T16:00:30Z'))
  const result = await call()
  expect(result?.text).toContain('109.63')
  expect(result?.error).toContain('尚未生成')
  expect(result?.html).not.toContain('0 tokens')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][1].headers['X-TC-Action']).toBe('DescribeAccountBalance')
})

it('keeps valid balances on partial failures and previous readings on total failures without exposing server errors', async () => {
  fetcher.mockImplementation(async (_url, options) => Response.json({ Response: options.headers['X-TC-Action'] === 'DescribeAccountBalance'
    ? balance : { Error: { Code: 'UnauthorizedOperation.CamNoAuth', Message: 'upstream private request' } } }))
  const partial = await call()
  expect(partial?.text).toContain('109.63')
  expect(partial?.error).toContain('查询权限')
  expect(partial?.html).not.toContain('upstream private request')
  fetcher.mockResolvedValue(Response.json({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'private signature' } } }))
  const failed = await call({ action: 'refresh' })
  expect(failed?.text).toContain('109.63')
  expect(failed?.error).toContain('SecretId')
  expect(failed?.html).not.toContain('private signature')
})

it('does not turn missing or invalid fields into zero balance or usage', async () => {
  fetcher.mockResolvedValue(Response.json({ Response: {} }))
  const missing = await call()
  expect(missing?.error).toBeTruthy()
  expect(missing?.html).not.toContain('0.00')
  fetcher.mockImplementation(async (_url, options) => Response.json({ Response: options.headers['X-TC-Action'] === 'DescribeAccountBalance'
    ? { RealBalance: -125 } : { TotalStats: { TotalToken: -1 } } }))
  const partial = await call({ action: 'refresh' })
  expect(partial?.text).toContain('-1.25')
  expect(partial?.error).toBeTruthy()
  expect(partial?.text).not.toContain('-1 tokens')
})
