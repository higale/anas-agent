import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizeUsageSettings } from '@shared/usageMeter'
import { bailianApi, createBailianClient, maskedMatch, signTokenRequest, unwrapBailian } from './bailian'
import { parseBailian } from './bailianPresentation'
import { createUsageService } from './usageService'
const url = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const settings = normalizeUsageSettings({ bailianAccessKeyId: 'fixture-id', bailianAccessKeySecret: 'fixture-secret' }, url)
const model = { id: 'model', providerId: 'provider', baseUrl: url, model: 'qwen4-max', apiKey: 'sk-sp-123456789-middle-987654321abcdef', usage: settings }
const user = { uid: 'ram-fixture', parentUid: 'parent-fixture', nickName: 'Fixture user' }
const responses = () => ({
  [bailianApi.identity]: { loginStatus: 'ALIYUN_LOGINED', aliyun: user },
  [bailianApi.planKey]: { key_id: 'fixture-id', mask_apikey: 'sk-sp-123456789-****987654321abcdef' },
  [bailianApi.usage]: { per1MonthPercentage: .0361150145, per1MonthResetTime: 1797868800000 },
  [bailianApi.subscription]: { status: 'VALID', specCode: 'lite', autoRenewFlag: false, endTime: 1797868800000 },
  [bailianApi.keys]: { total: 1, items: [{ id: 'ordinary-id', key: 'sk-ord***ending' }] },
  [bailianApi.key]: { id: 'ordinary-id', key: 'sk-ordinary-fixture-ending', workspace_id: 'workspace-fixture', blocked: false },
  [bailianApi.free]: { freeTierQuotas: [{ model: 'qwen4-max', quotaStatus: 'VALID', quotaTotal: 0, quotaInitTotal: 100 }] },
  [bailianApi.monitor]: { callCount: 0, callFailedCount: 0, usages: [] }
})
const fetcher = vi.fn()
const balanceResponse = { Code: '200', Success: true, Data: { Currency: 'CNY', AvailableCashAmount: '692.06', AvailableAmount: '700.00', CreditAmount: '7.94' } }
let data: Record<string, any>
beforeEach(() => {
  data = responses()
  fetcher.mockReset().mockImplementation(async (requestUrl: string) => {
    if (requestUrl.includes('generateAccessToken')) return Response.json({ cliAccessToken: 'fixture-token' })
    const api = new URL(requestUrl).searchParams.get('api')!
    return Response.json({ successResponse: true, data: { DataV2: { ret: ['SUCCESS::ok'], data: { success: true, data: data[api] } } } })
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it.each(['failure', 'clear', 'timeout'])('cancels every parallel request on %s and permits a subsequent refresh', async reason => {
  if (reason === 'timeout') vi.useFakeTimers()
  const signals: AbortSignal[] = []
  fetcher.mockImplementation(async (request: string, options: RequestInit) => {
    if (request.includes('generateAccessToken')) return Response.json({ cliAccessToken: 'fixture-token' })
    const api = new URL(request).searchParams.get('api')!
    if (api === bailianApi.usage && reason === 'failure') return Response.json({ success: false, message: 'NoPermission' })
    if (api === bailianApi.subscription || api === bailianApi.usage) {
      const signal = options.signal!
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return Response.json(data[api])
  })
  const service = createUsageService()
  const pending = service.read(model, 'en')
  await vi.waitFor(() => expect(signals.length).toBe(reason === 'failure' ? 1 : 2))
  if (reason === 'clear') service.clear()
  if (reason === 'timeout') await vi.advanceTimersByTimeAsync(30_000)
  const result = await pending
  expect(signals.every(signal => signal.aborted)).toBe(true)
  if (reason === 'clear') expect(result).toBeNull()
  else expect(result?.error).toContain(reason === 'failure' ? 'permissions' : 'timed out')
  fetcher.mockImplementation(async (request: string) => request.includes('generateAccessToken')
    ? Response.json({ cliAccessToken: 'fixture-token' }) : Response.json(data[new URL(request).searchParams.get('api')!]))
  expect((await service.read(model, 'en', true))?.lines[0].value).toBe('96.39%')
  service.clear()
})
it('uses the ACS3 empty-body signature with an independently calculated fixture', () => {
  const request = signTokenRequest('fixture-id', 'fixture-secret', new Date('2026-11-24T00:00:00Z'), 'fixture-nonce')
  expect((request.headers as Record<string, string>).Authorization).toContain('Signature=ee38b3265b116f684c08059bfdfdee44b1c8b2a73f9fc35e0bf4415bffe846b3')
  expect(request.body).toBe('')
  expect(JSON.stringify(request)).not.toContain('fixture-secret')
})
it('matches plan keys, preserves zero/false and supports actual quota windows', async () => {
  data[bailianApi.usage].per2DayPercentage = 1.2
  const client = createBailianClient(settings)
  const result = await client.read(model, AbortSignal.timeout(5000))
  const content = parseBailian(result, 'zh-CN', model.model)
  expect(content.lines.map(line => line.value)).toEqual(['96.39%', '0.00%'])
  expect(content.lines[0]).toMatchObject({ label: '月额度剩余', compactLabel: '月' })
  expect(content.lines[1]).toMatchObject({ label: '2 天 剩余', compactLabel: '2 天' })
  expect(parseBailian(result, 'en', model.model).lines[0]).toMatchObject({ label: 'Monthly quota remaining', compactLabel: 'Month' })
  expect(content.detailGroups?.some(group => group.text.includes('自动续费: 关闭'))).toBe(true)
  expect(JSON.stringify(content)).not.toContain(model.apiKey)
  const calls = fetcher.mock.calls
  const gateway = calls.find(([request]) => request.includes('api.json'))!
  expect(gateway[1].headers.Authorization).toBe('Bearer fixture-token')
  const envelope = JSON.parse(new URLSearchParams(gateway[1].body).get('params')!)
  expect(envelope.Data.cornerstoneParam.switchUserType).toBe(3)
})
it('never accepts a trivial mask or displays another account’s plan', async () => {
  expect(maskedMatch('sk-sp-***end', model.apiKey)).toBe(false)
  data[bailianApi.planKey].mask_apikey = 'sk-sp-987654321-****123456789abcdef'
  await expect(createBailianClient(settings).read(model, AbortSignal.timeout(5000))).rejects.toThrow('bailian_mismatch')
  expect(fetcher.mock.calls.some(([request]) => request.includes(encodeURIComponent(bailianApi.usage)))).toBe(false)
})
it('checks errors at each envelope layer and separates the two permission stages', () => {
  expect(() => unwrapBailian({ successResponse: false, message: 'BailianGateway.Team.NotAuthorised' })).toThrow('bailian_member')
  expect(() => unwrapBailian({ data: { DataV2: { ret: ['FAIL::BailianGateway.AuthorityPolicies.NoPermission 智能体-操作'] } } })).toThrow('bailian_agent_permission')
  expect(() => unwrapBailian({ data: { success: false, private: 'do not expose' } })).toThrow('response')
})
it('refreshes an expired token once and coalesces concurrent token requests', async () => {
  let rejected = false
  fetcher.mockImplementation(async (request: string) => {
    if (request.includes('generateAccessToken')) return Response.json({ cliAccessToken: rejected ? 'new-token' : 'old-token' })
    if (!rejected) { rejected = true; return Response.json({ success: false, message: 'NotLogined' }) }
    return Response.json({ data: { result: true } })
  })
  const client = createBailianClient(settings), signal = AbortSignal.timeout(5000)
  await Promise.all([client.call('fixture-a', {}, signal), client.call('fixture-b', {}, signal)])
  expect(fetcher.mock.calls.filter(([request]) => request.includes('generateAccessToken'))).toHaveLength(2)
  fetcher.mockImplementation(async (request: string) => request.includes('generateAccessToken')
    ? Response.json({ cliAccessToken: 'bad' }) : Response.json({ success: false, message: 'NotLogined' }))
  await expect(createBailianClient(settings).call('fixture', {}, signal)).rejects.toThrow('bailian_expired')
})
it('matches the full ordinary key and sends only its workspace/key scope to online monitoring', async () => {
  const ordinary = { ...model, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-ordinary-fixture-ending' }
  const result = await createBailianClient(settings).read(ordinary, AbortSignal.timeout(5000))
  const content = parseBailian(result, 'zh-CN', model.model)
  expect(content.lines.map(line => line.value)).toEqual(['0', '0'])
  expect(content.detailGroups?.at(-1)?.text).toContain('未返回此 Key 的 Token 明细')
  const monitor = fetcher.mock.calls.find(([request]) => request.includes(encodeURIComponent(bailianApi.monitor)))!
  const params = JSON.parse(new URLSearchParams(monitor[1].body).get('params')!)
  expect(params.Data.reqDTO).toMatchObject({ workspaceId: 'workspace-fixture', apikeyIds: ['ordinary-id'], modelCallSource: 'Online' })
  data[bailianApi.key].key = 'sk-ord***ending'
  await expect(createBailianClient(settings).read(ordinary, AbortSignal.timeout(5000))).rejects.toThrow('bailian_mismatch')
})
it('keeps unknown free quotas and missing statistics distinct from zero', async () => {
  data[bailianApi.free].freeTierQuotas[0] = { model: 'qwen4-max', quotaStatus: 'UNKNOWN' }
  data[bailianApi.monitor] = {}
  const result = await createBailianClient(settings).read({ ...model, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-ordinary-fixture-ending' }, AbortSignal.timeout(5000))
  expect(parseBailian(result, 'en', model.model).lines).toEqual([])
})
it('clears previous Bailian readings on a failed refresh and bounds cache lifetime', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const service = createUsageService()
  expect((await service.read(model, 'en'))?.lines[0].value).toBe('96.39%')
  fetcher.mockRejectedValue(new Error('private upstream payload'))
  const failed = await service.read(model, 'en', true)
  expect(failed?.lines).toEqual([])
  expect(JSON.stringify(failed)).not.toContain('private upstream')
  service.clear()
})

it('queries balance only when enabled and invalidates cached balances immediately when disabled', async () => {
  const original = fetcher.getMockImplementation()!
  fetcher.mockImplementation(async (...args) => args[0] === 'https://business.aliyuncs.com/' ? Response.json(balanceResponse) : original(...args))
  const service = createUsageService()
  await service.read(model, 'zh-CN')
  expect(fetcher.mock.calls.some(([url]) => url === 'https://business.aliyuncs.com/')).toBe(false)
  const enabled = { ...model, usage: { ...settings, bailianShowBalance: true } }
  service.reconcile([enabled])
  const result = await service.read(enabled, 'zh-CN')
  expect(result?.lines).toMatchObject([{ label: '阿里云账户余额', compactLabel: 'CNY', value: '692.06' }, { value: '96.39%' }])
  expect(result?.lines[0].breakdown).toContainEqual({ label: '可用额度', value: 'CNY 700.00' })
  expect(fetcher.mock.calls.filter(([url]) => url === 'https://business.aliyuncs.com/')).toHaveLength(1)
  const count = fetcher.mock.calls.length
  expect((await service.read(enabled, 'en', false, true))?.lines[0].label).toBe('Alibaba Cloud account balance')
  expect(fetcher).toHaveBeenCalledTimes(count)
  service.reconcile([model])
  expect((await service.read(model, 'zh-CN', false, true))?.lines).toEqual([])
  expect((await service.read(model, 'zh-CN'))?.lines).toHaveLength(1)
  expect(fetcher.mock.calls.filter(([url]) => url === 'https://business.aliyuncs.com/')).toHaveLength(1)
  service.clear()
})

it.each(['balance denied', 'usage denied', 'bad usage', 'bad balance'])('keeps the independent successful result when %s', async failure => {
  const original = fetcher.getMockImplementation()!
  if (failure === 'bad usage') data[bailianApi.usage].per1MonthPercentage = 'invalid'
  fetcher.mockImplementation(async (...args) => {
    if (args[0] === 'https://business.aliyuncs.com/') {
      if (failure === 'balance denied') return Response.json({ Code: 'NoPermission', Success: false, Message: 'private response' })
      if (failure === 'bad balance') return Response.json({ ...balanceResponse, Data: { ...balanceResponse.Data, AvailableCashAmount: null } })
      return Response.json(balanceResponse)
    }
    if (failure === 'usage denied') return new Response('private response', { status: 403 })
    return original(...args)
  })
  const service = createUsageService(), enabled = { ...model, usage: { ...settings, bailianShowBalance: true } }
  const result = await service.read(enabled, 'zh-CN')
  expect(result?.lines).toHaveLength(1)
  expect(result?.lines[0].value).toBe(failure.includes('balance') ? '96.39%' : '692.06')
  expect(result?.error).toBeTruthy()
  expect(JSON.stringify(result)).not.toContain('private response')
  if (failure === 'balance denied') expect(result?.error).toContain('AliyunBSSReadOnlyAccess')
  service.clear()
})

it('cancels a pending balance query when settings change and discards its late response', async () => {
  const original = fetcher.getMockImplementation()!
  let signal!: AbortSignal, complete!: (response: Response) => void
  fetcher.mockImplementation(async (...args) => {
    if (args[0] !== 'https://business.aliyuncs.com/') return original(...args)
    signal = args[1].signal
    return new Promise<Response>(resolve => { complete = resolve })
  })
  const service = createUsageService(), enabled = { ...model, usage: { ...settings, bailianShowBalance: true } }
  const pending = service.read(enabled, 'en')
  await vi.waitFor(() => expect(signal).toBeDefined())
  service.reconcile([model])
  expect(signal.aborted).toBe(true)
  complete(Response.json(balanceResponse))
  expect(await pending).toBeNull()
  service.clear()
})
