// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import childProcess, { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { PluginWidgetContent } from '@shared/pluginWidgets'

const load = createRequire(import.meta.url)
const backendPath = resolve('data/plugins/usage-meter/backend.cjs')
const key = 'sk-sp-123456789-middle-secret-987654321abcdef'
const mask = key.slice(0, 15) + '****' + key.slice(-15)
const model = { id: 'q', model: 'qwen-plus', providerId: 'p', providerName: 'Qwen', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: key }
const wrap = (data: unknown) => ({ successResponse: true, data: { success: true, DataV2: { ret: ['SUCCESS::ok'], data: { success: true, data } } } })
let backend: { activate(context: { dataDirectory: string }): void; call(method: string, params: unknown, context: { signal: AbortSignal }): Promise<PluginWidgetContent>; deactivate(): void }
let home: string, commands: string[][], processes: Array<ChildProcess>, uid: string
let respond: (args: string[]) => unknown
let holdLogin: boolean, noConsole: boolean
const text = async (action?: string, changes = {}, language = 'zh-CN') => {
  const result = await backend.call('quota', { model: { ...model, ...changes }, language, action }, { signal: new AbortController().signal })
  const template = document.createElement('template'); template.innerHTML = result.html
  return { html: result.html, dom: template.content, text: template.content.textContent ?? '',
    details: template.content.querySelector('[data-details]')?.getAttribute('data-details') }
}
function defaultResponse(args: string[]) {
  if (args[0] === 'auth') return { config: 'token-plan', console: noConsole ? undefined : { masked: 'console-credential' } }
  if (args[0] === 'usage') return [{ model: 'qwen-plus', remaining: 0, total: 1000, expires: '2026-12-01', autoStop: true }]
  if (args[0] === 'monitor') return { callCount: 12, callFailedCount: 1, usages: [{ key: 'input_tokens', unit: 'tokens', value: 2000 }] }
  const api = args[args.indexOf('--api') + 1]
  if (api.endsWith('.loginInfo')) return wrap({ loginStatus: 'ALIYUN_LOGINED', aliyun: { uid, parentUid: uid, nickName: 'Test account', sessionInfo: 'must-not-render' } })
  if (api.endsWith('.getGConfig')) return wrap({ user: { outerKey: uid, showName: 'Readable account' } })
  if (api.endsWith('/getKeyByUid')) return wrap({ key_id: 'plan-key-id', mask_apikey: mask })
  if (api.endsWith('/usage')) return wrap({ per1MonthPercentage: .65, per1MonthResetTime: Date.now() + 86400000 })
  if (api.endsWith('/subscription')) return wrap({ specCode: 'lite', endTime: Date.now() + 30 * 86400000 })
  if (api.endsWith('.listApiKeys4Agent')) return wrap({ total: 1, items: [{ id: 42, key: 'sk-ord****ending', workspace_id: 'ws', deleted: 0 }] })
  if (api.endsWith('.getApiKey')) return wrap({ id: 42, key: 'sk-ordinary-secret-ending', workspace_id: 'ws', workspace_name: 'Test workspace', blocked: 0 })
  throw new Error('Unexpected command')
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bailian-widget-'))
  const file = join(home, process.platform === 'win32' ? 'bl.exe' : 'bl')
  writeFileSync(file, 'fixture'); chmodSync(file, 0o755)
  vi.stubEnv('PATH', home)
  commands = []; processes = []; uid = 'account-1'; holdLogin = false; noConsole = false
  respond = defaultResponse
  vi.spyOn(childProcess, 'spawn').mockImplementation(((_file: string, args: string[]) => {
    commands.push(args)
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true }) })
    processes.push(child)
    queueMicrotask(() => {
      if (holdLogin && args[0] === 'auth' && args[1] === 'login') return
      try { child.stdout!.emit('data', Buffer.from(JSON.stringify(respond(args)))); child.emit('close', 0) }
      catch { child.stderr!.emit('data', Buffer.from('request failed')); child.emit('close', 1) }
    })
    return child
  }) as typeof childProcess.spawn)
  delete load.cache[backendPath]
  backend = load(backendPath)
  writeFileSync(join(home, 'display.json'), JSON.stringify({ version: 0, display_mode: 'detailed' }))
  backend.activate({ dataDirectory: home })
})
afterEach(() => { backend.deactivate(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(home, { recursive: true, force: true }) })

it('shows monthly remaining quota, account and expiry without exposing credentials; caches and refreshes', async () => {
  const first = await text()
  expect(first.text).toContain('35.00%')
  expect(first.text).toContain('月 剩余')
  expect(first.dom.querySelector('[data-details]')?.getAttribute('data-details')).toContain('套餐到期')
  expect(first.details).toContain('Readable account (account-1)')
  expect(first.text).not.toContain('Readable account')
  expect(first.dom.querySelector('progress')!.value).toBe(.35)
  expect(first.html).not.toContain(key)
  expect(first.html).not.toContain(mask)
  expect(first.html).not.toContain('must-not-render')
  await text()
  expect(commands.filter(args => args.includes('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'))).toHaveLength(1)
  await text('refresh')
  expect(commands.filter(args => args.includes('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'))).toHaveLength(2)
})
it.each(['zh-CN', 'en'])('groups subscription details locally while keeping the compact tooltip complete (%s)', async language => {
  respond = args => args.some(x => x.endsWith('/subscription'))
    ? wrap({ specCode: 'lite', status: 'VALID', autoRenewFlag: false, endTime: Date.now() + 86400000 }) : defaultResponse(args)
  const zh = language === 'zh-CN'
  const detailed = await text(undefined, {}, language)
  expect(detailed.text).not.toContain(zh ? '套餐: lite' : 'Plan: lite')
  expect(detailed.text).not.toContain(zh ? '自动续费' : 'Auto-renew')
  const button = detailed.dom.querySelector('[data-details]')!
  expect(button.getAttribute('aria-label')).toBe(zh ? '详情' : 'Details')
  expect(button.querySelector('img')).not.toBeNull()
  expect(button.closest('footer')?.querySelector('time')).not.toBeNull()
  expect(detailed.dom.querySelectorAll('[data-details]')).toHaveLength(1)
  expect(button.hasAttribute('data-action')).toBe(false)
  const details = button.getAttribute('data-details')!
  expect(details).toContain(zh ? '套餐: lite' : 'Plan: lite')
  expect(details).toContain('Readable account (account-1)')
  expect(details).toContain(zh ? '状态: 有效' : 'Status: Active')
  expect(details).toContain(zh ? '自动续费: 关闭' : 'Auto-renew: Off')
  expect(details).toContain(zh ? '套餐到期:' : 'Plan expires:')
  const compact = await text('show_compact', {}, language)
  expect(compact.dom.querySelector('[data-details]')).toBeNull()
  expect(compact.dom.querySelector('[tabindex="0"]')!.getAttribute('title')).toContain(details)
  expect(commands.filter(args => args.includes('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription'))).toHaveLength(1)
})
it('keeps account and partial subscription details without inventing missing values', async () => {
  respond = args => args.some(x => x.endsWith('/subscription')) ? wrap({ specCode: 'lite' }) : defaultResponse(args)
  const summary = await text()
  expect(summary.details).toContain('套餐: lite')
  expect(summary.details).not.toMatch(/自动续费|套餐到期|状态/)
  respond = args => args.some(x => x.endsWith('/subscription')) ? wrap({ autoRenewFlag: false }) : defaultResponse(args)
  const partial = await text('refresh')
  expect(partial.details).toContain('自动续费: 关闭')
  expect(partial.details).not.toMatch(/lite|套餐到期|状态/)
  respond = args => args.some(x => x.endsWith('/subscription')) ? wrap({}) : defaultResponse(args)
  const accountOnly = await text('refresh')
  expect(accountOnly.details).toBe('控制台账户: Readable account (account-1)')
})
it.each(['EXPIRED', 'INVALID'])('keeps an unusable subscription visible outside the details (%s)', async status => {
  respond = args => args.some(x => x.endsWith('/subscription')) ? wrap({ specCode: 'lite', status }) : defaultResponse(args)
  const result = await text()
  expect(result.dom.querySelector('[role="status"]')?.textContent).toBe(`套餐状态: ${status === 'EXPIRED' ? '已到期' : '无效'}`)
  expect(result.details).toContain('套餐: lite')
})
it.each(['zh-CN', 'en'])('keeps two decimal places for quota text in detailed, compact and hover views (%s)', async language => {
  respond = args => args.some(x => x.endsWith('/usage')) ? wrap({
    per5HourPercentage: .23456, per1WeekPercentage: .123456, per1MonthPercentage: .64951
  }) : defaultResponse(args)
  const detailed = await text(undefined, {}, language)
  for (const percentage of ['76.54%', '87.65%', '35.05%']) expect(detailed.text).toContain(percentage)
  const progress = [...detailed.dom.querySelectorAll('progress')].map(element => element.value)
  expect(progress[0]).toBeCloseTo(.76544, 10)
  expect(progress[1]).toBeCloseTo(.876544, 10)
  expect(progress[2]).toBeCloseTo(.35049, 10)
  const compact = await text('show_compact', {}, language)
  const hover = compact.dom.querySelector('[tabindex="0"]')!.getAttribute('title')
  for (const percentage of ['76.54%', '87.65%', '35.05%']) {
    expect(compact.text).toContain(percentage)
    expect(hover).toContain(percentage)
  }
  expect(commands.filter(args => args.includes('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'))).toHaveLength(1)
})
it('does not duplicate numeric account names and rejects account metadata from another session', async () => {
  respond = args => args.some(x => x.endsWith('.getGConfig')) ? wrap({ user: { outerKey: uid, showName: uid } }) : defaultResponse(args)
  expect((await text()).details).toContain('控制台账户: account-1')
  expect((await text()).details).not.toContain('account-1 (account-1)')
  respond = args => args.some(x => x.endsWith('.getGConfig')) ? wrap({ user: { outerKey: 'other', showName: 'Other account' } }) : defaultResponse(args)
  const result = await text()
  expect(result.text).toContain('不匹配')
  expect(result.text).not.toContain('35.00%')
  expect(result.text).not.toContain('Other account')
})
it('reports a missing CLI with installation help', async () => {
  rmSync(join(home, process.platform === 'win32' ? 'bl.exe' : 'bl'))
  const result = await text()
  expect(result.text).toContain('未找到 bl')
  expect(result.dom.querySelector('a')!.textContent).toBe('安装说明')
  expect(commands).toHaveLength(0)
})
it('shows login for missing sessions and distinguishes permission failures', async () => {
  noConsole = true
  expect((await text()).dom.querySelector('[data-action="login"]')!.textContent).toBe('登录百炼')
  noConsole = false
  respond = args => args[0] === 'console' ? wrap({ success: false, errorCode: 'Forbidden.NoPermission', message: key }) : defaultResponse(args)
  const result = await text()
  expect(result.text).toContain('无权查询')
  expect(result.dom.querySelector('[data-action="login"]')).toBeNull()
  expect(result.html).not.toContain(key)
})
it('rejects mismatched and insufficiently specific masks without fetching usage', async () => {
  for (const mask_apikey of ['sk-sp-****abcdef', mask.slice(0, -1) + 'X']) {
    respond = args => args.some(x => x.endsWith('/getKeyByUid')) ? wrap({ key_id: 'id', mask_apikey }) : defaultResponse(args)
    const result = await text('refresh')
    expect(result.text).toContain('不匹配')
    expect(result.dom.querySelector('[data-action="login"]')!.textContent).toBe('切换账户登录')
  }
  expect(commands.some(args => args.some(x => x.endsWith('/usage')))).toBe(false)
})
it('does not retain previous quota when the control-plane account changes', async () => {
  expect((await text()).text).toContain('35.00%')
  uid = 'account-2'
  respond = args => args.some(x => x.endsWith('/getKeyByUid')) ? wrap({ key_id: 'other', mask_apikey: mask.replace('abcdef', 'zzzzzz') }) : defaultResponse(args)
  const result = await text()
  expect(result.text).toContain('不匹配')
  expect(result.text).toContain('account-2')
  expect(result.text).not.toContain('35.00%')
})
it('discards results when the console account changes during a query', async () => {
  let reads = 0
  respond = args => {
    if (args.some(x => x.endsWith('.loginInfo')) && ++reads === 2) uid = 'account-2'
    return defaultResponse(args)
  }
  const result = await text()
  expect(result.text).toContain('不匹配')
  expect(result.text).not.toContain('35.00%')
  expect(result.dom.querySelector('[data-action="login"]')).not.toBeNull()
})
it('recognizes an expired session inside a successful gateway response', async () => {
  respond = args => args.some(x => x.endsWith('.loginInfo'))
    ? { successResponse: true, data: { success: true, DataV2: { ret: ['FAIL_SYS_SESSION_EXPIRED::session expired'] } } }
    : defaultResponse(args)
  const result = await text()
  expect(result.text).toContain('登录已过期')
  expect(result.dom.querySelector('[data-action="login"]')).not.toBeNull()
  expect(commands.some(args => args.some(x => x.endsWith('/usage')))).toBe(false)
})
it('matches ordinary keys exactly and scopes statistics to their workspace and key, preserving zero free quota', async () => {
  const result = await text(undefined, { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-ordinary-secret-ending' })
  expect(result.text).toContain('当前模型免费额度')
  expect(result.text).not.toContain('Test workspace')
  expect(result.details).toContain('Test workspace')
  expect(result.text).toContain('12')
  expect(result.text).not.toContain('2,000 tokens')
  expect(result.details).toContain('2,000 tokens')
  expect(result.details).toContain('失败调用: 1')
  expect(result.details).toContain('额度到期: 2026-12-01')
  expect(result.html).not.toContain('sk-ordinary-secret-ending')
  const command = commands.find(args => args[0] === 'monitor')!
  expect(command.slice(0, 8)).toEqual(['monitor', 'overview', '--api-key-id', '42', '--days', '7', '--config', 'token-plan'])
  expect(command[command.indexOf('--workspace-id') + 1]).toBe('ws')
})
it('does not treat an ordinary masked collision as an exact match', async () => {
  const result = await text(undefined, { baseUrl: 'https://dashscope.aliyuncs.com/v1', apiKey: 'sk-ordinary-different-ending' })
  expect(result.text).toContain('不匹配')
  expect(commands.some(args => args[0] === 'monitor')).toBe(false)
})
it('launches login without blocking the widget, prevents duplicates, and refreshes after completion', async () => {
  holdLogin = true; noConsole = true
  expect((await text('login')).text).toContain('等待浏览器登录')
  expect((await text('login')).dom.querySelector('[data-action="cancel_login"]')).not.toBeNull()
  const index = commands.findIndex(args => args[0] === 'auth' && args[1] === 'login')
  expect(commands.filter(args => args[1] === 'login')).toHaveLength(1)
  expect(commands[index]).toContain('--console')
  expect(commands[index][commands[index].indexOf('--config') + 1]).toBe('token-plan')
  processes[index].emit('close', 0); noConsole = false
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((await text()).text).toContain('35.00%')
})
it('starts only one browser login when windows request login concurrently', async () => {
  holdLogin = true; noConsole = true
  const results = await Promise.all([text('login'), text('login')])
  expect(results.every(result => result.text.includes('等待浏览器登录'))).toBe(true)
  expect(commands.filter(args => args[0] === 'auth' && args[1] === 'login')).toHaveLength(1)
  await text('cancel_login')
  expect(processes.filter((_, index) => commands[index][1] === 'login').every(child => vi.mocked(child.kill).mock.calls.length === 1)).toBe(true)
})
it('keeps subscription information when the plan returns no quota windows', async () => {
  respond = args => args.some(x => x.endsWith('/usage')) ? wrap({}) : defaultResponse(args)
  const result = await text()
  expect(result.text).toContain('套餐未返回额度数据')
  expect(result.dom.querySelector('[data-details]')?.getAttribute('data-details')).toContain('套餐到期')
  expect(result.details).toContain('lite')
  expect(result.text).not.toContain('无法识别')
  expect(result.dom.querySelector('progress')).toBeNull()
  const compact = await text('show_compact', {}, 'en')
  expect(compact.text).toContain('No quota data returned for this plan')
  expect(compact.dom.querySelector('[tabindex="0"]')!.getAttribute('title')).toContain('Plan expires')
})
it('cancels browser login and stops child processes on backend shutdown', async () => {
  holdLogin = true
  await text('login')
  const first = processes[commands.findIndex(args => args[1] === 'login')]
  await text('cancel_login')
  expect(first.kill).toHaveBeenCalled()
  await text('login')
  const last = processes.at(-1)!
  backend.deactivate()
  expect(last.kill).toHaveBeenCalled()
})
it('reports unsuccessful login and allows retry', async () => {
  holdLogin = true
  await text('login')
  processes.at(-1)!.emit('close', 1)
  await new Promise(resolve => setTimeout(resolve, 0))
  const result = await text()
  expect(result.text).toContain('登录未完成')
  expect(result.dom.querySelector('[data-action="login"]')).not.toBeNull()
})
it('handles absent keys, invalid quota payloads and English UI', async () => {
  respond = args => args.some(x => x.endsWith('/getKeyByUid')) ? wrap({}) : defaultResponse(args)
  expect((await text()).text).toContain('没有可用的 Token Plan Key')
  respond = args => args.some(x => x.endsWith('/usage')) ? wrap({ per1MonthPercentage: '65' }) : defaultResponse(args)
  expect((await text('refresh')).text).toContain('无法识别')
  respond = defaultResponse
  const result = await text('refresh', {}, 'en')
  expect(result.text).toContain('Monthly remaining')
  expect(result.dom.querySelector('[data-details]')?.getAttribute('data-details')).toContain('Plan expires')
})
it('bounds query time and kills hung commands', async () => {
  vi.useFakeTimers()
  vi.mocked(childProcess.spawn).mockImplementationOnce((() => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { child.emit('close', null); return true }) })
    processes.push(child); return child
  }) as typeof childProcess.spawn)
  const pending = text()
  await vi.advanceTimersByTimeAsync(12_000)
  expect((await pending).text).toContain('超时')
  expect(processes[0].kill).toHaveBeenCalled()
})
