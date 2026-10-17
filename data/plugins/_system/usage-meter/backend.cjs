const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { join, dirname } = require('node:path')
const manifest = require('./PLUGIN.json')
const { hosts: bailianHosts, createBailian } = require('./bailian.cjs')
const bailian = createBailian()
const cache = new Map()
let stopped = false
let displayMode = 'compact'
let displayPath

function saveDisplayMode(mode) {
  if (!displayPath) throw new Error('Usage Meter is not activated.')
  fs.mkdirSync(dirname(displayPath), { recursive: true })
  const temporary = `${displayPath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 0, display_mode: mode }) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, displayPath)
    displayMode = mode
  } finally { fs.rmSync(temporary, { force: true }) }
}

function endpoint(baseUrl) {
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || !manifest.widgets[0].model_hosts.includes(url.hostname)) return null
    if (bailianHosts.includes(url.hostname)) return { name: 'Bailian' }
    if (url.hostname === 'api.deepseek.com') return { name: 'DeepSeek', url: 'https://api.deepseek.com/user/balance', parse: parseBalance }
    if (['api.moonshot.cn', 'api.moonshot.ai'].includes(url.hostname)) return { name: 'Moonshot', url: `https://${url.hostname}/v1/users/me/balance`,
      parse: (data, language) => parseMoonshot(data, language, url.hostname.endsWith('.cn') ? 'CNY' : 'USD') }
    if (url.hostname === 'openrouter.ai') return { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/key', parse: parseOpenRouter }
    if (['open.bigmodel.cn', 'api.z.ai'].includes(url.hostname)) {
      // Plan entitlement alone does not mean the selected endpoint bills the plan.
      // The ordinary /api/paas/v4 endpoint uses resource packages or cash balance.
      const path = url.pathname.replace(/\/+$/, '')
      if (url.hostname === 'open.bigmodel.cn' && path === '/api/paas/v4') return {
        name: 'GLM', url: 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report', rawKey: true, parse: parseGlmBalance
      }
      if (!['/api/coding/paas/v4', '/api/anthropic'].includes(path)) return null
      return {
        name: url.hostname === 'open.bigmodel.cn' ? 'GLM' : 'Z.ai',
        url: `https://${url.hostname}/api/monitor/usage/quota/limit`, rawKey: true, parse: parseGlmQuota
      }
    }
    const host = url.hostname.endsWith('.io') ? 'www.minimax.io' : url.hostname.endsWith('.cn') ? 'www.minimax.cn' : 'www.minimaxi.com'
    return { name: 'MiniMax', url: `https://${host}/v1/token_plan/remains`, parse: parseQuota }
  } catch { return null }
}

function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8.64e15 ? value : undefined
}

function resetDescription(end, zh, now) {
  const remaining = end - now
  if (remaining <= 0) return zh ? '周期已结束，待刷新' : 'Window ended; awaiting refresh'
  if (remaining < 60000) return zh ? '不到 1 分钟后重置' : 'Resets in <1m'
  const minutes = Math.ceil(remaining / 60000)
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60
  const parts = days ? [[days, '天', 'd'], [hours, '小时', 'h']] : [[hours, '小时', 'h'], [mins, '分钟', 'm']]
  const duration = parts.filter(([value]) => value).map(([value, cn, en]) => zh ? `${value} ${cn}` : `${value}${en}`).join(' ')
  return zh ? `约 ${duration}后重置` : `Resets in ${duration}`
}

function parseQuota(payload, language, now = Date.now()) {
  const status = payload?.base_resp?.status_code
  if (status !== 0) throw new Error(status === 1004 || status === 2049 ? 'auth' : status === 1002 ? 'rate' : 'response')
  if (!Array.isArray(payload.model_remains)) throw new Error('response')
  const rows = payload.model_remains.filter(row => row && typeof row.model_name === 'string')
  // Token Plan is an account quota. "model_name" identifies quota buckets,
  // not the selected chat model. Older plans name the shared bucket MiniMax-M*.
  const row = rows.find(row => row.model_name.toLowerCase() === 'general')
    ?? rows.find(row => row.model_name.toLowerCase() === 'minimax-m*')
  if (!row) throw new Error('quota')
  if (row.current_interval_status === 3 && row.current_weekly_status === 3
    && row.current_interval_total_count === 0 && row.current_weekly_total_count === 0) throw new Error('quota')
  const zh = language.startsWith('zh')
  const lines = [], detailGroups = []
  const formatPercent = value => `${Number(value.toFixed(2))}%`
  // These are plan quota categories. A response can describe a shorter current
  // interval (for example 20:00–00:00); its bounds only determine reset timing.
  for (const [period, endKey, label, compactLabel] of [
    ['interval', 'end_time', zh ? '5h 限额' : '5h limit', '5h'],
    ['weekly', 'weekly_end_time', zh ? '周限额' : 'Weekly limit', zh ? '周' : '1w']
  ]) {
    const prefix = `current_${period}_`
    if (row[prefix + 'status'] === 3) {
      lines.push({ label, compactLabel, value: zh ? '不限' : 'Unlimited' })
      continue
    }
    const explicit = row[prefix + 'remaining_percent']
    const total = row[prefix + 'total_count'], reported = row[prefix + 'usage_count']
    let percent
    // The explicit remaining percentage is authoritative. Legacy count-only
    // responses report remaining counts despite the name "usage_count".
    if (explicit !== undefined && explicit !== null) {
      if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit < 0 || explicit > 100) throw new Error('response')
      percent = explicit
    } else if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
      if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0 || reported > total) throw new Error('response')
      percent = reported / total * 100
    } else if (total === 0 || total === undefined) continue
    else throw new Error('response')
    const end = timestamp(row[endKey])
    const timing = end ? {
      description: resetDescription(end, zh, now),
      detail: `${zh ? '重置时间' : 'Resets'}: ${new Date(end).toLocaleString(language)}`
    } : {}
    const boost = period === 'weekly' ? (row.weekly_boost_permille ?? 1000) : 1000
    if (typeof boost !== 'number' || !Number.isFinite(boost) || boost <= 0) throw new Error('response')
    // Show remaining quota in base-plan units, including weekly boosts.
    // The progress bar expresses remaining / total, so it never exceeds 100%.
    const remaining = percent * (boost / 1000)
    const used = (100 - percent) * (boost / 1000)
    if (!Number.isFinite(remaining) || !Number.isFinite(used)) throw new Error('response')
    lines.push({ label, compactLabel, value: formatPercent(remaining), progress: percent / 100, ...timing })
    detailGroups.push({ summary: label, text: [
      `${zh ? '总额度' : 'Total quota'}: ${formatPercent(boost / 10)}`,
      `${zh ? '已用' : 'Used'}: ${formatPercent(used)}`,
      ...(boost !== 1000 ? [zh ? '含套餐加成，基础额度为 100%。' : 'Includes a plan boost.\nBase quota = 100%.'] : [])
    ].join('\n') })
  }
  if (!lines.length) throw new Error('response')
  return { lines, detailGroups }
}

function parseGlmQuota(payload, language, now = Date.now()) {
  if (payload?.code !== 200 || payload.success === false) {
    if ([401, 403, 1001, 1002, 1003].includes(payload?.code)) throw new Error('auth')
    if (payload?.code === 429) throw new Error('rate')
    if (typeof payload?.msg === 'string' && /不存在\s*coding\s*plan|(?:no|not have|not exist).*coding\s*plan|coding\s*plan.*(?:not exist|not found)/i.test(payload.msg)) throw new Error('glm_plan')
    throw new Error('response')
  }
  const limits = payload.data?.limits
  if (!Array.isArray(limits)) throw new Error('response')
  const zh = language.startsWith('zh'), lines = [], detailGroups = []
  // Match the official console: credit plans use CREDIT_LIMIT, older plans use
  // TOKENS_LIMIT and a separate monthly MCP allowance. Percentage means used.
  const creditPlan = limits.some(row => row?.type === 'CREDIT_LIMIT')
  const planType = creditPlan ? 'CREDIT_LIMIT' : 'TOKENS_LIMIT'
  for (const [type, unit, number, label, compactLabel] of [
    [planType, 3, 5, zh ? '5 小时额度剩余' : '5-hour quota remaining', '5h'],
    [planType, 6, 1, zh ? '每周额度剩余' : 'Weekly quota remaining', zh ? '周' : '1w'],
    ...(!creditPlan ? [['TIME_LIMIT', 5, 1, zh ? 'MCP 每月额度剩余' : 'MCP monthly quota remaining', 'MCP']] : [])
  ]) {
    const matches = limits.filter(row => row?.type === type && row.unit === unit)
    if (!matches.length) continue
    const row = matches[0]
    if (matches.length !== 1 || (row.number != null && row.number !== number)
      || typeof row.percentage !== 'number' || !Number.isFinite(row.percentage) || row.percentage < 0 || row.percentage > 100) throw new Error('response')
    const remaining = 100 - row.percentage
    const end = timestamp(row.nextResetTime)
    lines.push({ label, compactLabel, value: `${Number(remaining.toFixed(1))}%`, progress: remaining / 100,
      ...(end ? { description: resetDescription(end, zh, now) } : {}) })
    if (end) detailGroups.push({ summary: label, text: `${zh ? '重置时间' : 'Resets'}: ${new Date(end).toLocaleString(language)}` })
  }
  if (!lines.length) throw new Error('glm_quota')
  return { lines, detailGroups }
}

function parseBalance(payload, language) {
  if (typeof payload?.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) throw new Error('response')
  const zh = language.startsWith('zh')
  const currencies = new Set()
  const lines = payload.balance_infos.map(row => {
    if (!row || !['CNY', 'USD'].includes(row.currency) || currencies.has(row.currency)) throw new Error('response')
    currencies.add(row.currency)
    for (const key of ['total_balance', 'granted_balance', 'topped_up_balance']) {
      // Keep decimal strings intact: small balances must not round down to zero.
      if (typeof row[key] !== 'string' || row[key].length > 128 || !/^-?\d+(?:\.\d+)?$/.test(row[key])) throw new Error('response')
    }
    return { label: `${row.currency} ${zh ? '可用余额' : 'available'}`, compactLabel: row.currency, value: row.total_balance,
      breakdown: [
        { label: zh ? '赠金余额' : 'Granted balance', value: row.granted_balance },
        { label: zh ? '充值余额' : 'Topped-up balance', value: row.topped_up_balance }
      ] }
  })
  if (!lines.length && payload.is_available) throw new Error('response')
  return { lines, notice: payload.is_available ? undefined : (zh ? '余额不足，暂不可调用 API。' : 'Insufficient balance for API calls.') }
}

function numberText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('response')
  return String(value)
}

function parseGlmBalance(payload, language) {
  if (payload?.code !== 200 || payload.success === false) {
    if ([401, 403, 1001, 1002, 1003].includes(payload?.code)) throw new Error('auth')
    if (payload?.code === 429) throw new Error('rate')
    throw new Error('response')
  }
  const zh = language.startsWith('zh'), data = payload.data
  const available = numberText(data?.availableBalance)
  const breakdown = [
    ['rechargeAmount', zh ? '累计充值' : 'Total top-ups'],
    ['totalSpendAmount', zh ? '累计消费' : 'All-time spend'],
    ['frozenBalance', zh ? '冻结余额' : 'Frozen balance']
  ].filter(([key]) => data[key] != null).map(([key, label]) => ({ label, value: `CNY ${numberText(data[key])}` }))
  // Wallet balance does not include resource packages or Coding Plan allowances;
  // zero or negative cash alone cannot establish whether model calls are available.
  return { lines: [{ label: zh ? 'CNY 可用余额' : 'CNY available', compactLabel: 'CNY', value: available, breakdown,
    explanation: zh ? '账户余额，不包含资源包与 Coding Plan 额度。' : 'Account balance; excludes resource packages and Coding Plan quotas.' }] }
}

function parseMoonshot(payload, language, currency) {
  if (payload?.code !== 0 || payload.status !== true || !payload.data) throw new Error('response')
  const zh = language.startsWith('zh'), data = payload.data
  const available = numberText(data.available_balance), cash = numberText(data.cash_balance), voucher = numberText(data.voucher_balance)
  if (data.voucher_balance < 0) throw new Error('response')
  return { lines: [{ label: `${currency} ${zh ? '可用余额' : 'available'}`, compactLabel: currency, value: available,
    breakdown: [{ label: zh ? '代金券余额' : 'Voucher balance', value: voucher }, { label: zh ? '现金余额' : 'Cash balance', value: cash }] }],
    notice: data.available_balance <= 0 ? (zh ? '余额不足，暂不可调用 API。' : 'Insufficient balance for API calls.') : undefined }
}

function parseOpenRouter(payload, language) {
  const data = payload?.data, zh = language.startsWith('zh')
  if (!data || (data.limit !== null && (typeof data.limit !== 'number' || data.limit < 0))) throw new Error('response')
  if (data.limit !== null) numberText(data.limit)
  const unlimited = data.limit === null
  if (unlimited && data.limit_remaining !== null) throw new Error('response')
  const remaining = unlimited ? (zh ? '未设上限' : 'No cap') : `USD ${numberText(data.limit_remaining)}`
  const breakdown = [[zh ? '累计消费' : 'All-time spend', 'usage'], [zh ? '今日消费（UTC）' : 'Daily spend (UTC)', 'usage_daily'],
    [zh ? '本周消费（UTC）' : 'Weekly spend (UTC)', 'usage_weekly'], [zh ? '本月消费（UTC）' : 'Monthly spend (UTC)', 'usage_monthly']]
    .filter(([, key]) => key === 'usage' || data[key] !== undefined)
    .map(([label, key]) => {
      const value = numberText(data[key])
      if (data[key] < 0) throw new Error('response')
      return { label, value: `USD ${value}` }
    })
  if (!unlimited) breakdown.unshift({ label: zh ? '密钥额度上限' : 'Key spending cap', value: `USD ${data.limit}` })
  if (data.limit_reset != null) {
    const resets = { daily: zh ? '每天' : 'Daily', weekly: zh ? '每周' : 'Weekly', monthly: zh ? '每月' : 'Monthly' }
    if (!Object.hasOwn(resets, data.limit_reset)) throw new Error('response')
    breakdown.push({ label: zh ? '额度重置周期' : 'Cap reset interval', value: resets[data.limit_reset] })
  }
  if (data.expires_at != null) {
    const expires = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN
    if (!Number.isFinite(expires)) throw new Error('response')
    breakdown.push({ label: zh ? '密钥到期时间' : 'Key expires', value: new Date(expires).toLocaleString(language) })
  }
  return { lines: [{ label: zh ? '密钥剩余额度' : 'Key remaining credits', compactLabel: zh ? '密钥' : 'Key', value: remaining,
    explanation: zh ? '仅当前 API Key 的额度，不代表账户余额。' : 'Current API key cap; not the account balance.', breakdown }] }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function renderWidget(content, language, displayMode) {
  const zh = language.startsWith('zh')
  const title = escapeHtml(content.title)
  const refresh = zh ? '立即刷新' : 'Refresh now'
  const compact = displayMode === 'compact'
  const status = [content.notice, content.error].filter(Boolean).join('\n')
  const toggleLabel = compact ? (zh ? '展开用量详情' : 'Show usage details') : (zh ? '收起用量详情' : 'Collapse usage details')
  const toggleButton = `<button class="ui-tool-button ui-tool-button-small" data-action="${compact ? 'show_detailed' : 'show_compact'}" aria-label="${toggleLabel}" title="${toggleLabel}" aria-expanded="${!compact}">
    <img src="assets/${compact ? 'expand' : 'collapse'}.svg" alt="">
  </button>`
  const refreshButton = `<button class="ui-tool-button ui-tool-button-small" data-action="refresh" aria-label="${refresh}" title="${refresh}">
    <img class="ui-busy-icon" src="assets/refresh.svg" alt="">
  </button>`
  const extraActions = (content.actions ?? []).map(action => `<button class="ui-button" data-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`).join('')
  const controls = extraActions || content.installLink ? `<div class="ui-row ui-row-tight${extraActions ? ' ui-row-center' : ''}">${extraActions}${content.installLink ? `<a href="https://github.com/modelstudioai/cli#installation">${zh ? '安装说明' : 'Installation guide'}</a>` : ''}</div>` : ''
  const notes = (content.notes ?? []).map(note => `<small class="ui-field-hint">${escapeHtml(note)}</small>`).join('')
  const detailGroups = content.detailGroups ?? []
  const groupTexts = detailGroups.map(group => [group.summary, group.text].filter(Boolean).join('\n')).filter(Boolean)
  const lineExtras = line => [line.explanation, ...(line.breakdown ?? []).map(item => `${item.label}: ${item.value}`)].filter(Boolean).join('\n')
  const detailsText = [...groupTexts, ...content.lines.filter(line => lineExtras(line))
    .map(line => [content.lines.length > 1 ? line.compactLabel : '', lineExtras(line)].filter(Boolean).join('\n'))].join('\n\n')
  const detailsButton = detailsText ? `<button class="ui-tool-button ui-tool-button-small" aria-label="${zh ? '详情' : 'Details'}" data-details="${escapeHtml(detailsText)}"><img src="assets/info.svg" alt=""></button>` : ''
  const updated = content.updatedAt !== undefined ? `<small class="ui-field-hint">${zh ? '更新于' : 'Updated'} <time datetime="${new Date(content.updatedAt).toISOString()}">${escapeHtml(new Date(content.updatedAt).toLocaleTimeString(language))}</time></small>` : ''
  if (displayMode === 'compact') {
    const details = [content.title, ...(content.notes ?? []), ...groupTexts, ...content.lines.map(line => [line.label + ' ' + line.value, line.description, line.detail, lineExtras(line)].filter(Boolean).join('\n')),
      content.updatedAt !== undefined ? `${zh ? '更新于' : 'Updated'}: ${new Date(content.updatedAt).toLocaleString(language)}` : '', status].filter(Boolean).join('\n\n')
    const summary = content.lines.map(line => `${line.compactLabel} ${line.value}`).join(' · ') || content.emptyLabel
    const summaryHtml = content.lines.length && content.lines.every(line => line.progress !== undefined)
      ? `<span class="ui-numeric ui-adaptive-text"><span data-full-text>${escapeHtml(summary)}</span><span data-short-text>${escapeHtml(content.lines.map(line => line.value).join(' · '))}</span></span>`
      : `<span class="ui-numeric ui-truncate">${escapeHtml(summary)}</span>`
    return { title: content.title, html: `<div class="ui-stack ui-stack-tight"><div class="ui-row-between">
      <span class="ui-row ui-row-tight" title="${escapeHtml(details)}" tabindex="0" aria-label="${escapeHtml(details)}">
        <img src="assets/meter.svg" width="16" height="16" alt="">
        ${summaryHtml}
      </span>
      <span class="ui-row ui-row-tight">
        ${status ? `<span role="status" title="${escapeHtml(status)}" aria-label="${escapeHtml(status)}">!</span>` : ''}
        ${refreshButton}${toggleButton}
      </span>
    </div>${controls}</div>` }
  }

  const rows = content.lines.map(line => `<section${line.detail ? ` title="${escapeHtml(line.detail)}"` : ''}>
    <div class="ui-row-between ui-muted"><span>${escapeHtml(line.label)}</span><span class="ui-numeric">${escapeHtml(line.value)}</span></div>
    ${line.progress !== undefined ? `<progress aria-label="${escapeHtml(line.label)}" max="1" value="${line.progress}"></progress>` : ''}
    ${line.description ? `<small class="ui-field-hint">${escapeHtml(line.description)}</small>` : ''}
  </section>`).join('')
  return { title: content.title, html: `<div class="ui-stack ui-stack-tight">
    <header class="ui-row-between"><span class="ui-truncate" title="${title}">${title}</span>
      <span class="ui-row ui-row-tight">${refreshButton}${toggleButton}</span>
    </header>
    ${rows}${!content.lines.length && !content.error ? `<p class="ui-field-hint">${escapeHtml(content.emptyLabel ?? '')}</p>` : ''}
    ${notes}${controls}
    ${status ? `<p class="ui-field-hint" role="status">${escapeHtml(status)}</p>` : ''}
    ${detailsButton ? `<footer class="ui-row-between">${updated || '<span></span>'}${detailsButton}</footer>` : updated}
  </div>` }
}

async function query(url, authorization, signal) {
  const response = await fetch(url, { headers: { Authorization: authorization, 'Content-Type': 'application/json' }, signal, redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate' : 'network')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('response')
  let size = 0
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) throw new Error('response')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  let data
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('response') }
  return data
}

const messages = {
  zh: { auth: '请检查此供应商的 API Key。', rate: '查询受到限流，请稍后刷新。', network: '用量查询失败，请稍后刷新。',
    response: '无法识别账户用量数据，请检查账户或更新插件。', quota: '套餐未返回通用额度。', timeout: '用量查询超时，请稍后刷新。',
    glm_plan: '当前账户未开通 GLM Coding Plan。', glm_quota: 'GLM Coding Plan 未返回可识别的额度。' },
  en: { auth: 'Check the API key for this provider.', rate: 'Rate limited. Try again later.', network: 'Usage query failed. Try again later.',
    response: 'Unrecognized usage data. Check your account or update the plugin.', quota: 'The plan returned no general quota.', timeout: 'Usage query timed out. Try again later.',
    glm_plan: 'This account has no GLM Coding Plan.', glm_quota: 'No recognized GLM Coding Plan quota returned.' }
}

module.exports = {
  activate({ dataDirectory }) {
    displayPath = join(dataDirectory, 'display.json')
    try {
      if (fs.statSync(displayPath).size > 4096) throw new Error('Invalid Usage Meter display preferences.')
      const saved = JSON.parse(fs.readFileSync(displayPath, 'utf8'))
      if (saved?.version !== 0 || !['compact', 'detailed'].includes(saved.display_mode ?? 'compact')) throw new Error('Invalid Usage Meter display preferences.')
      displayMode = saved.display_mode ?? 'compact'
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  },
  async call(method, { model, language = 'en', action }, context) {
    if (method !== 'quota' || (action !== null && action !== undefined && !manifest.widgets[0].actions.includes(action))) throw new Error('Unknown usage action.')
    context.signal.throwIfAborted()
    if (stopped) throw new Error('Usage Meter stopped.')
    const provider = model && endpoint(model.baseUrl)
    if (!provider) return null
    const { url, name, parse } = provider
    if (action === 'show_compact' || action === 'show_detailed') saveDisplayMode(action === 'show_compact' ? 'compact' : 'detailed')
    if (name === 'Bailian') return renderWidget(await bailian.read(model, language, action, context.signal), language, displayMode)
    const zh = language.startsWith('zh')
    const providerName = model.providerName?.trim()
    const defaultTitle = name === 'MiniMax' ? 'MiniMax Token Plan' : parse === parseGlmQuota ? `${name} Coding Plan`
      : name === 'OpenRouter' ? `OpenRouter ${zh ? '密钥额度' : 'Key credits'}` : `${name} ${zh ? '余额' : 'Balance'}`
    const content = { title: (!providerName || providerName.toLowerCase() === name.toLowerCase() ? defaultTitle : `${name} · ${providerName}`).slice(0, 160), lines: [],
      emptyLabel: ['DeepSeek', 'Moonshot'].includes(name) || parse === parseGlmBalance ? (zh ? '暂无余额数据' : 'Balance unavailable') : (zh ? '暂无额度' : 'Quota unavailable') }
    if (!model.apiKey) return renderWidget({ ...content, error: messages[zh ? 'zh' : 'en'].auth }, language, displayMode)
    const cacheKey = createHash('sha256').update(JSON.stringify([model.providerId, url, model.apiKey])).digest('hex')
    let entry = cache.get(cacheKey)
    if (!entry) {
      if (cache.size >= 32) {
        const disposable = [...cache].find(([, item]) => !item.pending)
        if (disposable) cache.delete(disposable[0])
        else return renderWidget({ ...content, error: messages[zh ? 'zh' : 'en'].rate }, language, displayMode)
      }
      entry = { nextAt: 0, failures: 0 }
      cache.set(cacheKey, entry)
    }
    if (!entry.pending && (action === 'refresh' || Date.now() >= entry.nextAt)) {
      const controller = new AbortController()
      entry.controller = controller
      const timeout = setTimeout(() => controller.abort(), 15_000)
      entry.pending = query(url, provider.rawKey ? model.apiKey : `Bearer ${model.apiKey}`, controller.signal).then(data => {
        parse(data, language)
        entry.data = data
        entry.updatedAt = Date.now()
        entry.error = undefined
        entry.failures = 0
        entry.nextAt = Date.now() + 300_000
      }).catch(reason => {
        entry.error = controller.signal.aborted ? 'timeout' : Object.hasOwn(messages.en, reason.message) ? reason.message : 'network'
        entry.nextAt = Date.now() + Math.min(300_000, 60_000 * 2 ** Math.min(entry.failures++, 3))
      }).finally(() => { clearTimeout(timeout); entry.pending = undefined; entry.controller = undefined })
    }
    await entry.pending
    context.signal.throwIfAborted()
    if (stopped) throw new Error('Usage Meter stopped.')
    let error = entry.error
    if (entry.data) {
      try { Object.assign(content, parse(entry.data, language)); content.updatedAt = entry.updatedAt }
      catch (reason) { error = reason.message }
    }
    if (error) content.error = messages[zh ? 'zh' : 'en'][error] ?? messages[zh ? 'zh' : 'en'].response
    return renderWidget(content, language, displayMode)
  },
  deactivate() {
    stopped = true
    bailian.stop()
    for (const entry of cache.values()) entry.controller?.abort()
    cache.clear()
  }
}
