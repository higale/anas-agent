const childProcess = require('node:child_process')
const fs = require('node:fs')
const { join, delimiter } = require('node:path')
const { createHash } = require('node:crypto')

const api = {
  identity: 'zeldaEasy.cornerstone-portal.cs-console.loginInfo',
  account: 'zeldaEasy.cornerstonePortal.iCornerstoneService.getGConfig',
  planKey: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/api-keys/getKeyByUid',
  usage: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage',
  subscription: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription',
  keys: 'zeldaEasy.bailian-dash-workspace.api-key.listApiKeys4Agent',
  key: 'zeldaEasy.bailian-dash-workspace.api-key.getApiKey'
}
const hosts = ['dashscope.aliyuncs.com', 'token-plan.cn-beijing.maas.aliyuncs.com']
const copy = {
  zh: {
    title: '百炼', missing: '未找到 bl，请先安装百炼 CLI。', login: '百炼控制台未登录或登录已过期。',
    mismatch: '当前 API Key 与控制台账户不匹配，请切换账户登录。', permission: '无权查询百炼数据，请检查控制台账户权限。',
    response: '无法识别百炼返回的数据，请更新 bl 或稍后重试。', network: '百炼查询失败，请稍后刷新。', timeout: '百炼查询超时，请稍后刷新。',
    key_missing: '当前账户没有可用的 Token Plan Key。', key_disabled: '当前 API Key 已停用。', model_key: '请配置当前模型的 API Key。',
    key_type: 'API Key 类型与 API URL 不匹配，请检查模型配置。', login_failed: '浏览器登录未完成，请重试。', waiting: '等待浏览器登录，完成后刷新。',
    loginButton: '登录百炼', switchButton: '切换账户登录', cancelButton: '取消登录', install: '安装说明', account: '控制台账户', workspace: '工作空间',
    plan: 'Token Plan 剩余额度', ordinary: '密钥用量', expires: '套餐到期', reset: '重置时间', remaining: '剩余', noQuota: '套餐未返回额度数据。',
    free: '当前模型免费额度', calls: '此 Key 近 7 天在线调用', failed: '失败调用', noCalls: '此 Key 近 7 天暂无在线调用记录。',
    stats: '此 Key 近 7 天在线用量', noFree: '当前模型暂无免费额度。', querying: '正在查询', loginHint: '请在浏览器选择正确账户；登录会更新 bl 的当前配置。'
  },
  en: {
    title: 'Bailian', missing: 'bl was not found. Install the Model Studio CLI first.', login: 'Sign in to the Bailian console; the session is missing or expired.',
    mismatch: 'The current API key does not match the console account. Sign in with another account.', permission: 'Access denied. Check the console account permissions.',
    response: 'Unrecognized Bailian response. Update bl or try again later.', network: 'Bailian query failed. Try again later.', timeout: 'Bailian query timed out. Try again later.',
    key_missing: 'No Token Plan key is available for this account.', key_disabled: 'The current API key is disabled.', model_key: 'Configure an API key for the current model.',
    key_type: 'The API key type does not match the API URL. Check the model configuration.', login_failed: 'Browser login did not complete. Try again.', waiting: 'Waiting for browser login. Refresh after signing in.',
    loginButton: 'Sign in to Bailian', switchButton: 'Switch account', cancelButton: 'Cancel login', install: 'Installation guide', account: 'Console account', workspace: 'Workspace',
    plan: 'Token Plan remaining quota', ordinary: 'Key usage', expires: 'Plan expires', reset: 'Resets at', remaining: 'remaining', noQuota: 'No quota data returned for this plan.',
    free: 'Current model free quota', calls: 'This key: online calls over 7 days', failed: 'Failed calls', noCalls: 'No online calls for this key in the past 7 days.',
    stats: 'This key: online usage over 7 days', noFree: 'No free quota for the current model.', querying: 'Querying', loginHint: 'Choose the correct account in your browser. Signing in updates the current bl profile.'
  }
}
function words(language) { return copy[language.startsWith('zh') ? 'zh' : 'en'] }
function fault(code) { return new Error(code) }
function classify(value) {
  const text = String(value)
  if (/NotLogined|not logged in|No console access token|needs a console access token|session.*expired/i.test(text)) return 'login'
  if (/forbidden|permission|not.?authorized|access.?denied|no.?permission|Forbidden/i.test(text)) return 'permission'
  if (/timeout|timed out|aborted/i.test(text)) return 'timeout'
  return 'network'
}
// Console gateway HTTP success does not imply business success. Unwrap only the
// observed gateway envelopes, checking errors at every layer.
function unwrap(value) {
  let data = value
  for (let depth = 0; depth < 6 && data && typeof data === 'object'; depth++) {
    if (data.success === false || data.failed === true || data.successResponse === false) throw fault(classify(JSON.stringify(data)))
    if (data.DataV2) { data = data.DataV2; continue }
    if (data.ret && !data.ret.every(item => typeof item === 'string' && item.startsWith('SUCCESS'))) throw fault(classify(data.ret))
    if (data.data !== undefined) { data = data.data; continue }
    return data
  }
  if (!data || typeof data !== 'object') throw fault('response')
  return data
}
function maskedMatch(mask, key) {
  if (typeof mask !== 'string' || typeof key !== 'string') return false
  const match = /^(sk-sp-[^*…]+)\*+([^*…]+)$/.exec(mask)
  // Require the currently observed substantial prefix/suffix, not just "sk-sp-".
  return !!match && match[1].length >= 15 && match[2].length >= 15
    && key.length > match[1].length + match[2].length && key.startsWith(match[1]) && key.endsWith(match[2])
}
function executable() {
  const path = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? ''
  for (const directory of path.split(delimiter).filter(Boolean)) {
    if (process.platform === 'win32') {
      const script = join(directory, 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs')
      if (fs.existsSync(script)) return { file: process.execPath, args: [script], node: true }
    }
    const file = join(directory, process.platform === 'win32' ? 'bl.exe' : 'bl')
    try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return { file, args: [] } }
    catch { /* Continue searching PATH when this candidate is unavailable. */ }
  }
  throw fault('missing')
}
function validNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function date(value, language) { return validNumber(value) && value > 0 && value < 8.64e15 ? new Date(value).toLocaleString(language) : null }
function accountLabel(user) { return user.name === user.uid ? user.uid : `${user.name} (${user.uid})` }

function createBailian() {
  const cancellations = new Set(), cache = new Map()
  let login, loginError, stopped = false
  function run(args, signal, { json = true, timeout = 12_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (stopped || signal?.aborted) { reject(fault('timeout')); return }
      let target
      try { target = executable() } catch (error) { reject(error); return }
      const env = { ...process.env, ...(target.node ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
      let child, settled = false, size = 0, stdout = '', stderr = '', timer, killTimer
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(value)
      }
      const abort = () => {
        finish(fault('timeout'))
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000)
        killTimer.unref?.()
        child.kill()
      }
      try {
        child = childProcess.spawn(target.file, [...target.args, ...args, '--quiet', ...(json ? ['--output', 'json'] : []), '--timeout', String(Math.ceil(timeout / 1000))],
          { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch { finish(fault('missing')); return }
      cancellations.add(abort)
      timer = setTimeout(abort, timeout)
      signal?.addEventListener('abort', abort, { once: true })
      for (const [stream, name] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', chunk => {
        size += chunk.length
        if (size > 1024 * 1024) { abort(); return }
        if (name === 'out') stdout += chunk.toString(); else stderr += chunk.toString()
      })
      child.on('error', error => { cancellations.delete(abort); finish(fault(error.code === 'ENOENT' ? 'missing' : 'network')) })
      child.on('close', code => {
        cancellations.delete(abort); clearTimeout(killTimer)
        if (settled) return
        if (code !== 0) { finish(fault(classify(stdout + stderr))); return }
        if (!json) { finish(null, null); return }
        try { finish(null, JSON.parse(stdout)) } catch { finish(fault('response')) }
      })
    })
  }
  function consoleCall(name, data, profile, signal) {
    return run(['console', 'call', '--api', name, '--data', JSON.stringify(data), '--config', profile, '--console-region', 'cn-beijing', '--console-site', 'domestic'], signal).then(unwrap)
  }
  async function identity(profile, signal, includeName = false) {
    const info = await consoleCall(api.identity, {}, profile, signal)
    if (info.loginStatus !== 'ALIYUN_LOGINED') throw fault('login')
    const user = info.aliyun
    if (!user || typeof user.uid !== 'string' || !user.uid) throw fault('response')
    let name = user.nickName || user.userName || user.uid
    if (includeName) {
      const config = await consoleCall(api.account, {}, profile, signal)
      if (!config.user || !config.user.outerKey) throw fault('response')
      if (String(config.user.outerKey) !== user.uid) throw fault('mismatch')
      if (typeof config.user.showName === 'string' && config.user.showName.trim()) name = config.user.showName.trim()
    }
    return { uid: user.uid, parentUid: user.parentUid, name }
  }
  async function query(model, plan, profile, signal) {
    if (plan) {
      const key = await consoleCall(api.planKey, {}, profile, signal)
      if (!key.key_id || !key.mask_apikey) throw fault('key_missing')
      if (!maskedMatch(key.mask_apikey, model.apiKey)) throw fault('mismatch')
      const [usage, subscription] = await Promise.all([
        consoleCall(api.usage, {}, profile, signal),
        consoleCall(api.subscription, { queryInstanceInfoRequest: {} }, profile, signal)
      ])
      if (Array.isArray(usage) || Array.isArray(subscription)) throw fault('response')
      return { plan, usage, subscription }
    }
    let keyInfo
    for (let pageNo = 1; pageNo <= 50; pageNo++) {
      const page = await consoleCall(api.keys, { pageNo, pageSize: 50 }, profile, signal)
      if (!Array.isArray(page.items) || !validNumber(page.total)) throw fault('response')
      for (const item of page.items) {
        // The ordinary list is masked too. Only retrieve details for matching candidates.
        const mask = item.key
        if (typeof mask !== 'string') throw fault('response')
        const parts = mask.split(/\*+/)
        const candidate = parts.length === 1 ? mask === model.apiKey
          : parts.length === 2 && model.apiKey.startsWith(parts[0]) && model.apiKey.endsWith(parts[1])
        if (!candidate) continue
        const detail = await consoleCall(api.key, { reqDTO: { id: item.id }, _params: { apiKeyId: item.id } }, profile, signal)
        if (detail.key !== model.apiKey) continue
        if (detail.blocked || item.deleted) throw fault('key_disabled')
        if (!detail.workspace_id || !detail.id) throw fault('response')
        keyInfo = { id: String(detail.id), workspace: String(detail.workspace_id), workspaceName: detail.workspace_name }
        break
      }
      if (keyInfo) break
      if (pageNo * 50 >= page.total) break
      if (!page.items.length || pageNo === 50) throw fault('response')
    }
    if (!keyInfo) throw fault('mismatch')
    const scope = ['--config', profile, '--console-region', 'cn-beijing', '--console-site', 'domestic', '--workspace-id', keyInfo.workspace]
    const [free, stats] = await Promise.all([
      run(['usage', 'free', '--model', model.model, ...scope], signal),
      run(['monitor', 'overview', '--api-key-id', keyInfo.id, '--days', '7', ...scope], signal)
    ])
    if (!Array.isArray(free) || !stats || !validNumber(stats.callCount) || !Array.isArray(stats.usages)) throw fault('response')
    return { plan, keyInfo, free, stats }
  }
  function render(data, language, user, model) {
    const t = words(language), zh = language.startsWith('zh'), lines = [], notes = []
    notes.push(`${t.account}: ${accountLabel(user)}`)
    const title = `${t.title} · ${data.plan ? 'Token Plan' : t.ordinary}`
    if (data.plan) {
      for (const [prefix, label, short] of [['per5Hour', zh ? '5 小时' : '5-hour', '5h'], ['per1Week', zh ? '周' : 'Weekly', zh ? '周' : 'Week'], ['per1Month', zh ? '月' : 'Monthly', zh ? '月' : 'Month']]) {
        const used = data.usage[prefix + 'Percentage']
        if (used === undefined || used === null) continue
        if (!validNumber(used)) throw fault('response')
        const remaining = Math.max(0, 1 - used)
        const reset = date(data.usage[prefix + 'ResetTime'], language)
        lines.push({ label: `${label} ${t.remaining}`, compactLabel: short, value: `${Number((remaining * 100).toFixed(1))}%`, progress: remaining,
          ...(reset ? { description: `${t.reset}: ${reset}` } : {}) })
      }
      const sub = data.subscription
      if (typeof sub.specCode === 'string') notes.push(`${zh ? '套餐' : 'Plan'}: ${sub.specCode}`)
      if (typeof sub.status === 'string') {
        const statuses = zh ? { VALID: '有效', EXPIRED: '已到期', INVALID: '无效' } : { VALID: 'Active', EXPIRED: 'Expired', INVALID: 'Inactive' }
        notes.push(`${zh ? '状态' : 'Status'}: ${statuses[sub.status] ?? sub.status}`)
      }
      if (typeof sub.autoRenewFlag === 'boolean') notes.push(`${zh ? '自动续费' : 'Auto-renew'}: ${sub.autoRenewFlag ? (zh ? '开启' : 'On') : (zh ? '关闭' : 'Off')}`)
      const expiry = date(sub.endTime, language)
      if (expiry) notes.push(`${t.expires}: ${expiry}`)
    } else {
      notes.push(`${t.workspace}: ${data.keyInfo.workspaceName || data.keyInfo.workspace}`)
      for (const quota of data.free.filter(row => row.model === model.model)) {
        if (quota.remaining === null || quota.remaining === undefined) continue
        if (!validNumber(quota.remaining)) throw fault('response')
        lines.push({ label: `${t.free} · ${model.model}`, compactLabel: zh ? '免费' : 'Free', value: new Intl.NumberFormat(language).format(quota.remaining),
          ...(quota.expires ? { description: `${zh ? '额度到期' : 'Quota expires'}: ${quota.expires}` } : {}) })
      }
      if (!lines.length) notes.push(t.noFree)
      lines.push({ label: t.calls, compactLabel: zh ? '7天调用' : '7d calls', value: new Intl.NumberFormat(language).format(data.stats.callCount),
        breakdown: validNumber(data.stats.callFailedCount) ? [{ label: t.failed, value: String(data.stats.callFailedCount) }] : [] })
      for (const usage of data.stats.usages) {
        if (typeof usage.key !== 'string' || !validNumber(usage.value)) throw fault('response')
        lines.push({ label: `${t.stats} · ${usage.key}`, compactLabel: usage.key, value: `${new Intl.NumberFormat(language).format(usage.value)}${usage.unit ? ` ${usage.unit}` : ''}` })
      }
      if (data.stats.callCount === 0) notes.push(t.noCalls)
    }
    return { title, lines, notes, ...(data.plan && !lines.length ? { emptyLabel: t.noQuota } : {}), updatedAt: data.updatedAt }
  }
  async function read(model, language, action, signal) {
    const t = words(language), plan = new URL(model.baseUrl).hostname.startsWith('token-plan.'), controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 25_000)
    let user
    const base = { title: `${t.title} · ${plan ? 'Token Plan' : t.ordinary}`, lines: [] }
    const waiting = () => ({ ...base, emptyLabel: t.waiting, notice: t.loginHint, actions: [{ id: 'cancel_login', label: t.cancelButton }] })
    try {
      if (signal.aborted || stopped) throw fault('timeout')
      if (action === 'cancel_login') { login?.controller.abort(); login = undefined; loginError = undefined }
      if (login) return waiting()
      if (loginError && action !== 'login') { const error = loginError; loginError = undefined; throw error }
      const status = await run(['auth', 'status'], controller.signal)
      // Another window can start login while this request reads CLI status.
      if (login) return waiting()
      if (typeof status.config !== 'string') throw fault('response')
      const profile = status.config
      if (action === 'login') {
        cache.clear()
        loginError = undefined
        const current = { controller: new AbortController() }
        login = current
        current.done = run(['auth', 'login', '--console', '--console-site', 'domestic', '--config', profile], current.controller.signal, { json: false, timeout: 180_000 })
          .catch(() => { if (login === current) loginError = fault('login_failed') })
          .finally(() => { if (login === current) { login = undefined; cache.clear() } })
        return waiting()
      }
      if (!status.console) throw fault('login')
      if (!model.apiKey) throw fault('model_key')
      if (plan !== model.apiKey.startsWith('sk-sp-')) throw fault('key_type')
      user = await identity(profile, controller.signal, true)
      const scope = createHash('sha256').update(JSON.stringify([model.baseUrl, model.apiKey, model.model, profile, status.console.masked, user.uid, user.parentUid])).digest('hex')
      let entry = cache.get(scope)
      if (!entry || action === 'refresh' || Date.now() >= entry.nextAt) {
        if (!entry?.pending) {
          if (cache.size >= 32) cache.clear()
          entry = { nextAt: 0 }
          cache.set(scope, entry)
          const current = entry
          current.pending = query(model, plan, profile, controller.signal).then(async data => {
            const after = await identity(profile, controller.signal)
            if (after.uid !== user.uid || after.parentUid !== user.parentUid) throw fault('mismatch')
            // Validate before caching, so malformed data cannot replace a valid reading.
            render(data, language, user, model)
            current.data = { ...data, updatedAt: Date.now() }
            current.nextAt = Date.now() + 300_000
          }).catch(error => { current.error = error; current.nextAt = Date.now() + 60_000 }).finally(() => { current.pending = undefined })
        }
      }
      await entry.pending
      if (entry.error) throw entry.error
      return render(entry.data, language, user, model)
    } catch (error) {
      const code = Object.hasOwn(copy.en, error.message) ? error.message : 'network'
      const auth = ['login', 'mismatch', 'key_missing', 'login_failed'].includes(code)
      return { ...base, emptyLabel: t[code], error: t[code], notes: user ? [`${t.account}: ${accountLabel(user)}`] : [],
        ...(auth ? { actions: [{ id: 'login', label: code === 'mismatch' || code === 'key_missing' ? t.switchButton : t.loginButton }] } : {}),
        ...(code === 'missing' ? { installLink: true } : {}) }
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }
  return { read, stop() { stopped = true; login?.controller.abort(); for (const cancel of cancellations) cancel(); cache.clear() } }
}
module.exports = { hosts, createBailian, maskedMatch }
