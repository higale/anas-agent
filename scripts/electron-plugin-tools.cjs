const { openCapabilityProject } = require('./electron-capabilities.cjs')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, rm, writeFile, readFile, cp, appendFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const { pluginPage } = require('./electron-plugin-helpers.cjs')

async function verifyPluginTools(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-plugin-tools-'))
  const archiveRoot = await mkdtemp(join(tmpdir(), 'anas-plugin-backup-'))
  const requests = [], errors = []
  let application, mode = 'echo'
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      requests.push(input)
      const last = input.messages.at(-1)
      const toolName = input.tools.find(tool => tool.function.name === `plugin__example-text-tools__${mode}`)?.function.name
      if (mode === 'instructions') {
        const system = JSON.stringify(input.messages.filter(message => ['system', 'developer'].includes(message.role)))
        assert.ok(system.includes('writing-helper:prompt:writing-tone') && system.includes('preserve the author'))
        assert.ok(system.replace(/\\+/g, '/').includes('proofread/SKILL.md'), 'Plugin skills must join the ordinary skill catalog.')
      } else assert.ok(toolName, 'The selected plugin declaration must reach the model.')
      const calls = mode === 'instructions' || last.role === 'tool' || (Array.isArray(last.content) && last.content.some(block => block.type === 'image_url')) ? undefined : [{ id: `plugin-${requests.length}`, type: 'function',
        function: { name: toolName, arguments: JSON.stringify(mode === 'wait' ? { seconds: 60 } : mode === 'image' ? {} : { text: 'PLUGIN_ECHO_RESULT' }) } }]
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `request-${requests.length}`, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: calls ? null : 'PLUGIN_TOOL_FINISHED', ...(calls ? { tool_calls: calls } : {}) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }))
    })().catch(error => { errors.push(String(error)); response.writeHead(500); response.end() })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const fixture = join(home, 'fixture'), callsFile = join(home, 'calls.jsonl')
    await cp(resolve(__dirname, '../examples/plugins/text-tools'), fixture, { recursive: true })
    await appendFile(join(fixture, 'backend.cjs'), `
let calls = 0;
module.exports.activate = async ({ host }) => { await host.getViews(); };
for (const [name, handler] of Object.entries(module.exports.tools)) {
  module.exports.tools[name] = async (params, context) => {
    const index = ++calls;
    try { return await handler(params, context); }
    finally {
      require('node:fs').appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ index, name,
        contextKeys: Object.keys(context).sort(), cancelled: context.signal.aborted }) + '\\n');
    }
  };
}
`)
    application = await launchApplication(home)
    application.process().stderr.on('data', chunk => { void writeFile(join(tmpdir(), 'anas-plugin-tools-startup.log'), chunk, { flag: 'a' }) })
    const page = await application.firstWindow()
    page.setDefaultTimeout(45_000)
    page.on('pageerror', error => errors.push(String(error)))
    await page.locator('[data-agent-composer-input]').waitFor()
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, join(fixture, 'PLUGIN.json'))
    await page.evaluate(async port => {
      const api = globalThis.gale
      await api.config.updateSettings({ language: 'en', theme: 'dark' })
      await api.plugins.install()
      const saved = await api.config.saveModelProvider({ name: 'Plugin test', protocol: 'openai_chat_completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListAuth: 'bearer' })
      const providerId = saved.providers.find(provider => provider.name === 'Plugin test').id
      const configured = await api.config.saveProviderModel({ providerId, displayName: 'Plugin test', model: 'plugin-test', parameters: {}, parameterPresetMode: 'none', parameterPresets: [],
        capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 1000,
        contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
      await api.config.selectDefaultModel(configured.providers.find(provider => provider.id === providerId).models[0].id)
      const base = (await api.projects.list()).find(project => project.id === 'default-workspace')
      const project = await api.projects.create({ ...base, name: 'Plugin capability fixture', advancedSettings: true,
        capabilities: { ...base.capabilities, toolMode: 'selected', tools: [], planning: false, environment: false, profile: false, workspace: false, memory: false,
          skills: { mode: 'off', project: false, entries: [] }, subagents: { mode: 'off', names: [] }, mcp: { defaultMode: 'selected', servers: [] },
          backgroundTools: false, pluginTools: [] } })
      if (project.status !== 'ok') throw new Error(JSON.stringify(project))
      await api.agent.workspace.set({ mode: 'new_thread', projectId: project.value.id, modelParameterPresetId: null })
    }, server.address().port)
    await page.reload()
    await page.locator('[data-agent-composer-input]').waitFor()
    await expect(page.getByRole('button', { name: 'Plugins', exact: true })).toHaveCount(0)
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.locator('[data-settings-tab="tools"]').click()
    await page.getByRole('button', { name: /^Plugins\s*3$/ }).click()
    await expect(page.getByRole('region', { name: 'Text tools', exact: true })).toBeVisible()
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-tools-catalog.png') })
    await page.getByRole('button', { name: /^plugin__example-text-tools__echo:/ }).click()
    const definition = page.getByRole('dialog')
    const modelDefinition = JSON.parse(await definition.locator('pre').textContent())
    assert.equal(modelDefinition.name, 'plugin__example-text-tools__echo')
    assert.deepEqual(modelDefinition.parameters, JSON.parse(await readFile(join(fixture, 'PLUGIN.json'), 'utf8')).tools[0].input_schema)
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-tool-definition.png') })
    await definition.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'stopped', 'Browsing the catalog must not start plugin code.')
    assert.deepEqual(await page.evaluate(async () => (await globalThis.gale.projects.list()).find(project => project.name === 'Plugin capability fixture').capabilities.pluginTools), [], 'Browsing definitions must not enable tools.')
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    const capabilityDialog = await openCapabilityProject(page, 'Plugin capability fixture')
    const pluginSection = capabilityDialog.getByRole('region', { name: 'Text tools', exact: true })
    await pluginSection.getByRole('radiogroup').getByText('Custom', { exact: true }).click()
    await pluginSection.getByRole('button', { name: 'Text tools', exact: true }).click()
    const echo = page.getByRole('checkbox', { name: 'plugin__example-text-tools__echo', exact: true })
    await expect(echo).not.toBeChecked()
    const displayedEchoName = await echo.getAttribute('aria-label')
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'stopped')
    await echo.check()
    await page.getByRole('checkbox', { name: 'plugin__example-text-tools__wait', exact: true }).check()
    await page.getByRole('checkbox', { name: 'plugin__example-text-tools__image', exact: true }).check()
    await echo.scrollIntoViewIfNeeded()
    const headingBounds = await pluginSection.locator('fieldset strong').first().boundingBox()
    const checkboxBounds = await echo.boundingBox()
    assert.ok(headingBounds && checkboxBounds && Math.abs(headingBounds.x - checkboxBounds.x) < 1, 'Plugin tools must align with their section heading, inside the list padding.')
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-tools-capabilities.png') })
    await capabilityDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.locator('[data-settings-tab="plugins"]').click()
    await expect(page.getByRole('radio', { name: 'Capabilities', exact: true })).toHaveCount(0)
    await expect(page.getByRole('checkbox', { name: 'plugin__example-text-tools__echo', exact: true })).toHaveCount(0)
    await page.getByRole('radiogroup', { name: 'Plugin details' }).getByText('Settings', { exact: true }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const form = page.getByRole('dialog')
    await form.getByRole('textbox', { name: 'Prefix / 前缀', exact: true }).fill('Configured: ')
    await form.getByRole('checkbox', { name: 'Uppercase / 大写', exact: true }).check()
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-settings.png') })
    const originalBounds = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0], bounds = window.getBounds()
      window.setSize(800, 650)
      return bounds
    })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'light', fontSize: 22 }))
    await expect(form.getByRole('textbox', { name: 'Prefix / 前缀', exact: true })).toHaveValue('Configured: ')
    await expect.poll(() => form.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= globalThis.innerWidth && bounds.top >= 0 && bounds.bottom <= globalThis.innerHeight
    })).toBe(true)
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-settings-light-large.png') })
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(form).toHaveCount(0)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'dark', fontSize: 14 }))
    await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), originalBounds)
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.invoke('example-text-tools', 'settings.get'))).values.prefix, 'Configured: ')
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'stopped', 'Settings must not start plugin code.')
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.locator('[data-agent-composer-input]').fill('Echo the supplied test text.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('PLUGIN_TOOL_FINISHED', { exact: true })).toBeVisible()
    assert.ok(requests.some(input => input.tools.some(tool => tool.function.name === displayedEchoName)), 'The capability label must equal the model tool name.')
    assert.ok(requests.some(input => input.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('Configured: PLUGIN_ECHO_RESULT'))))
    assert.equal(await page.locator('iframe').count(), 0, 'Tools must run without plugin pages.')
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'running')
    mode = 'image'
    await page.locator('[data-agent-composer-input]').fill('Return the test image.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('PLUGIN_TOOL_FINISHED', { exact: true })).toHaveCount(2)
    assert.ok(requests.some(input => input.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url' && block.image_url.url.startsWith('data:image/png;base64,')))), 'A native image block must reach the model.')
    const persisted = await page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      return globalThis.gale.agent.threads.get(thread.id)
    })
    assert.ok(JSON.stringify(persisted).includes('iVBORw0KGgo'), 'The normal thread history must retain the image.')
    mode = 'wait'
    const before = requests.length
    await page.locator('[data-agent-composer-input]').fill('Wait until I cancel.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => requests.length).toBeGreaterThan(before)
    await expect.poll(() => page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      const snapshot = await globalThis.gale.agent.threads.get(thread.id)
      return snapshot.activities.some(activity => activity.tools.some(tool => tool.status === 'running' && tool.call.name === 'plugin__example-text-tools__wait'))
    }), { timeout: 15000 }).toBe(true)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'running', 'Cooperative cancellation must retain the backend.')
    const completedCalls = async () => (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    await expect.poll(async () => (await completedCalls()).length).toBe(3)
    const completed = await completedCalls()
    assert.deepEqual(completed.map(item => item.index), [1, 2, 3], 'Independent turns must share the same plugin backend state.')
    assert.deepEqual(completed.map(item => item.cancelled), [false, false, true])
    assert.ok(completed.every(item => JSON.stringify(item.contextKeys) === JSON.stringify(['deadline', 'host', 'signal'])), 'Tools must receive per-call services without conversation identity.')
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, resolve(__dirname, '../examples/plugins/writing-helper/PLUGIN.json'))
    await page.evaluate(() => globalThis.gale.plugins.install())
    await expect(page.getByRole('button', { name: 'Plugins', exact: true })).toHaveCount(0)
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    const writingDialog = await openCapabilityProject(page, 'Plugin capability fixture')
    const writingSection = writingDialog.getByRole('region', { name: 'Writing helper', exact: true })
    await writingSection.getByRole('radiogroup').getByText('Custom', { exact: true }).click()
    await writingSection.getByRole('button', { name: 'Writing helper', exact: true }).click()
    const prompt = page.getByRole('checkbox', { name: 'writing-tone', exact: true })
    await expect(prompt).not.toBeChecked()
    await prompt.check()
    await page.getByRole('checkbox', { name: 'proofread Model', exact: true }).locator('..').click()
    await page.getByRole('checkbox', { name: 'proofread Shortcut', exact: true }).locator('..').click()
    const skillHeading = await writingSection.locator('fieldset strong').first().boundingBox()
    const skillRow = await writingSection.locator('.ui-capability-skill').boundingBox()
    assert.ok(skillHeading && skillRow && skillRow.y - skillHeading.y - skillHeading.height < skillRow.height / 2, 'Skill headings must stay close to their rows.')
    await writingSection.screenshot({ path: join(tmpdir(), 'anas-plugin-grouped-capabilities.png') })
    await writingDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.locator('[data-settings-tab="skills"]').click()
    await expect(page.getByRole('button', { name: /^Writing helper/ })).toBeVisible()
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-static-skills.png') })
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.evaluate(async () => {
      const projects = await globalThis.gale.projects.list()
      const projectId = projects.find(project => project.name === 'Plugin capability fixture').id
      const invoked = await globalThis.gale.skills.invoke(projectId, 'proofread', 'plugin:writing-helper', 'Check this prose.')
      if (!invoked.promptText.includes('preserving') && !invoked.promptText.includes('Read the supplied text')) throw new Error('Plugin skill was not invoked.')
    })
    mode = 'instructions'
    await page.locator('[data-agent-composer-input]').fill('Check this prose using the selected static instructions.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('PLUGIN_TOOL_FINISHED', { exact: true })).toHaveCount(3, { timeout: 35000 })
    assert.equal(await page.locator('iframe').count(), 0)
    const staticPlugin = (await page.evaluate(() => globalThis.gale.plugins.list())).find(plugin => plugin.id === 'writing-helper')
    assert.equal(staticPlugin.backendStatus, 'stopped')
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, resolve(__dirname, '../examples/plugins/notepad/PLUGIN.json'))
    await page.evaluate(() => globalThis.gale.plugins.install())
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect(page.getByRole('menuitem')).toHaveText(['Notepad'])
    await page.getByRole('menuitem', { name: 'Notepad', exact: true }).click()
    const notepad = await pluginPage(application, 'example-notepad')
    await expect(notepad.locator('#draft')).toBeEnabled()
    await page.evaluate(() => globalThis.gale.plugins.uninstall('example-notepad', true))
    await expect(page.getByRole('button', { name: 'Plugins', exact: true })).toHaveCount(0)
    await page.evaluate(() => globalThis.gale.plugins.setEnabled('writing-helper', false))
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.skills.get()).skills.some(skill => skill.id === 'writing-helper:skill:proofread'))).toBe(false)
    const archivePath = join(archiveRoot, 'plugin-history.zip')
    await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, archivePath)
    const backup = await page.evaluate(() => globalThis.gale.app.backupData())
    assert.equal(backup.path, archivePath)
    await page.evaluate(() => globalThis.gale.plugins.uninstall('example-text-tools', true))
    assert.ok(JSON.stringify(await page.evaluate(id => globalThis.gale.agent.threads.get(id), persisted.thread.id)).includes('iVBORw0KGgo'), 'Uninstalling a plugin must not remove its ordinary history images.')
    await closeElectronTestApplication(application)
    application = await launchApplication(home)
    const restarted = await application.firstWindow()
    await restarted.locator('[data-agent-composer-input]').waitFor()
    assert.ok(JSON.stringify(await restarted.evaluate(id => globalThis.gale.agent.threads.get(id), persisted.thread.id)).includes('iVBORw0KGgo'), 'Images must survive process restart with their plugin uninstalled.')
    await expect.poll(async () => {
      try {
        await restarted.evaluate(id => globalThis.gale.agent.threads.delete(id), persisted.thread.id)
        return true
      } catch (error) {
        if (String(error).includes('conversation operation is in progress')) return false
        throw error
      }
    }, { timeout: 10000 }).toBe(true)
    assert.equal((await restarted.evaluate(() => globalThis.gale.agent.threads.list())).some(thread => thread.id === persisted.thread.id), false)
    await restarted.evaluate(path => globalThis.gale.app.restoreData(path), archivePath)
    assert.ok(JSON.stringify(await restarted.evaluate(id => globalThis.gale.agent.threads.get(id), persisted.thread.id)).includes('iVBORw0KGgo'), 'Restore must recover ordinary image history.')
    assert.equal((await restarted.evaluate(() => globalThis.gale.plugins.invoke('example-text-tools', 'settings.get'))).values.prefix, 'Configured: ')
    assert.equal((await restarted.evaluate(() => globalThis.gale.plugins.list())).find(plugin => plugin.id === 'example-text-tools').backendStatus, 'stopped')
    assert.deepEqual(errors, [])
    console.log('Plugin backup E2E passed: image history after uninstall/restart and recovery of deleted conversation, package and settings.')
    console.log('Plugin tools E2E passed: ordinary tool results/history, per-call cancellation, persistent backend state without conversation identity, static contributions, shared capability selection and current settings without a page; dark/light settings and large-font layout.')
  } catch (error) {
    const page = application && (await application.windows())[0]
    if (page) {
      await page.screenshot({ path: join(tmpdir(), 'anas-plugin-tools-failure.png') }).catch(() => {})
      await writeFile(join(tmpdir(), 'anas-plugin-tools-failure.txt'), await page.locator('body').innerText().catch(() => 'No document'))
    }
    if (errors.length) console.error('Local plugin test endpoint:', errors)
    throw error
  } finally {
    await closeElectronTestApplication(application)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
    await rm(archiveRoot, { recursive: true, force: true })
  }
}
module.exports = { verifyPluginTools }
