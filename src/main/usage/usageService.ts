import { createHash } from 'node:crypto'
import { normalizeUsageSettings, usageEndpoint, type UsageContent, type UsageEndpoint, type UsageSettings } from '@shared/usageMeter'
import { requestJson } from './http'
import * as parsers from './parsers'
import * as tencent from './tencent'
import { createBailianClient } from './bailian'
import { parseBailian } from './bailianPresentation'
import { aliyunBalanceLine, queryAliyunBalance } from './aliyunBalance'

export interface UsageModel { id: string; providerId: string; model: string; baseUrl: string; apiKey?: string; usage?: UsageSettings }
const errors: Record<string, [string, string]> = {
  auth: ['请检查当前模型的 API Key。', 'Check the current model API key.'],
  rate: ['查询受到限流，请稍后刷新。', 'Rate limited. Try again later.'],
  network: ['用量查询失败，请稍后刷新。', 'Usage query failed. Try again later.'],
  response: ['无法识别用量数据，请稍后重试或更新 Anas。', 'Unrecognized usage data. Retry later or update Anas.'],
  timeout: ['用量查询超时，请稍后刷新。', 'Usage query timed out. Try again later.'],
  quota: ['套餐未返回通用额度。', 'The plan returned no general quota.'],
  glm_plan: ['当前账户未开通 GLM Coding Plan。', 'This account has no GLM Coding Plan.'],
  glm_quota: ['GLM Coding Plan 未返回可识别的额度。', 'No recognized GLM Coding Plan quota returned.'],
  tencent_config: ['请在模型设置的用量设置中填写 SecretId 和 SecretKey。', 'Enter SecretId and SecretKey in the model usage settings.'],
  tencent_auth: ['腾讯查询凭据无效，请检查 SecretId 和 SecretKey。', 'Check the Tencent SecretId and SecretKey.'],
  tencent_permission: ['腾讯查询权限不足，请检查云账户授权。', 'Check the Tencent cloud account permissions.'],
  bailian_config: ['请在模型设置的用量设置中填写 AccessKey ID 和 Secret。', 'Enter AccessKey ID and Secret in the model usage settings.'],
  bailian_token: ['百炼临时令牌获取失败，请检查 RAM AccessKey 及其阿里云 API 权限。', 'Could not obtain a Bailian token. Check the RAM AccessKey and Alibaba Cloud API permissions.'],
  bailian_member: ['请在百炼“账号管理”添加此 RAM 用户，再到“权限管理”配置北京业务空间权限。', 'Add this RAM user in Bailian Account Management, then configure Beijing workspace permissions in Permission Management.'],
  bailian_agent_permission: ['请在百炼“权限管理”中选择业务空间，添加“智能体-操作”权限。', 'In Bailian Permission Management, select the workspace and add “Agent operations” (智能体-操作).'],
  bailian_permission: ['百炼查询权限不足，请检查百炼用户及业务空间授权。', 'Check the Bailian user and workspace permissions.'],
  bailian_expired: ['百炼临时令牌失效，请刷新或检查查询凭据。', 'Bailian token expired. Refresh or check the credentials.'],
  bailian_mismatch: ['当前模型 API Key 与查询账户不匹配，或查询账户无权读取完整 Key。', 'The model API key does not match the query account, or the account cannot read its full key.'],
  bailian_disabled: ['当前模型 API Key 已停用。', 'The model API key is disabled.'],
  bailian_key_type: ['当前 API Key 类型与 API 地址不匹配。', 'The API key type does not match this endpoint.'],
  bailian_balance_permission: ['阿里云余额查询无权限或凭据无效，请检查 RAM AccessKey 及 AliyunBSSReadOnlyAccess 权限。', 'Alibaba Cloud balance access was denied. Check the RAM AccessKey and AliyunBSSReadOnlyAccess permission.'],
  bailian_balance_failed: ['阿里云余额查询失败，请刷新重试。', 'Could not query the Alibaba Cloud balance. Refresh to retry.'],
  bailian_balance_timeout: ['阿里云余额查询超时，请刷新重试。', 'Alibaba Cloud balance query timed out. Refresh to retry.']
}

function errorCode(error: unknown): string { return error instanceof Error && Object.hasOwn(errors, error.message) ? error.message : 'network' }

function presentation(endpoint: UsageEndpoint, data: any, model: UsageModel, language: string): UsageContent {
  const zh = language.startsWith('zh')
  const host = new URL(model.baseUrl).hostname
  let title = '', parsed: Partial<UsageContent> = {}
  switch (endpoint.provider) {
    case 'bailian': {
      const content: UsageContent = data.usage ? parseBailian(data.usage, language, model.model) : { title: zh ? '百炼' : 'Bailian', lines: [] }
      if (data.balance) content.lines.unshift(aliyunBalanceLine(data.balance, language))
      const failures = [data.usageError, data.balanceError].filter(Boolean) as string[]
      if (failures.length) {
        content.error = failures.map(code => errors[code][zh ? 0 : 1]).join('\n')
        content.configurationRequired = failures.some(code => /^(auth|bailian_)/.test(code))
      }
      return content
    }
    case 'tencent': title = 'Tencent TokenHub'; parsed = tencent.parse(data, language); break
    case 'minimax': title = 'MiniMax Token Plan'; parsed = parsers.parseQuota(data, language); break
    case 'deepseek': title = `DeepSeek ${zh ? '余额' : 'Balance'}`; parsed = parsers.parseBalance(data, language); break
    case 'moonshot': title = `Moonshot ${zh ? '余额' : 'Balance'}`; parsed = parsers.parseMoonshot(data, language, host.endsWith('.cn') ? 'CNY' : 'USD'); break
    case 'openrouter': title = `OpenRouter ${zh ? '密钥额度' : 'Key credits'}`; parsed = parsers.parseOpenRouter(data, language); break
    case 'glm': title = `${host === 'api.z.ai' ? 'Z.ai' : 'GLM'} ${endpoint.kind === 'plan' ? 'Coding Plan' : zh ? '余额' : 'Balance'}`; parsed = endpoint.kind === 'plan' ? parsers.parseGlmQuota(data, language) : parsers.parseGlmBalance(data, language); break
    case 'mimo': title = `MiMo ${endpoint.kind === 'plan' ? 'Token Plan' : zh ? '余额' : 'Balance'}`; parsed = endpoint.kind === 'plan' ? parsers.parseMimoQuota(data, language) : parsers.parseMimoBalance(data, language); break
  }
  return { title, lines: [], ...parsed }
}
interface Entry {
  signature: string
  providerId: string
  modelName: string
  endpoint: UsageEndpoint
  data?: any
  updatedAt?: number
  error?: string
  nextAt: number
  failures: number
  pending?: Promise<void>
  controller?: AbortController
  bailian?: ReturnType<typeof createBailianClient>
}

export function createUsageService() {
  const cache = new Map<string, Entry>()
  const signature = (model: UsageModel) => {
    const endpoint = usageEndpoint(model.baseUrl), settings = normalizeUsageSettings(model.usage, model.baseUrl)
    const credentials = endpoint?.provider === 'tencent' ? [settings.tencentSecretId, settings.tencentSecretKey]
      : endpoint?.provider === 'bailian' ? [model.apiKey, settings.bailianAccessKeyId, settings.bailianAccessKeySecret] : [model.apiKey]
    return createHash('sha256').update(JSON.stringify([endpoint, credentials, endpoint?.provider === 'tencent' ? tencent.monthStart() : '',
      endpoint?.provider === 'tencent' ? settings.tencentShowBalance : endpoint?.provider === 'bailian' && settings.bailianShowBalance])).digest('hex')
  }
  function clear() { for (const entry of cache.values()) entry.controller?.abort(); cache.clear() }
  function reconcile(models: UsageModel[]) {
    for (const [key, entry] of cache) {
      const model = models.find(model => model.providerId === entry.providerId && (entry.endpoint.provider !== 'bailian' || entry.endpoint.kind === 'plan' || model.model === entry.modelName))
      if (!model || !normalizeUsageSettings(model.usage, model.baseUrl).enabled || signature(model) !== entry.signature) { entry.controller?.abort(); cache.delete(key) }
    }
  }
  async function read(model: UsageModel, language: string, refresh = false, presentationOnly = false): Promise<UsageContent | null> {
    const endpoint = usageEndpoint(model.baseUrl), settings = normalizeUsageSettings(model.usage, model.baseUrl)
    if (!endpoint || !settings.enabled) return null
    if (endpoint.provider === 'tencent' && !settings.tencentShowBalance && endpoint.kind !== 'usage' && !endpoint.personalPlans) return null
    const hash = signature(model)
    const key = `${model.providerId}:${hash}:${endpoint.provider === 'bailian' && endpoint.kind !== 'plan' ? model.model : ''}`
    let entry = cache.get(key)
    if (!entry) {
      if (cache.size >= 32) {
        const disposable = [...cache].find(([, item]) => !item.pending)
        if (disposable) cache.delete(disposable[0])
        else return { title: 'Usage', lines: [], error: errors.rate[language.startsWith('zh') ? 0 : 1] }
      }
      entry = { signature: hash, endpoint, providerId: model.providerId, modelName: model.model, nextAt: 0, failures: 0, bailian: endpoint.provider === 'bailian' ? createBailianClient(settings) : undefined }
      cache.set(key, entry)
    }
    const current = entry
    if (!presentationOnly && !current.pending && (refresh || Date.now() >= current.nextAt)) {
      const controller = new AbortController()
      current.controller = controller
      const timer = setTimeout(() => controller.abort(), endpoint.provider === 'bailian' ? 30_000 : 15_000)
      current.pending = Promise.resolve().then(async () => {
        try {
          let data: any
          if (endpoint.provider === 'tencent') {
            if (!settings.tencentSecretId.trim() || !settings.tencentSecretKey.trim()) throw new Error('tencent_config')
            data = await tencent.query({ ...endpoint, usage: endpoint.kind === 'usage', showBalance: settings.tencentShowBalance }, { id: settings.tencentSecretId.trim(), key: settings.tencentSecretKey.trim() }, requestJson, controller.signal)
          } else if (current.bailian) {
            const queryModel = { ...model, apiKey: model.apiKey ?? '' }
            if (!settings.bailianShowBalance) data = { usage: await current.bailian.read(queryModel, controller.signal) }
            else {
              const usageController = new AbortController()
              const usageSignal = AbortSignal.any([controller.signal, usageController.signal, AbortSignal.timeout(25_000)])
              const [usage, balance] = await Promise.allSettled([
                current.bailian.read(queryModel, usageSignal).then(value => { parseBailian(value, language, model.model); return value })
                  .catch(error => { throw new Error(usageSignal.aborted ? 'timeout' : errorCode(error)) })
                  .finally(() => usageController.abort()),
                queryAliyunBalance(settings, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
              ])
              data = { ...(usage.status === 'fulfilled' ? { usage: usage.value } : { usageError: errorCode(usage.reason) }),
                ...(balance.status === 'fulfilled' ? { balance: balance.value } : { balanceError: errorCode(balance.reason) }) }
            }
          }
          else {
            if (!model.apiKey) throw new Error('auth')
            data = await requestJson(endpoint.url!, { headers: { Authorization: endpoint.provider === 'glm' ? model.apiKey : `Bearer ${model.apiKey}`, 'Content-Type': 'application/json' }, signal: controller.signal })
          }
          controller.signal.throwIfAborted()
          const content = presentation(endpoint, data, model, language)
          current.data = data; current.updatedAt = Date.now(); current.error = undefined
          current.nextAt = Date.now() + (content.error ? Math.min(300_000, 60_000 * 2 ** Math.min(current.failures++, 3)) : 300_000)
          if (!content.error) current.failures = 0
        } catch (error) {
          current.error = controller.signal.aborted ? 'timeout' : errorCode(error)
          if (endpoint.provider === 'bailian') { current.data = undefined; current.updatedAt = undefined }
          current.nextAt = Date.now() + Math.min(300_000, 60_000 * 2 ** Math.min(current.failures++, 3))
        } finally {
          // Promise.all can reject while sibling provider requests are still pending.
          controller.abort()
          clearTimeout(timer)
          current.pending = undefined
          current.controller = undefined
        }
      })
    }
    if (!presentationOnly) await current.pending
    if (cache.get(key) !== current) return null
    const content = current.data ? presentation(endpoint, current.data, model, language) : { title: endpoint.provider === 'bailian' ? (language.startsWith('zh') ? '百炼' : 'Bailian') : endpoint.provider, lines: [] }
    return { ...content, emptyLabel: content.emptyLabel ?? (language.startsWith('zh') ? '暂无额度' : 'Quota unavailable'), updatedAt: current.updatedAt, ...(current.error ? { error: errors[current.error][language.startsWith('zh') ? 0 : 1],
      configurationRequired: /^(auth|tencent_|bailian_)/.test(current.error) } : {}) }
  }
  return { read, clear, reconcile }
}
