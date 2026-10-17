const assert = require('node:assert/strict')
const { mkdtemp, mkdir, writeFile, readFile, rm, chmod } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function verifyQuotaTooltip(page) {
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toContainText(/(?:重置时间|Resets): \d/)
  await expect(tooltip).toContainText(/(?:更新于|Updated): \d/)
  const layout = await tooltip.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const style = globalThis.getComputedStyle(element)
    const lines = element.textContent.split('\n').length
    return { left: rect.left, right: rect.right, viewportWidth: globalThis.innerWidth, height: rect.height,
      naturalHeight: lines * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) }
  })
  assert.ok(layout.left >= 12 && layout.right <= layout.viewportWidth - 12, 'Quota tooltip must stay within the window')
  assert.ok(layout.height <= layout.naturalHeight + 1, 'Quota labels and timestamps must fit without extra wrapping')
}

async function verifyPluginWidgets(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-plugin-widgets-'))
  const output = resolve('tmp/plugin-widgets')
  await mkdir(output, { recursive: true })
  const mode = join(home, 'query-mode'), calls = join(home, 'query-calls'), layout = join(home, 'layout.html')
  const pending = join(home, 'query-pending')
  const bailianMode = join(home, 'bailian-mode'), loginDone = join(home, 'login-done')
  const fixtureBin = join(home, 'bin')
  await mkdir(join(fixtureBin, 'node_modules', 'bailian-cli', 'dist'), { recursive: true })
  const cli = `#!/usr/bin/env node
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const mode = fs.existsSync(${JSON.stringify(bailianMode)}) ? fs.readFileSync(${JSON.stringify(bailianMode)}, 'utf8') : 'ok';
    const wrap = data => ({successResponse: true, data: {success: true, DataV2: {ret: ['SUCCESS::ok'], data: {success: true, data}}}});
    const out = data => process.stdout.write(JSON.stringify(data));
    if (args[0] === 'auth' && args[1] === 'login') {
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(loginDone)})) { clearInterval(timer); out({}); } }, 100);
    } else if (args[0] === 'auth') out({ config: 'fixture', console: mode === 'logged-out' ? undefined : {masked: 'fixture-session'} });
    else if (args[0] === 'usage') out([{model: args[args.indexOf('--model') + 1], remaining: 5000, expires: '2026-12-01'}]);
    else if (args[0] === 'monitor') out({callCount: 12, callFailedCount: 1, usages: [{key: 'input_tokens', value: 2000, unit: 'tokens'}]});
    else {
      const api = args[args.indexOf('--api') + 1];
      if (api.endsWith('.loginInfo')) out(wrap({loginStatus: 'ALIYUN_LOGINED', aliyun: {uid: 'fixture-account', parentUid: 'fixture-account', nickName: 'Fixture account'}}));
      else if (api.endsWith('.getGConfig')) out(wrap({user: {outerKey: 'fixture-account', showName: 'Fixture account'}}));
      else if (api.endsWith('/getKeyByUid')) out(wrap({key_id: 'fixture-key-id', mask_apikey: mode === 'mismatch' ? 'sk-sp-9876543210****wrong-ending-xx' : 'sk-sp-123456789-****987654321abcdef'}));
      else if (api.endsWith('/usage')) out(wrap({per1MonthPercentage: .64951, per1MonthResetTime: Date.now() + 86400000}));
      else if (api.endsWith('/subscription')) out(wrap({specCode: 'lite', status: 'VALID', autoRenewFlag: false, endTime: Date.now() + 30 * 86400000}));
      else if (api.endsWith('.listApiKeys4Agent')) out(wrap({total: 1, items: [{id: 42, key: 'sk-ord****ending', deleted: 0}]}));
      else if (api.endsWith('.getApiKey')) out(wrap({id: 42, key: 'sk-ordinary-secret-ending', workspace_id: 'ws', workspace_name: 'Fixture workspace', blocked: 0}));
      else { process.exitCode = 1; }
    }
  `
  await writeFile(join(fixtureBin, 'bl'), cli)
  await chmod(join(fixtureBin, 'bl'), 0o755)
  await writeFile(join(fixtureBin, 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs'), cli.replace("const fs = require('node:fs');", "import fs from 'node:fs';"))
  const wrapper = join(home, 'usage-test.cjs')
  // Run the real backend in its utility process with fixture HTTP and CLI responses.
  await writeFile(wrapper, `
    const fs = require('node:fs');
    process.env.PATH = ${JSON.stringify(fixtureBin)} + require('node:path').delimiter + process.env.PATH;
    global.fetch = async (url, options) => {
      if (url === 'https://api.deepseek.com/user/balance') return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00001', granted_balance: '10.00', topped_up_balance: '100.00001' }] });
      if (url === 'https://api.moonshot.cn/v1/users/me/balance' || url === 'https://api.moonshot.ai/v1/users/me/balance') return Response.json({ code: 0, status: true, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 } });
      if (url === 'https://openrouter.ai/api/v1/key') return Response.json({ data: { limit: 100, limit_remaining: 74.5, limit_reset: 'monthly', usage: 25.5, usage_daily: 0, usage_weekly: 3.5, usage_monthly: 5.5 } });
      if (url === 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report') {
        if (options.headers.Authorization !== 'fixture-key') throw new Error('GLM expects the raw API key');
        return Response.json({ code: 200, success: true, data: { availableBalance: 0.123456789, rechargeAmount: 20, totalSpendAmount: 18.5, frozenBalance: 0 } });
      }
      if (['https://open.bigmodel.cn/api/monitor/usage/quota/limit', 'https://api.z.ai/api/monitor/usage/quota/limit'].includes(url)) {
        if (options.headers.Authorization === 'no-plan-key') return Response.json({ code: 500, success: false, msg: '当前用户不存在coding plan' });
        if (options.headers.Authorization !== 'fixture-key') throw new Error('GLM expects the raw API key');
        return Response.json({ code: 200, success: true, data: { limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 25, nextResetTime: Date.now() + 3600000 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 15, nextResetTime: Date.now() + 86400000 }
        ] } });
      }
      if (url !== 'https://www.minimaxi.com/v1/token_plan/remains') throw new Error('Unexpected URL');
      if (options.headers.Authorization !== 'Bearer fixture-key') throw new Error('Unexpected credentials');
      fs.appendFileSync(${JSON.stringify(calls)}, 'query\\n');
      await new Promise(resolve => setTimeout(resolve, 250));
      if (fs.existsSync(${JSON.stringify(mode)})) return new Response('', { status: 429 });
      const now = Date.now();
      return Response.json({base_resp: {status_code: 0}, model_remains: [{model_name: 'general', current_interval_remaining_percent: 90,
        current_weekly_remaining_percent: 99, weekly_boost_permille: 1500, start_time: now - 4 * 3600000, end_time: now + 3600000,
        weekly_start_time: now - 6 * 86400000, weekly_end_time: now + 86400000}]});
    };
    const backend = require(${JSON.stringify(join(home, 'plugins/_system/usage-meter/backend.cjs'))});
    module.exports = { ...backend, async call(...args) {
      while (fs.existsSync(${JSON.stringify(pending)})) await new Promise(resolve => setTimeout(resolve, 25));
      if (fs.existsSync(${JSON.stringify(layout)})) return {title: 'HTML fixture', html: fs.readFileSync(${JSON.stringify(layout)}, 'utf8')};
      return backend.call(...args);
    }};
  `)
  let app
  const errors = []
  try {
    app = await launchApplication(home)
    const page = await app.firstWindow()
    page.setDefaultTimeout(30_000)
    page.on('pageerror', error => errors.push(String(error)))
    await page.locator('[data-agent-composer-input]').waitFor()
    const builtin = await page.evaluate(async () => (await globalThis.gale.plugins.list()).find(item => item.id === 'usage-meter'))
    assert.equal(builtin.builtin, true)
    assert.equal(builtin.enabled, true)
    assert.equal(builtin.backendStatus, 'stopped')
    await expect(page.locator('.plugin-widget')).toHaveCount(0)
    await app.evaluate(({ utilityProcess }, path) => {
      const fork = utilityProcess.fork.bind(utilityProcess)
      utilityProcess.fork = (entry, args, options) => fork(entry, args?.[0]?.replaceAll('\\', '/').endsWith('/usage-meter/backend.cjs') ? [path, ...args.slice(1)] : args, options)
    }, wrapper)
    await writeFile(pending, 'wait')
    const selected = await page.evaluate(async () => {
      const api = globalThis.gale
      await api.config.updateSettings({ language: 'zh-CN', theme: 'light' })
      const config = await api.config.saveModelProvider({ name: 'MiniMax CN', protocol: 'anthropic_messages', baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'fixture-key', parameters: {} })
      const providerId = config.providers.find(item => item.name === 'MiniMax CN').id
      const saved = await api.config.saveProviderModel({ providerId, displayName: 'MiniMax M2.7', model: 'MiniMax-M2.7', parameters: {}, parameterPresetMode: 'none', parameterPresets: [],
        capabilities: { vision: false, toolUse: true }, stream: true, maxContextTokens: 128000, maxOutputTokens: 4096, contextCompressionThreshold: .8, contextCompressionEnabled: false })
      const modelId = saved.providers.find(item => item.id === providerId).models[0].id
      await api.config.selectDefaultModel(modelId)
      const workspace = await api.agent.workspace.get()
      await api.agent.workspace.set({ ...workspace, mode: 'new_thread', modelConfigId: modelId, modelParameterPresetId: null })
      return { providerId, modelId }
    })
    await page.reload()
    await expect(page.locator('.plugin-widget')).toBeVisible()
    await expect(page.locator('.plugin-widget')).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.plugin-widget [role="status"]')).toContainText('加载中')
    await expect(page.locator('.plugin-widget-html')).toHaveCount(0)
    await page.screenshot({ path: join(output, 'loading-light.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'dark' }))
    await page.screenshot({ path: join(output, 'loading-dark.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'light' }))
    await rm(pending)
    await expect(page.locator('.plugin-widget')).toContainText('90%')
    await expect(page.locator('.plugin-widget')).toContainText('148.5%')
    await expect(page.locator('.plugin-widget progress')).toHaveCount(0)
    await expect(page.locator('.plugin-widget')).toContainText('5h 90% · 周 148.5%')
    await expect(page.locator('.plugin-widget [tabindex="0"]')).toHaveAttribute('data-tooltip', /重置时间/)
    await expect(page.locator('.plugin-widget [tabindex="0"]')).toHaveAttribute('data-tooltip', /更新于/)
    await page.locator('.plugin-widget [tabindex="0"]').hover()
    await expect(page.getByRole('tooltip')).toContainText('重置时间')
    await expect(page.getByRole('tooltip')).toContainText('更新于')
    await verifyQuotaTooltip(page)
    await page.screenshot({ path: join(output, 'compact-hover.png') })
    await page.getByRole('button', { name: '立即刷新', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveText('立即刷新')
    await page.mouse.move(400, 200)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    const compact = await page.locator('.plugin-widget').boundingBox()
    await page.screenshot({ path: join(output, 'compact-light.png') })
    const fullSummary = page.locator('.plugin-widget [data-full-text]')
    const shortSummary = page.locator('.plugin-widget [data-short-text]')
    await expect(fullSummary).toBeVisible()
    await expect(shortSummary).toBeHidden()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ sidebarWidth: 220, fontSize: 18 }))
    await expect(fullSummary).toBeHidden()
    await expect(shortSummary).toBeVisible()
    await expect(shortSummary).toHaveText('90% · 148.5%')
    assert.ok(await shortSummary.evaluate(el => el.scrollWidth <= el.clientWidth), 'Both percentages must fit without truncation')
    await expect(page.getByRole('button', { name: '立即刷新', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '展开用量详情', exact: true })).toBeVisible()
    await page.locator('.plugin-widget [tabindex="0"]').hover()
    await expect(page.getByRole('tooltip')).toContainText('5h 限额')
    await expect(page.getByRole('tooltip')).toContainText('周限额')
    await verifyQuotaTooltip(page)
    await page.screenshot({ path: join(output, 'compact-hover-large-font.png') })
    await page.mouse.move(400, 200)
    await page.screenshot({ path: join(output, 'compact-narrow.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ fontSize: 14 }))
    await expect(shortSummary).toBeVisible()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ fontSize: 18 }))
    await expect(shortSummary).toBeVisible()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ sidebarWidth: 320 }))
    await expect(fullSummary).toBeVisible()
    await expect(shortSummary).toBeHidden()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ sidebarWidth: 260, fontSize: 14 }))
    const setDisplayMode = async value => {
      await page.getByRole('button', { name: value === 'detailed' ? '展开用量详情' : '收起用量详情', exact: true }).click()
    }
    assert.equal((await page.evaluate(async () => (await globalThis.gale.plugins.list()).find(item => item.id === 'usage-meter').manifest.settings ?? [])).length, 0)
    await setDisplayMode('detailed')
    await expect(page.locator('.plugin-widget')).toContainText('5h 限额')
    await expect(page.locator('.plugin-widget')).toContainText('周限额')
    await expect(page.locator('.plugin-widget')).not.toContainText('总额度')
    await expect(page.locator('.plugin-widget')).not.toContainText('已用')
    await expect(page.locator('.plugin-widget progress').nth(1)).toHaveAttribute('value', '0.99')
    const minimaxDetails = page.locator('.plugin-widget').getByRole('button', { name: '详情', exact: true })
    await page.mouse.move(700, 200)
    await minimaxDetails.hover()
    await expect(page.getByRole('tooltip')).toContainText('总额度: 150%')
    await page.getByRole('tooltip').hover()
    await expect(page.getByRole('tooltip')).toContainText('套餐加成')
    await minimaxDetails.click()
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).toContainText('总额度: 150%')
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).toContainText('已用: 1.5%')
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).not.toContainText('重置时间')
    await page.screenshot({ path: join(output, 'minimax-details.png') })
    await page.keyboard.press('Escape')
    await expect(page.locator('.plugin-widget-html section > small')).toHaveCount(2)
    await expect(page.locator('.plugin-widget-html section > small').first()).toBeVisible()
    await expect(page.locator('.plugin-widget-html section > small').first()).toContainText('后重置')
    const widget = await page.locator('.plugin-widget').boundingBox()
    assert.ok(compact.height < widget.height / 2, 'Compact mode must use less than half the detailed height')
    await page.reload()
    await expect(page.locator('.plugin-widget progress')).toHaveCount(2)
    await page.evaluate(() => globalThis.gale.plugins.stopBackend('usage-meter'))
    await expect(page.locator('.plugin-widget')).toHaveCount(0)
    await page.evaluate(() => globalThis.gale.plugins.startBackend('usage-meter'))
    await expect(page.locator('.plugin-widget progress')).toHaveCount(2)
    const settings = await page.locator('.sidebar-settings').boundingBox()
    assert.ok(widget.y + widget.height <= settings.y + 1)
    await page.screenshot({ path: join(output, 'light.png') })
    const lightFont = await page.locator('.plugin-widget-html progress').first().evaluate(el => globalThis.getComputedStyle(el).fontSize)
    const lightColor = await page.locator('.plugin-widget-html').evaluate(el => globalThis.getComputedStyle(el).color)
    const initialCalls = (await readFile(calls, 'utf8')).trim().split('\n').length
    await page.getByRole('button', { name: '立即刷新', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: '立即刷新', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '立即刷新', exact: true })).toBeEnabled()
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, initialCalls + 1)
    await writeFile(mode, 'rate limited')
    await page.getByRole('button', { name: '立即刷新', exact: true }).click()
    await expect(page.locator('.plugin-widget')).toContainText('限流')
    await expect(page.locator('.plugin-widget')).toContainText('90%')
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'dark', fontSize: 18 }))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()).setSize(800, 680))
    await expect.poll(() => page.locator('.plugin-widget-html progress').first().evaluate(el => globalThis.getComputedStyle(el).fontSize)).not.toBe(lightFont)
    await expect.poll(() => page.locator('.plugin-widget-html').evaluate(el => globalThis.getComputedStyle(el).color)).not.toBe(lightColor)
    await page.screenshot({ path: join(output, 'dark-large-font.png') })
    await setDisplayMode('compact')
    await expect(page.locator('.plugin-widget progress')).toHaveCount(0)
    await expect(page.locator('.plugin-widget [role="status"]')).toHaveAttribute('data-tooltip', /限流/)
    await page.reload()
    await expect(page.locator('.plugin-widget')).toContainText('5h 90% · 周 148.5%')
    await expect(page.locator('.plugin-widget progress')).toHaveCount(0)
    const compactSize = await page.locator('.plugin-widget-html').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }))
    assert.ok(compactSize.content <= compactSize.width, 'Compact mode should fit at a larger font size')
    await page.screenshot({ path: join(output, 'compact-dark-large-font.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
    await page.locator('.plugin-widget [tabindex="0"]').hover()
    await expect(page.getByRole('tooltip')).toContainText('Weekly limit')
    await verifyQuotaTooltip(page)
    await page.screenshot({ path: join(output, 'compact-hover-en-dark.png') })
    await page.mouse.move(400, 200)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'zh-CN' }))
    await setDisplayMode('detailed')
    await expect(page.locator('.plugin-widget progress')).toHaveCount(2)
    const bodyColor = await page.locator('body').evaluate(el => globalThis.getComputedStyle(el).color)
    await writeFile(layout, '<div class="ui-stack"><details open><summary>套餐详情</summary><table><tr><th>到期</th><td>2026-12-31</td></tr></table></details><button data-action="refresh">立即刷新</button></div>')
    await page.getByRole('button', { name: '立即刷新', exact: true }).click()
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByRole('cell', { name: '2026-12-31' })).toBeVisible()
    const control = await page.getByRole('button', { name: '立即刷新', exact: true }).boundingBox()
    const settingsControl = await page.locator('.sidebar-settings').boundingBox()
    assert.equal(control.height, settingsControl.height)
    await page.screenshot({ path: join(output, 'html-table.png') })
    await writeFile(layout, '<style>body{color:red}</style><p>Invalid stylesheet</p>')
    await page.getByRole('button', { name: '立即刷新', exact: true }).click()
    await expect(page.locator('.plugin-widget-error')).toContainText('HTML')
    await expect(page.getByRole('table')).toBeVisible()
    assert.equal(await page.locator('body').evaluate(el => globalThis.getComputedStyle(el).color), bodyColor)
    await rm(layout)
    await page.getByRole('button', { name: '立即刷新', exact: true }).click()
    await expect(page.getByRole('table')).toHaveCount(0)
    await page.evaluate(() => globalThis.gale.plugins.stopBackend('usage-meter'))
    await expect(page.locator('.plugin-widget')).toHaveCount(0)
    assert.equal(await page.evaluate(modelId => globalThis.gale.plugins.readWidget('usage-meter', 'quota', modelId), selected.modelId), null)
    await page.evaluate(() => globalThis.gale.plugins.startBackend('usage-meter'))
    await expect(page.locator('.plugin-widget')).toBeVisible()
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, join(output, 'backup.zip'))
    const backup = await page.evaluate(() => globalThis.gale.app.backupData())
    assert.equal(backup.path, join(output, 'backup.zip'))
    await expect(page.locator('.plugin-widget')).toHaveCount(0)
    assert.equal(await page.evaluate(modelId => globalThis.gale.plugins.readWidget('usage-meter', 'quota', modelId), selected.modelId), null)
    await page.evaluate(() => globalThis.gale.plugins.startBackend('usage-meter'))
    await expect(page.locator('.plugin-widget')).toBeVisible()
    await page.evaluate(() => globalThis.gale.plugins.setEnabled('usage-meter', false))
    await expect(page.locator('.plugin-widget')).toHaveCount(0)
    await page.reload()
    assert.equal(await page.evaluate(async () => (await globalThis.gale.plugins.list()).find(item => item.id === 'usage-meter').enabled), false)
    await page.evaluate(async ({ providerId }) => {
      const api = globalThis.gale
      await api.config.saveModelProvider({ id: providerId, name: 'MiniMax CN', protocol: 'anthropic_messages', baseUrl: 'https://other.example/v1', apiKey: 'fixture-key', parameters: {} })
      await api.plugins.setEnabled('usage-meter', true)
    }, selected)
    await page.reload()
    await page.locator('[data-agent-composer-input]').waitFor()
    await expect(page.locator('.plugin-widget')).toHaveCount(0)
    assert.equal(await page.evaluate(modelId => globalThis.gale.plugins.readWidget('usage-meter', 'quota', modelId), selected.modelId), null)
    await page.evaluate(async ({ providerId }) => {
      await globalThis.gale.config.saveModelProvider({ id: providerId, name: 'DeepSeek', protocol: 'anthropic_messages', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'fixture-key', parameters: {} })
    }, selected)
    await page.reload()
    await expect(page.locator('.plugin-widget')).toContainText('CNY 可用余额')
    await expect(page.locator('.plugin-widget')).toContainText('110.00001')
    await expect(page.locator('.plugin-widget')).not.toContainText('赠金余额')
    await page.locator('.plugin-widget').getByRole('button', { name: '详情', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).toContainText('赠金余额: 10.00')
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).not.toContainText('可用余额')
    await page.screenshot({ path: join(output, 'deepseek-details.png') })
    await page.keyboard.press('Escape')
    await expect(page.locator('.plugin-widget progress')).toHaveCount(0)
    await page.screenshot({ path: join(output, 'deepseek-detailed.png') })
    await setDisplayMode('compact')
    await expect(page.locator('.plugin-widget')).toContainText('CNY 110.00001')
    await page.locator('.plugin-widget [tabindex="0"]').hover()
    await expect(page.getByRole('tooltip')).toContainText('充值余额: 100.00001')
    await page.screenshot({ path: join(output, 'deepseek-compact.png') })
    for (const [name, baseUrl, summary, detail] of [
      ['Moonshot', 'https://api.moonshot.cn/v1', 'CNY 49.58894', '代金券余额'],
      ['Moonshot', 'https://api.moonshot.ai/v1', 'USD 49.58894', '现金余额'],
      ['OpenRouter', 'https://openrouter.ai/api/v1', '密钥 USD 74.5', '今日消费（UTC）']
    ]) {
      await page.evaluate(async ({ providerId, name, baseUrl }) => {
        await globalThis.gale.config.saveModelProvider({ id: providerId, name, protocol: 'openai_chat_completions', baseUrl, apiKey: 'fixture-key', parameters: {} })
      }, { ...selected, name, baseUrl })
      await page.reload()
      await expect(page.locator('.plugin-widget')).toContainText(summary)
      await setDisplayMode('detailed')
      await expect(page.locator('.plugin-widget')).not.toContainText(detail)
      await page.locator('.plugin-widget').getByRole('button', { name: '详情', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '详情', exact: true })).toContainText(detail)
      await page.keyboard.press('Escape')
      await expect(page.locator('.plugin-widget progress')).toHaveCount(0)
      await page.screenshot({ path: join(output, `${name.toLowerCase()}-detailed.png`) })
      await setDisplayMode('compact')
    }
    for (const [name, host, language] of [['GLM', 'open.bigmodel.cn', 'zh-CN'], ['Z.ai', 'api.z.ai', 'en']]) {
      await page.evaluate(async ({ providerId, name, host, language }) => {
        await globalThis.gale.config.updateSettings({ language })
        await globalThis.gale.config.saveModelProvider({ id: providerId, name, protocol: 'openai_chat_completions', baseUrl: `https://${host}/api/coding/paas/v4`, apiKey: 'fixture-key', parameters: {} })
      }, { ...selected, name, host, language })
      await page.reload()
      await expect(page.locator('.plugin-widget')).toContainText(language === 'en' ? '5h 75% · 1w 85%' : '5h 75% · 周 85%')
      await page.locator('.plugin-widget [data-action="show_detailed"]').click()
      await expect(page.locator('.plugin-widget progress')).toHaveCount(2)
      await expect(page.locator('.plugin-widget')).toContainText(language === 'en' ? 'Weekly quota remaining' : '每周额度剩余')
      await expect(page.locator('.plugin-widget')).toContainText(language === 'en' ? 'Resets in' : '后重置')
      await page.locator('.plugin-widget').getByRole('button', { name: language === 'en' ? 'Details' : '详情', exact: true }).click()
      await expect(page.getByRole('dialog')).toContainText(language === 'en' ? 'Resets:' : '重置时间:')
      await page.keyboard.press('Escape')
      await page.screenshot({ path: join(output, `glm-${language}.png`) })
      await page.locator('.plugin-widget [data-action="show_compact"]').click()
      await page.evaluate(async ({ providerId, name, host }) => {
        await globalThis.gale.config.saveModelProvider({ id: providerId, name, protocol: 'openai_chat_completions', baseUrl: `https://${host}/api/paas/v4`, apiKey: 'fixture-key', parameters: {} })
      }, { ...selected, name, host })
      await page.reload()
      await page.locator('[data-agent-composer-input]').waitFor()
      if (host === 'open.bigmodel.cn') {
        await expect(page.locator('.plugin-widget')).toContainText('CNY 0.123456789')
        await expect(page.locator('.plugin-widget')).not.toContainText('75%')
        await page.screenshot({ path: join(output, 'glm-balance-compact.png') })
        await setDisplayMode('detailed')
        await expect(page.locator('.plugin-widget')).toContainText('GLM 余额')
        await expect(page.locator('.plugin-widget')).not.toContainText('累计消费')
        await page.locator('.plugin-widget').getByRole('button', { name: '详情', exact: true }).click()
        await expect(page.getByRole('dialog', { name: '详情', exact: true })).toContainText('累计消费: CNY 18.5')
        await page.keyboard.press('Escape')
        await expect(page.locator('.plugin-widget progress')).toHaveCount(0)
        await page.screenshot({ path: join(output, 'glm-balance-zh-CN.png') })
        await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
        await expect(page.locator('.plugin-widget')).toContainText('GLM Balance')
        await page.locator('.plugin-widget').getByRole('button', { name: 'Details', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Details', exact: true })).toContainText('All-time spend: CNY 18.5')
        await page.keyboard.press('Escape')
        await page.screenshot({ path: join(output, 'glm-balance-en.png') })
        await page.locator('.plugin-widget [data-action="show_compact"]').click()
      } else await expect(page.locator('.plugin-widget')).toHaveCount(0)
    }
    await page.evaluate(async ({ providerId }) => {
      await globalThis.gale.config.updateSettings({ language: 'zh-CN' })
      await globalThis.gale.config.saveModelProvider({ id: providerId, name: 'GLM', protocol: 'openai_chat_completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKey: 'no-plan-key', parameters: {} })
    }, selected)
    await page.reload()
    await page.locator('.plugin-widget [data-action="show_detailed"]').click()
    await expect(page.locator('.plugin-widget')).toContainText('当前账户未开通 GLM Coding Plan。')
    await expect(page.locator('.plugin-widget progress')).toHaveCount(0)
    await page.screenshot({ path: join(output, 'glm-no-plan.png') })
    await setDisplayMode('compact')
    await writeFile(pending, 'wait')
    await page.evaluate(async ({ providerId }) => {
      await globalThis.gale.config.saveModelProvider({ id: providerId, name: 'Qwen', protocol: 'openai_chat_completions', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-sp-123456789-middle-secret-987654321abcdef', parameters: {} })
    }, selected)
    await page.reload()
    await expect(page.locator('.plugin-widget [role="status"]')).toContainText('加载中')
    await expect(page.locator('.plugin-widget-html')).toHaveCount(0)
    await page.screenshot({ path: join(output, 'bailian-loading.png') })
    await rm(pending)
    await expect(page.locator('.plugin-widget')).toContainText('月 35.05%')
    await expect(page.locator('.plugin-widget [tabindex="0"]')).toHaveAttribute('data-tooltip', /自动续费: 关闭/)
    await setDisplayMode('detailed')
    await expect(page.locator('.plugin-widget')).not.toContainText('套餐: lite')
    await expect(page.locator('.plugin-widget')).not.toContainText('Fixture account')
    await expect(page.locator('.plugin-widget')).not.toContainText('套餐到期')
    const planDetails = page.locator('.plugin-widget').getByRole('button', { name: '详情', exact: true })
    await expect(planDetails.locator('img')).toBeVisible()
    const footer = page.locator('.plugin-widget footer')
    const footerBox = await footer.boundingBox(), iconBox = await planDetails.boundingBox(), timeBox = await footer.locator('time').boundingBox()
    assert.ok(iconBox.x > timeBox.x + timeBox.width && Math.abs(iconBox.x + iconBox.width - footerBox.x - footerBox.width) < 2, 'Details icon must align to the update row right edge')
    assert.ok(iconBox.y <= timeBox.y + timeBox.height && iconBox.y + iconBox.height >= timeBox.y, 'Time and details must share one row')
    await page.mouse.move(700, 200)
    await planDetails.hover()
    await expect(page.getByRole('tooltip')).toContainText('自动续费: 关闭')
    await planDetails.click()
    await page.mouse.move(700, 200)
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).toContainText('套餐到期')
    await planDetails.click()
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).toHaveCount(0)
    await planDetails.click()
    const detailsDialog = page.getByRole('dialog', { name: '详情', exact: true })
    await expect(detailsDialog).toContainText('套餐: lite')
    await expect(detailsDialog).toContainText('Fixture account')
    assert.equal(await detailsDialog.evaluate(el => globalThis.getComputedStyle(el).userSelect), 'text')
    await page.screenshot({ path: join(output, 'bailian-plan-details.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).toHaveCount(0)
    await expect(planDetails).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).toBeVisible()
    await page.locator('[data-agent-composer-input]').click()
    await expect(page.getByRole('dialog', { name: '详情', exact: true })).toHaveCount(0)
    await page.screenshot({ path: join(output, 'bailian-plan.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en', theme: 'light', fontSize: 14 }))
    await expect(page.locator('.plugin-widget')).not.toContainText('Plan: lite')
    await page.locator('.plugin-widget').getByRole('button', { name: 'Details', exact: true }).click()
    const englishDetails = page.getByRole('dialog', { name: 'Details', exact: true })
    await expect(englishDetails).toContainText('Auto-renew: Off')
    await expect(englishDetails).toContainText('Plan: lite')
    await page.screenshot({ path: join(output, 'bailian-plan-details-en-light.png') })
    await page.keyboard.press('Escape')
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'zh-CN', theme: 'dark', fontSize: 18 }))
    await writeFile(bailianMode, 'mismatch')
    await page.locator('.plugin-widget [data-action="refresh"]').click()
    await expect(page.locator('.plugin-widget')).toContainText('不匹配')
    await expect(page.locator('.plugin-widget progress')).toHaveCount(0)
    await page.getByRole('button', { name: '切换账户登录', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消登录', exact: true })).toBeVisible()
    await expect(page.locator('.plugin-widget')).toContainText('等待浏览器登录')
    await page.screenshot({ path: join(output, 'bailian-login.png') })
    await writeFile(bailianMode, 'ok')
    await writeFile(loginDone, 'done')
    await expect(async () => {
      await page.locator('.plugin-widget [data-action="refresh"]').click()
      await expect(page.locator('.plugin-widget')).toContainText('35.05%')
    }).toPass()
    await page.evaluate(async ({ providerId }) => {
      await globalThis.gale.config.saveModelProvider({ id: providerId, name: 'Qwen', protocol: 'openai_chat_completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-ordinary-secret-ending', parameters: {} })
    }, selected)
    await page.reload()
    await expect(page.locator('.plugin-widget')).toContainText('当前模型免费额度')
    await expect(page.locator('.plugin-widget')).toContainText('5,000')
    await expect(page.locator('.plugin-widget')).toContainText('近 7 天在线调用')
    await expect(page.locator('.plugin-widget')).not.toContainText('input_tokens')
    await page.locator('.plugin-widget').getByRole('button', { name: '详情', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('input_tokens: 2,000 tokens')
    await expect(page.getByRole('dialog')).toContainText('Fixture workspace')
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(output, 'bailian-ordinary.png') })
    await writeFile(bailianMode, 'logged-out')
    await page.locator('.plugin-widget [data-action="refresh"]').click()
    await expect(page.getByRole('button', { name: '登录百炼', exact: true })).toBeVisible()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
    await expect(page.getByRole('button', { name: 'Sign in to Bailian', exact: true })).toBeVisible()
    await page.screenshot({ path: join(output, 'bailian-login-en.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'zh-CN' }))
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
    await page.locator('[data-settings-tab="plugins"]').click()
    await page.getByRole('button', { name: '用量仪表', exact: true }).click()
    await expect(page.getByText('已支持厂商：', { exact: true })).toBeVisible()
    await expect(page.getByText(/^• DeepSeek：可用余额/)).toBeVisible()
    await expect(page.getByText(/^• OpenRouter：当前 API Key/)).toBeVisible()
    await expect(page.getByText(/^• 智谱 \/ Z.ai：Coding Plan/)).toBeVisible()
    await expect(page.getByText(/^• 百炼 \/ Qwen/)).toBeVisible()
    await page.screenshot({ path: join(output, 'providers-zh.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
    await expect(page.getByText('Supported providers:', { exact: true })).toBeVisible()
    await expect(page.getByText(/^• DeepSeek: Available/)).toBeVisible()
    await expect(page.getByText(/^• Moonshot \/ Kimi: Available/)).toBeVisible()
    await expect(page.getByText(/^• GLM \/ Z.ai: Coding Plan/)).toBeVisible()
    await expect(page.getByText(/^• Bailian \/ Qwen/)).toBeVisible()
    await page.screenshot({ path: join(output, 'providers-en.png') })
    assert.deepEqual(errors, [])
    console.log('Plugin widget Electron checks passed.')
  } finally {
    await closeElectronTestApplication(app)
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyPluginWidgets }
