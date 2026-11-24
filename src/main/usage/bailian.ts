import { createHash, createHmac, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { UsageSettings } from '@shared/usageMeter'
import { requestJson } from './http'

export const bailianApi = {
  identity: 'zeldaEasy.cornerstone-portal.cs-console.loginInfo',
  planKey: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/api-keys/getKeyByUid',
  usage: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage',
  subscription: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription',
  keys: 'zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent',
  key: 'zeldaEasy.bailian-dash-workspace.api-key.getApiKey',
  free: 'zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota',
  monitor: 'zeldaEasy.bailian-telemetry.platform-model.getModelStatistic'
}
export function signTokenRequest(id: string, secret: string, now = new Date(), nonce: string = randomUUID()): RequestInit {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const headers: Record<string, string> = {
    host: 'modelstudio.cn-beijing.aliyuncs.com', 'content-type': 'application/json',
    'x-acs-action': 'GenerateCLIAccessToken', 'x-acs-version': '2026-02-10',
    'x-acs-date': now.toISOString().replace(/\.\d{3}Z$/, 'Z'), 'x-acs-signature-nonce': nonce, 'x-acs-content-sha256': hash('')
  }
  const names = Object.keys(headers).sort()
  const canonical = ['POST', '/modelstudio/cli/generateAccessToken', '', names.map(name => `${name}:${headers[name]}\n`).join(''), names.join(';'), hash('')].join('\n')
  const signature = createHmac('sha256', secret).update(`ACS3-HMAC-SHA256\n${hash(canonical)}`).digest('hex')
  headers.Authorization = `ACS3-HMAC-SHA256 Credential=${id},SignedHeaders=${names.join(';')},Signature=${signature}`
  return { method: 'POST', headers, body: '' }
}

function failure(value: unknown): Error {
  const text = JSON.stringify(value)
  if (/NotLogined/i.test(text)) return new Error('bailian_expired')
  if (/Team.NotAuthorised/i.test(text)) return new Error('bailian_member')
  if (/AuthorityPolicies.NoPermission/i.test(text)) return new Error(/智能体.?操作/.test(text) ? 'bailian_agent_permission' : 'bailian_permission')
  if (/NoPermission|Forbidden|NotAuthorized|AccessDenied/i.test(text)) return new Error('bailian_permission')
  return new Error('response')
}
export function unwrapBailian(value: any): any {
  let data = value
  for (let depth = 0; depth < 8 && data && typeof data === 'object'; depth++) {
    if (data.success === false || data.failed === true || data.successResponse === false) throw failure(data)
    if (data.ret !== undefined && (!Array.isArray(data.ret) || !data.ret.every((item: unknown) => typeof item === 'string' && item.startsWith('SUCCESS')))) throw failure(data)
    if (data.Code || data.code && ![200, '200', 'SUCCESS'].includes(data.code)) throw failure(data)
    if (data.DataV2 !== undefined) { data = data.DataV2; continue }
    if (data.data !== undefined) { data = data.data; continue }
    return data
  }
  throw new Error('response')
}
export function maskedMatch(mask: unknown, key: string): boolean {
  if (typeof mask !== 'string') return false
  const match = /^(sk-sp-[^*…]+)\*+([^*…]+)$/.exec(mask)
  return Boolean(match && match[1].length >= 15 && match[2].length >= 15 && key.length > match[1].length + match[2].length && key.startsWith(match[1]) && key.endsWith(match[2]))
}

/** One client per provider context. Resetting that context aborts all work and discards this token. */
export function createBailianClient(settings: UsageSettings) {
  const id = settings.bailianAccessKeyId.trim(), secret = settings.bailianAccessKeySecret.trim()
  let token: { value: string; until: number } | undefined
  let pending: Promise<string> | undefined
  async function getToken(signal: AbortSignal): Promise<string> {
    if (!id || !secret) throw new Error('bailian_config')
    if (token && token.until > Date.now()) return token.value
    pending ??= requestJson('https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken', { ...signTokenRequest(id, secret), signal })
      .then(data => {
        if (typeof data.cliAccessToken !== 'string' || !data.cliAccessToken) throw new Error('bailian_token')
        token = { value: data.cliAccessToken, until: Date.now() + 5 * 60_000 }
        return token.value
      }).catch(() => { throw new Error('bailian_token') }).finally(() => { pending = undefined })
    return pending
  }
  async function call(api: string, data: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const bearer = await getToken(signal)
      try {
        return unwrapBailian(await requestJson(`https://bailian-cs.console.aliyun.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(api)}`, {
          method: 'POST', signal, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ region: 'cn-beijing', params: JSON.stringify({ Api: api, V: '1.0', Data: {
            ...data, cornerstoneParam: { protocol: 'V2', console: 'ONE_CONSOLE', productCode: 'p_efm', switchUserType: 3, consoleSite: 'BAILIAN_ALIYUN' }
          } }) }).toString()
        }))
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'bailian_expired' || attempt !== 0) throw error
        if (token?.value === bearer) token = undefined
      }
    }
  }
  async function identity(signal: AbortSignal) {
    const info = await call(bailianApi.identity, {}, signal)
    if (info.loginStatus !== 'ALIYUN_LOGINED') throw new Error('bailian_expired')
    if (!info.aliyun || typeof info.aliyun.uid !== 'string' || !info.aliyun.uid) throw new Error('response')
    return { uid: info.aliyun.uid, parentUid: info.aliyun.parentUid, name: info.aliyun.nickName || info.aliyun.userName || info.aliyun.uid }
  }
  async function read(model: { baseUrl: string; apiKey: string; model: string }, signal: AbortSignal) {
    if (!model.apiKey || model.apiKey.includes('*')) throw new Error('auth')
    const plan = new URL(model.baseUrl).hostname.startsWith('token-plan.')
    if (plan !== model.apiKey.startsWith('sk-sp-')) throw new Error('bailian_key_type')
    const user = await identity(signal)
    let result: any
    if (plan) {
      const key = await call(bailianApi.planKey, {}, signal)
      if (!key.key_id || !maskedMatch(key.mask_apikey, model.apiKey)) throw new Error('bailian_mismatch')
      const [usage, subscription] = await Promise.all([
        call(bailianApi.usage, {}, signal), call(bailianApi.subscription, { queryInstanceInfoRequest: {} }, signal)
      ])
      if (Array.isArray(usage) || Array.isArray(subscription)) throw new Error('response')
      result = { plan, usage, subscription }
    } else {
      let keyInfo: { id: string; workspace: string; workspaceName?: string } | undefined
      for (let pageNo = 1; pageNo <= 50; pageNo++) {
        const page = await call(bailianApi.keys, { pageNo, pageSize: 50 }, signal)
        if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0) throw new Error('response')
        for (const item of page.items) {
          if (typeof item.key !== 'string') throw new Error('response')
          const parts = item.key.split(/\*+/)
          if (!(parts.length === 1 ? item.key === model.apiKey : parts.length === 2 && parts.every(Boolean) && model.apiKey.startsWith(parts[0]) && model.apiKey.endsWith(parts[1]))) continue
          const detail = await call(bailianApi.key, { reqDTO: { id: item.id }, _params: { apiKeyId: item.id } }, signal)
          if (typeof detail.key !== 'string' || detail.key.includes('*') || detail.key !== model.apiKey) continue
          if (detail.blocked || item.deleted) throw new Error('bailian_disabled')
          if (!detail.workspace_id || !detail.id) throw new Error('response')
          keyInfo = { id: String(detail.id), workspace: String(detail.workspace_id), workspaceName: detail.workspace_name }
          break
        }
        if (keyInfo || pageNo * 50 >= page.total) break
        if (!page.items.length || pageNo === 50) throw new Error('response')
      }
      if (!keyInfo) throw new Error('bailian_mismatch')
      const endTime = Date.now()
      const reqDTO = { workspaceId: keyInfo.workspace, apikeyIds: [keyInfo.id], startTime: endTime - 7 * 86400_000, endTime, modelCallSource: 'Online' }
      const [free, stats] = await Promise.all([
        call(bailianApi.free, { queryFreeTierQuotaRequest: { models: [model.model] } }, signal),
        (async () => {
          let stats = await call(bailianApi.monitor, { reqDTO }, signal)
          for (let attempt = 0; stats.taskId && attempt < 40; attempt++) {
            await delay(500, undefined, { signal })
            stats = await call(bailianApi.monitor, { reqDTO: { ...reqDTO, asyncTaskId: stats.taskId } }, signal)
          }
          if (stats.taskId) throw new Error('timeout')
          return stats
        })()
      ])
      result = { plan, keyInfo, free, stats }
    }
    const after = await identity(signal)
    if (after.uid !== user.uid || after.parentUid !== user.parentUid) throw new Error('bailian_mismatch')
    return { ...result, user }
  }
  return { read, call }
}
