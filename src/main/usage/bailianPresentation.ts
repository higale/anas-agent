import type { UsageContent } from '@shared/usageMeter'

function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function date(value: unknown, language: string): string | undefined {
  if (value === undefined || value === null) return
  if (!number(value) || value > 8.64e15) throw new Error('response')
  return new Date(value).toLocaleString(language)
}
export function parseBailian(data: any, language: string, model: string): UsageContent {
  const zh = language.startsWith('zh'), format = (value: number) => new Intl.NumberFormat(language).format(value)
  const content: UsageContent = { title: `${zh ? '百炼' : 'Bailian'} · ${data.plan ? 'Token Plan' : zh ? '密钥用量' : 'Key usage'}`, lines: [], detailGroups: [], notes: [] }
  content.detailGroups!.push({ text: `${zh ? '查询账户' : 'Query account'}: ${data.user.name}` })
  if (data.plan) {
    for (const key of Object.keys(data.usage)) {
      const match = /^per(\d+)(Hour|Day|Week|Month)Percentage$/.exec(key)
      if (!match) continue
      const used = data.usage[key]
      if (used === undefined || used === null) continue
      if (!number(used) || Number(match[1]) <= 0) throw new Error('response')
      const units: Record<string, string> = zh ? { Hour: '小时', Day: '天', Week: '周', Month: '月' } : { Hour: 'h', Day: 'd', Week: 'w', Month: 'mo' }
      const label = `${match[1]} ${units[match[2]]}`, remaining = Math.max(0, 1 - used)
      const monthly = Number(match[1]) === 1 && match[2] === 'Month'
      const reset = date(data.usage[key.replace('Percentage', 'ResetTime')], language)
      content.lines.push({ label: monthly ? (zh ? '月额度剩余' : 'Monthly quota remaining') : `${label} ${zh ? '剩余' : 'remaining'}`,
        compactLabel: monthly ? (zh ? '月' : 'Month') : label, value: `${(remaining * 100).toFixed(2)}%`, progress: remaining,
        description: reset ? `${zh ? '重置时间' : 'Resets'}: ${reset}` : undefined })
    }
    const sub = data.subscription, details: string[] = []
    const statuses: Record<string, string> = zh
      ? { VALID: '有效', EXPIRED: '已到期', INVALID: '已失效' }
      : { VALID: 'Valid', EXPIRED: 'Expired', INVALID: 'Invalid' }
    if (typeof sub.status === 'string') details.push(`${zh ? '状态' : 'Status'}: ${Object.hasOwn(statuses, sub.status) ? statuses[sub.status] : sub.status}`)
    if (typeof sub.autoRenewFlag === 'boolean') details.push(`${zh ? '自动续费' : 'Auto-renew'}: ${sub.autoRenewFlag ? (zh ? '开启' : 'On') : (zh ? '关闭' : 'Off')}`)
    const expiry = date(sub.endTime, language)
    if (expiry) details.push(`${zh ? '套餐到期' : 'Plan expires'}: ${expiry}`)
    content.detailGroups!.push({ summary: typeof sub.specCode === 'string' ? sub.specCode : 'Token Plan', text: details.join('\n') })
    if (['EXPIRED', 'INVALID'].includes(sub.status)) content.notice = zh ? '套餐已到期或失效，请核对订阅状态。' : 'The plan has expired or is inactive. Check the subscription.'
    if (!content.lines.length) content.emptyLabel = zh ? '套餐未返回额度数据。' : 'No quota data returned for this plan.'
  } else {
    if (!Array.isArray(data.free.freeTierQuotas)) throw new Error('response')
    content.detailGroups!.push({ text: `${zh ? '工作空间' : 'Workspace'}: ${data.keyInfo.workspaceName || data.keyInfo.workspace}` })
    for (const row of data.free.freeTierQuotas.filter((row: any) => row.model === model)) {
      if (row.quotaStatus !== 'VALID' || row.quotaTotal == null) continue
      if (!number(row.quotaTotal)) throw new Error('response')
      content.lines.push({ label: `${zh ? '当前模型免费额度' : 'Current model free quota'} · ${model}`, compactLabel: zh ? '免费' : 'Free', value: format(row.quotaTotal),
        description: row.quotaValidityPeriod ? `${zh ? '额度到期' : 'Quota expires'}: ${date(row.quotaValidityPeriod, language)}` : undefined })
    }
    if (!content.lines.length) content.notes!.push(zh ? '当前模型免费额度未知或不可用。' : 'Current model free quota is unknown or unavailable.')
    if (data.stats.callCount !== undefined) {
      if (!number(data.stats.callCount)) throw new Error('response')
      content.lines.push({ label: zh ? '此 Key 近 7 天在线调用' : 'This key: online calls over 7 days', compactLabel: zh ? '7天调用' : '7d calls', value: format(data.stats.callCount) })
    }
    const details: string[] = []
    if (data.stats.callFailedCount !== undefined) {
      if (!number(data.stats.callFailedCount)) throw new Error('response')
      details.push(`${zh ? '失败调用' : 'Failed calls'}: ${format(data.stats.callFailedCount)}`)
    }
    if (data.stats.usages !== undefined && !Array.isArray(data.stats.usages)) throw new Error('response')
    for (const row of data.stats.usages ?? []) {
      if (typeof row.key !== 'string' || !number(row.value)) throw new Error('response')
      details.push(`${row.key}: ${format(row.value)}${typeof row.unit === 'string' ? ' ' + row.unit : ''}`)
    }
    if (!data.stats.usages?.length) details.push(zh ? '接口未返回此 Key 的 Token 明细。' : 'The API returned no token breakdown for this key.')
    content.detailGroups!.push({ summary: zh ? '此 Key 近 7 天在线用量' : 'This key: online usage over 7 days', text: details.join('\n') })
  }
  return content
}
