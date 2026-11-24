export type UsageProvider = 'minimax' | 'deepseek' | 'moonshot' | 'openrouter' | 'glm' | 'mimo' | 'tencent' | 'bailian'
export interface UsageEndpoint {
  provider: UsageProvider
  kind: string
  url?: string
  region?: string
  personalPlans?: boolean
}

/** The settings form and query service use the same exact endpoint classification. */
export function usageEndpoint(baseUrl: string): UsageEndpoint | undefined {
  let url: URL
  try { url = new URL(baseUrl) } catch { return }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
  const host = url.hostname, path = url.pathname.replace(/\/+$/, '')
  if (['api.minimaxi.com', 'api.minimax.io', 'api.minimax.cn', 'www.minimaxi.com', 'www.minimax.io', 'www.minimax.cn'].includes(host)) {
    if (!['', '/v1', '/anthropic'].includes(path)) return
    const website = host.endsWith('.io') ? 'www.minimax.io' : host.endsWith('.cn') ? 'www.minimax.cn' : 'www.minimaxi.com'
    return { provider: 'minimax', kind: 'plan', url: `https://${website}/v1/token_plan/remains` }
  }
  if (host === 'api.deepseek.com' && ['', '/v1', '/anthropic'].includes(path)) return { provider: 'deepseek', kind: 'balance', url: 'https://api.deepseek.com/user/balance' }
  if (['api.moonshot.cn', 'api.moonshot.ai'].includes(host) && ['', '/v1', '/anthropic'].includes(path)) return { provider: 'moonshot', kind: 'balance', url: `https://${host}/v1/users/me/balance` }
  if (host === 'openrouter.ai' && ['/api/v1', '/api'].includes(path)) return { provider: 'openrouter', kind: 'key', url: 'https://openrouter.ai/api/v1/key' }
  if (['open.bigmodel.cn', 'api.z.ai'].includes(host)) {
    if (host === 'open.bigmodel.cn' && ['/api/paas/v4', '/api/v1'].includes(path)) return { provider: 'glm', kind: 'balance', url: `https://${host}/api/biz/account/query-customer-account-report` }
    if (['/api/coding/paas/v4', '/api/anthropic'].includes(path)) return { provider: 'glm', kind: 'plan', url: `https://${host}/api/monitor/usage/quota/limit` }
  }
  if (['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com', 'token-plan-sgp.xiaomimimo.com', 'token-plan-ams.xiaomimimo.com'].includes(host) && ['/v1', '/anthropic'].includes(path)) {
    const kind = host === 'api.xiaomimimo.com' ? 'balance' : 'plan'
    return { provider: 'mimo', kind, url: `https://${host}/v1/platform/${kind === 'plan' ? 'token_plan' : 'balance'}` }
  }
  if (['tokenhub.tencentmaas.com', 'tokenhub-intl.tencentmaas.com'].includes(host)) {
    const region = host.includes('-intl.') ? 'ap-singapore' : 'ap-guangzhou'
    if (['', '/v1'].includes(path)) return { provider: 'tencent', kind: 'usage', region }
    if (['/plan/v3', '/plan/anthropic'].includes(path)) return { provider: 'tencent', kind: 'plan', region, personalPlans: region === 'ap-guangzhou' }
  }
  if (host === 'api.lkeap.cloud.tencent.com' && ['/coding/v3', '/coding/anthropic'].includes(path)) return { provider: 'tencent', kind: 'balance', region: 'ap-guangzhou' }
  if (host === 'dashscope.aliyuncs.com' && ['/compatible-mode/v1', '/apps/anthropic'].includes(path)) return { provider: 'bailian', kind: 'usage', region: 'cn-beijing' }
  if (host === 'token-plan.cn-beijing.maas.aliyuncs.com' && ['/compatible-mode/v1', '/v1', '/apps/anthropic'].includes(path)) return { provider: 'bailian', kind: 'plan', region: 'cn-beijing' }
}

export interface UsageSettings {
  enabled: boolean
  displayMode: 'compact' | 'detailed'
  tencentSecretId: string
  tencentSecretKey: string
  tencentShowBalance: boolean
  bailianAccessKeyId: string
  bailianAccessKeySecret: string
  bailianShowBalance: boolean
}
export const usageCredentialKeys = ['tencentSecretId', 'tencentSecretKey', 'bailianAccessKeyId', 'bailianAccessKeySecret'] as const
export function normalizeUsageSettings(value: unknown, baseUrl: string): UsageSettings {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid usage settings.')
  const raw = (value ?? {}) as Partial<UsageSettings>
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Invalid usage enabled setting.')
  if (raw.displayMode !== undefined && !['compact', 'detailed'].includes(raw.displayMode)) throw new Error('Invalid usage display mode.')
  if (raw.bailianShowBalance !== undefined && typeof raw.bailianShowBalance !== 'boolean') throw new Error('Invalid Bailian balance setting.')
  if (raw.tencentShowBalance !== undefined && typeof raw.tencentShowBalance !== 'boolean') throw new Error('Invalid Tencent balance setting.')
  const result: UsageSettings = { enabled: Boolean(usageEndpoint(baseUrl)) && raw.enabled !== false, displayMode: raw.displayMode ?? 'compact',
    tencentSecretId: '', tencentSecretKey: '', tencentShowBalance: raw.tencentShowBalance ?? true,
    bailianAccessKeyId: '', bailianAccessKeySecret: '', bailianShowBalance: raw.bailianShowBalance ?? false }
  for (const key of usageCredentialKeys) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > 256)) throw new Error('Invalid usage credentials.')
    result[key] = raw[key] ?? ''
  }
  return result
}
export function changeUsageEndpoint(settings: UsageSettings | undefined, previous: string, next: string): UsageSettings {
  const before = usageEndpoint(previous), after = usageEndpoint(next)
  const value = normalizeUsageSettings(settings, previous)
  return normalizeUsageSettings({ ...value, enabled: !after ? false : !before || before.provider !== after.provider || before.kind !== after.kind ? true : value.enabled }, next)
}

export interface UsageLine {
  label: string
  compactLabel: string
  value: string
  progress?: number
  description?: string
  detail?: string
  explanation?: string
  breakdown?: { label: string; value: string }[]
}
export interface UsageContent {
  title: string
  lines: UsageLine[]
  notes?: string[]
  detailGroups?: { summary?: string; text: string }[]
  emptyLabel?: string
  notice?: string
  error?: string
  updatedAt?: number
  configurationRequired?: boolean
}
export interface UsageApi {
  setDisplayMode(providerId: string, mode: 'compact' | 'detailed'): Promise<import('./types').AppConfigSnapshot>
  read(modelId: string, refresh?: boolean, presentationOnly?: boolean): Promise<UsageContent | null>
}
