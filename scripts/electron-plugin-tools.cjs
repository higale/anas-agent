const { openCapabilityProject } = require('./electron-capabilities.cjs')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, rm, writeFile, readFile, cp, appendFile, realpath } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const { pluginPage, observeStableControls, expectWarningColor } = require('./electron-plugin-helpers.cjs')

async function readHistoryImages(page, threadId) {
  return page.evaluate(async threadId => {
    const api = globalThis.gale.agent
    const thread = threadId ? { id: threadId } : (await api.threads.list())[0]
    const snapshot = await api.threads.get(thread.id)
    const tools = await Promise.all(snapshot.activities.map(async activity => {
      const input = { threadId: thread.id, runId: activity.runId, requestId: crypto.randomUUID() }
      const directory = await api.activities.directory(input)
      const groups = await Promise.all(directory.items.filter(item => item.type === 'process').map(group =>
        api.activities.directory({ ...input, parentId: group.key, requestId: crypto.randomUUID() })))
      return [...directory.items, ...groups.flatMap(group => group.items)]
        .flatMap(item => item.type === 'entry' && item.item.type === 'tool' && item.item.tool.call.name === 'plugin__example-text-tools__image' ? [item.item.tool] : [])
    }))
    const images = await Promise.all(tools.flat().map(tool => api.activities.detail({ ...tool.detail, field: 'output' })))
    return { thread, images }
  }, threadId)
}

async function verifyPluginTools(launchApplication) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'anas-plugin-tools-')))
  const archiveRoot = await realpath(await mkdtemp(join(tmpdir(), 'anas-plugin-backup-')))
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
    const fixture = join(home, 'fixture'), callsFile = join(home, 'calls.jsonl'), startedCallsFile = join(home, 'started-calls.jsonl')
    await cp(resolve(__dirname, '../data/examples/plugins/text-tools'), fixture, { recursive: true })
    const fixtureManifest = JSON.parse(await readFile(join(fixture, 'PLUGIN.json'), 'utf8'))
    fixtureManifest.skills = [{ id: 'echo-guide', path: 'skills/echo-guide/SKILL.md', tools: ['echo'] }]
    fixtureManifest.prompts = [{ id: 'echo-hint', path: 'echo-hint.md', description: 'Echo dependency fixture.', tools: ['echo'] }]
    await mkdir(join(fixture, 'skills/echo-guide'), { recursive: true })
    await writeFile(join(fixture, 'skills/echo-guide/SKILL.md'), '---\nname: echo-guide\ndescription: Echo dependency fixture.\n---\nUse the echo tool.\n')
    await writeFile(join(fixture, 'echo-hint.md'), 'ECHO_DEPENDENCY_HINT')
    await writeFile(join(fixture, 'PLUGIN.json'), JSON.stringify(fixtureManifest))
    await appendFile(join(fixture, 'backend.cjs'), `
let calls = 0;
module.exports.activate = async ({ host }) => { await host.getViews(); };
for (const [name, handler] of Object.entries(module.exports.tools)) {
  module.exports.tools[name] = async (params, context) => {
    const index = ++calls;
    require('node:fs').appendFileSync(${JSON.stringify(startedCallsFile)}, JSON.stringify({ index, name }) + '\\n');
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
      const saved = await api.config.saveModelProvider({ name: 'Plugin test', protocol: 'openai_chat_completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {} })
      const providerId = saved.providers.find(provider => provider.name === 'Plugin test').id
      const configured = await api.config.saveProviderModel({ providerId, displayName: 'Plugin test', model: 'plugin-test', parameters: {}, parameterPresetMode: 'none', parameterPresets: [],
        capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 1000,
        contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
      await api.config.selectDefaultModel(configured.providers.find(provider => provider.id === providerId).models[0].id)
      const base = (await api.projects.list()).find(project => project.id === 'default-workspace')
      const project = await api.projects.create({ ...base, name: 'Plugin capability fixture', capabilities: { ...base.capabilities, toolMode: 'selected', tools: [], planning: false, environment: false, profile: false, workspace: false, memory: false,
          skills: { mode: 'off', project: false, entries: [] }, subagents: { mode: 'off', names: [] }, mcp: { defaultMode: 'selected', servers: [] },
          backgroundTools: false, pluginMode: 'off', plugins: [{ id: 'example-text-tools', mode: 'all' }], pluginTools: [] } })
      if (project.status !== 'ok') throw new Error(JSON.stringify(project))
      await api.agent.workspace.set({ mode: 'new_thread', projectId: project.value.id, modelParameterPresetId: null })
    }, server.address().port)
    await page.reload()
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.getByRole('button', { name: 'Workspace menu', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Notepad', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'File changes', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Plugin settings', exact: true }).click()
    await expect(page.locator('.plugin-settings')).toBeVisible()
    await page.locator('[data-settings-tab="tools"]').click()
    await page.getByRole('button', { name: /^Plugins\s*3$/ }).click()
    await expect(page.getByRole('region', { name: 'Text tools', exact: true })).toBeVisible()
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-tools-catalog.png') })
    await page.getByRole('button', { name: /^plugin__example-text-tools__echo:/ }).click()
    const definition = page.getByRole('dialog')
    await expect(definition.getByText('Operation type: Read-only (read) · Timeout: 30 seconds', { exact: true })).toBeVisible()
    const modelDefinition = JSON.parse(await definition.locator('pre').textContent())
    assert.equal(modelDefinition.name, 'plugin__example-text-tools__echo')
    assert.deepEqual(modelDefinition.parameters, JSON.parse(await readFile(join(fixture, 'PLUGIN.json'), 'utf8')).tools[0].input_schema)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'zh-CN' }))
    const executionSummary = definition.getByText('操作类型：只读 (read)　超时：30秒', { exact: true })
    await expect(executionSummary).toBeVisible()
    assert.ok(await executionSummary.evaluate(element => {
      const range = element.ownerDocument.createRange()
      range.selectNodeContents(element)
      return range.getClientRects().length === 1
    }),
      'Plugin operation type and timeout should fit on one line.')
    await page.screenshot({ path: resolve('tmp/plugin-tool-details.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
    await definition.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'stopped', 'Browsing the catalog must not start plugin code.')
    assert.deepEqual(await page.evaluate(async () => (await globalThis.gale.projects.list()).find(project => project.name === 'Plugin capability fixture').capabilities.pluginTools), [], 'Browsing definitions must not enable tools.')
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    const capabilityDialog = await openCapabilityProject(page, 'Plugin capability fixture')
    await capabilityDialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    const pluginCheckbox = capabilityDialog.getByRole('checkbox', { name: 'Text tools', exact: true })
    await expect(pluginCheckbox).not.toBeChecked()
    await expect(capabilityDialog.getByRole('radiogroup', { name: 'Plugins', exact: true })).toBeVisible()
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'stopped')
    await pluginCheckbox.check()
    await pluginCheckbox.uncheck()
    await pluginCheckbox.check()
    await capabilityDialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect(pluginCheckbox).not.toBeVisible()
    await capabilityDialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect(pluginCheckbox).toBeChecked()
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-tools-capabilities.png') })
    await capabilityDialog.getByRole('button', { name: 'Save', exact: true }).click()
    const savedCapabilities = await page.evaluate(async () => (await globalThis.gale.projects.list()).find(project => project.name === 'Plugin capability fixture').capabilities)
    assert.deepEqual(savedCapabilities.plugins, [{ id: 'example-text-tools', mode: 'all' }])
    assert.deepEqual(savedCapabilities.pluginTools, [])
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.locator('[data-settings-tab="plugins"]').click()
    await expect(page.getByRole('radio', { name: 'Capabilities', exact: true })).toHaveCount(0)
    const echoChoice = page.getByRole('checkbox', { name: 'echo', exact: true })
    await expect(echoChoice).toBeChecked()
    await expect(page.getByRole('button', { name: 'echo', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'echo-guide', exact: true })).toHaveCount(0)
    const previewCapabilities = () => page.evaluate(async () => {
      const api = globalThis.gale
      const project = (await api.projects.list()).find(item => item.name === 'Plugin capability fixture')
      return (await api.agent.context.previewModelRequest({ projectId: project.id, project, settings: (await api.config.get()).settings })).content
    })
    await page.evaluate(() => {
      const selector = 'input[aria-label="wait"]'
      const original = globalThis.document.querySelector(selector)
      const samples = []
      const sample = () => {
        const current = globalThis.document.querySelector(selector)
        samples.push({ sameNode: current === original, opacity: current ? globalThis.getComputedStyle(current).opacity : null,
          height: globalThis.document.querySelector('.settings-contribution-group')?.getBoundingClientRect().height })
      }
        const observer = new globalThis.MutationObserver(sample)
      observer.observe(globalThis.document.querySelector('.plugin-settings'), { subtree: true, childList: true, attributes: true })
      sample()
      globalThis.__finishPluginSaveSamples = () => { sample(); observer.disconnect(); return samples }
    })
    await echoChoice.uncheck()
    await expect(echoChoice).not.toBeChecked()
    await expect(echoChoice).not.toHaveAttribute('aria-busy', 'true')
    const saveSamples = await page.evaluate(() => globalThis.__finishPluginSaveSamples())
    assert.ok(saveSamples.every(sample => sample.sameNode && sample.opacity === '1' && sample.height === saveSamples[0].height),
      'Saving one capability must not dim, remount or resize unrelated controls: ' + JSON.stringify(saveSamples))
    assert.equal((await previewCapabilities()).includes('plugin__example-text-tools__echo'), false)
    assert.equal((await previewCapabilities()).includes('ECHO_DEPENDENCY_HINT'), false)
    assert.equal((await previewCapabilities()).replace(/\\+/g, '/').includes('echo-guide/SKILL.md'), false)
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => globalThis.gale.config.updateSettings({ theme }), theme)
      for (const name of ['echo-guide', 'echo-hint']) {
        const dependent = name === 'echo-guide' ? page.locator('code').filter({ hasText: /^echo-guide$/ }) : page.getByRole('button', { name, exact: true })
        const dependentName = name === 'echo-guide' ? dependent : dependent.locator('code')
        const choice = name === 'echo-guide'
          ? page.getByRole('group', { name, exact: true }).getByRole('checkbox', { name: 'Shortcut', exact: true })
          : page.getByRole('checkbox', { name, exact: true })
        await expect(choice).toBeChecked()
        await expect(dependent).toHaveAttribute('data-tooltip', /plugin__example-text-tools__echo/)
        await expectWarningColor(dependentName)
        await dependent.hover()
        await expectWarningColor(dependentName)
        if (name === 'echo-hint') {
          await choice.focus()
          await page.keyboard.press('Tab')
          await expect(dependent).toBeFocused()
          await expectWarningColor(dependentName)
        }
      }
      await page.locator('[data-settings-tab="tools"]').click()
      await page.getByRole('button', { name: /^Plugins\s*3$/ }).click()
      const disabledTool = page.getByRole('button', { name: /^plugin__example-text-tools__echo:/ })
      await expect(disabledTool).toHaveAttribute('data-tooltip', 'This tool is disabled in plugin settings.')
      await expectWarningColor(disabledTool.locator('code'))
      await disabledTool.hover()
      await expectWarningColor(disabledTool.locator('code'))
      await page.locator('[data-settings-tab="plugins"]').click()
    }
    await page.screenshot({ path: resolve('tmp/plugin-dependency-warning.png') })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'dark' }))
    const toolChoices = page.getByRole('group', { name: 'Tools', exact: true })
    await toolChoices.getByRole('button', { name: 'Select all', exact: true }).click()
    await expect(echoChoice).toBeChecked()
    await expect(toolChoices).toHaveAttribute('open', '')
    await expect(page.locator('code').filter({ hasText: /^echo-guide$/ })).not.toHaveClass(/ui-resource-unavailable/)
    assert.ok((await previewCapabilities()).includes('ECHO_DEPENDENCY_HINT'))
    assert.ok((await previewCapabilities()).replace(/\\+/g, '/').includes('echo-guide/SKILL.md'))
    assert.ok((await previewCapabilities()).includes('plugin__example-text-tools__echo'))
    const skillChoices = page.getByRole('group', { name: 'Skills', exact: true })
    await skillChoices.getByRole('button', { name: 'Deselect all', exact: true }).click()
    for (const checkbox of await skillChoices.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked()
    await expect(skillChoices).toHaveAttribute('open', '')
    await expect.poll(async () => (await previewCapabilities()).replace(/\\+/g, '/').includes('echo-guide/SKILL.md')).toBe(false)
    await skillChoices.getByRole('button', { name: 'Select all', exact: true }).click()
    for (const checkbox of await skillChoices.getByRole('checkbox').all()) await expect(checkbox).toBeChecked()
    await expect.poll(async () => (await previewCapabilities()).replace(/\\+/g, '/').includes('echo-guide/SKILL.md')).toBe(true)
    await page.screenshot({ path: join(__dirname, '../tmp/plugin-capability-switches.png') })
    await page.getByRole('button', { name: 'echo-hint', exact: true }).click()
    await expect(page.getByRole('dialog').getByText('ECHO_DEPENDENCY_HINT', { exact: true })).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()

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
    const verifyForm = await observeStableControls(page, form)
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(form).toHaveCount(0)
    await verifyForm()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'dark', fontSize: 14 }))
    await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), originalBounds)
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.invoke('example-text-tools', 'settings.get'))).values.prefix, 'Configured: ')
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'stopped', 'Settings must not start plugin code.')
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.locator('[data-agent-composer-input]').fill('Echo the supplied test text.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('PLUGIN_TOOL_FINISHED', { exact: true })).toBeVisible()
    assert.ok(requests.some(input => input.tools.some(tool => tool.function.name === 'plugin__example-text-tools__echo')), 'The selected plugin must supply its declared tools.')
    assert.ok(requests.some(input => input.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('Configured: PLUGIN_ECHO_RESULT'))))
    assert.equal(await page.locator('iframe').count(), 0, 'Tools must run without plugin pages.')
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'running')
    mode = 'image'
    await page.locator('[data-agent-composer-input]').fill('Return the test image.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('PLUGIN_TOOL_FINISHED', { exact: true })).toHaveCount(2)
    assert.ok(requests.some(input => input.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url' && block.image_url.url.startsWith('data:image/png;base64,')))), 'A native image block must reach the model.')
    const persisted = await readHistoryImages(page)
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
    await expect.poll(async () => (await readFile(startedCallsFile, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line)).some(call => call.name === 'wait')).toBe(true)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    assert.equal((await page.evaluate(() => globalThis.gale.plugins.list()))[0].backendStatus, 'running', 'Cooperative cancellation must retain the backend.')
    const completedCalls = async () => (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    await expect.poll(async () => (await completedCalls()).length).toBe(3)
    const completed = await completedCalls()
    assert.deepEqual(completed.map(item => item.index), [1, 2, 3], 'Independent turns must share the same plugin backend state.')
    assert.deepEqual(completed.map(item => item.cancelled), [false, false, true])
    assert.ok(completed.every(item => JSON.stringify(item.contextKeys) === JSON.stringify(['deadline', 'host', 'signal'])), 'Tools must receive per-call services without conversation identity.')
    await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async (_window, options) => {
      if (options.defaultPath !== paths.examples) throw new Error('Plugin installation must open the runtime examples directory.')
      return { canceled: false, filePaths: [paths.archive] }
    } }, { examples: join(home, 'examples/plugins'), archive: join(home, 'examples/plugins/writing-helper.zip') })
    await page.evaluate(() => globalThis.gale.plugins.install())
    await expect(page.getByRole('button', { name: 'Workspace menu', exact: true })).toBeVisible()
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    const writingDialog = await openCapabilityProject(page, 'Plugin capability fixture')
    await writingDialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await writingDialog.getByRole('checkbox', { name: 'Writing helper', exact: true }).check()
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
    await page.evaluate(async () => {
      await globalThis.gale.plugins.setCapabilityEnabled('writing-helper', 'prompt', ['writing-tone'], false)
      await globalThis.gale.skills.updateAvailability(undefined, 'writing-helper:skill:proofread', { userAvailable: false, modelAvailable: false })
    })
    const withoutInstructions = await previewCapabilities()
    assert.equal(withoutInstructions.includes('writing-helper:prompt:writing-tone'), false)
    assert.equal(withoutInstructions.includes('proofread/SKILL.md'), false)
    const disabledInvocation = await page.evaluate(async () => {
      const project = (await globalThis.gale.projects.list()).find(item => item.name === 'Plugin capability fixture')
      return globalThis.gale.skills.invoke(project.id, 'proofread', 'plugin:writing-helper', 'Check this prose.')
    })
    assert.equal(disabledInvocation.errorCode, 'user_unavailable')
    await page.evaluate(() => globalThis.gale.plugins.setEnabled('writing-helper', false))
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.locator('[data-settings-tab="skills"]').click()
    await page.getByRole('button', { name: /^Writing helper/ }).click()
    await page.locator('.settings-skill-viewer').getByRole('button', { name: /^proofread/ }).click()
    await expect(page.locator('.settings-skill-viewer').getByRole('checkbox')).toHaveCount(0)
    await page.getByRole('button', { name: 'Expand Skill “proofread”', exact: true }).click()
    await page.getByRole('button', { name: 'SKILL.md', exact: true }).click()
    await expect(page.locator('.settings-skill-viewer')).toContainText('Read the supplied text and identify its intended audience.')
    await page.locator('.settings-skill-tree-select').filter({ hasText: /^proofread/ }).click()
    await page.getByRole('button', { name: 'Plugin settings', exact: true }).click()
    const usage = page.getByRole('group', { name: 'proofread', exact: true })
    const storedSkill = () => page.evaluate(async () => (await globalThis.gale.skills.get()).skills.find(skill => skill.id === 'writing-helper:skill:proofread'))
    for (const [label, field] of [['Shortcut', 'userAvailable'], ['Available to model', 'modelAvailable']]) {
      const checkbox = usage.getByRole('checkbox', { name: label, exact: true })
      await expect(checkbox).not.toBeChecked()
      const stable = await observeStableControls(page, usage)
      await checkbox.check()
      await expect.poll(async () => (await storedSkill()).configuredAvailability[field]).toBe(true)
      await checkbox.uncheck()
      await expect.poll(async () => (await storedSkill()).configuredAvailability[field]).toBe(false)
      await checkbox.check()
      await expect.poll(async () => (await storedSkill()).configuredAvailability[field]).toBe(true)
      await stable()
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect(checkbox).toBeChecked()
    }
    const inactiveSkill = await storedSkill()
    assert.equal(inactiveSkill.modelAvailable, false)
    assert.equal(inactiveSkill.userAvailable, false)
    await page.screenshot({ path: resolve('tmp/plugin-disabled-skill-choices.png') })
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.evaluate(async () => {
      await globalThis.gale.plugins.setCapabilityEnabled('writing-helper', 'prompt', ['writing-tone'], true)
      await globalThis.gale.plugins.setEnabled('writing-helper', true)
    })
    mode = 'instructions'
    await page.locator('[data-agent-composer-input]').fill('Check this prose using the selected static instructions.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('PLUGIN_TOOL_FINISHED', { exact: true })).toHaveCount(3, { timeout: 35000 })
    assert.equal(await page.locator('iframe').count(), 0)
    const staticPlugin = (await page.evaluate(() => globalThis.gale.plugins.list())).find(plugin => plugin.id === 'writing-helper')
    assert.equal(staticPlugin.backendStatus, 'stopped')
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, join(home, 'examples/plugins/notepad.zip'))
    await page.evaluate(() => globalThis.gale.plugins.install())
    await page.getByRole('button', { name: 'Workspace menu', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Notepad', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Plugin settings', exact: true })).toBeVisible()
    await mkdir(resolve('tmp'), { recursive: true })
    await page.getByRole('menu').screenshot({ path: resolve('tmp/plugin-menu-settings.png') })
    await page.getByRole('menuitem', { name: 'Notepad', exact: true }).click()
    const notepad = await pluginPage(application, 'example-notepad')
    await expect(notepad.locator('#draft')).toBeEnabled()
    await page.evaluate(() => globalThis.gale.plugins.uninstall('example-notepad', true))
    await expect(page.getByRole('button', { name: 'Workspace menu', exact: true })).toBeVisible()
    await page.evaluate(() => globalThis.gale.plugins.setEnabled('writing-helper', false))
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.skills.get()).skills.find(skill => skill.id === 'writing-helper:skill:proofread')))
      .toMatchObject({ modelAvailable: false, userAvailable: false })
    await page.evaluate(() => globalThis.gale.plugins.setCapabilityEnabled('example-text-tools', 'tool', ['echo'], false))
    const archivePath = join(archiveRoot, 'plugin-history.zip')
    await page.evaluate(() => globalThis.gale.plugins.setEnabled('usage-meter', false))
    await writeFile(join(home, 'plugins/_system/usage-meter/stale.txt'), 'bundled file from an older backup')
    await mkdir(join(home, 'examples/plugins/notepad'))
    await writeFile(join(home, 'examples/plugins/notepad/stale.txt'), 'example file from an older backup')
    await application.evaluate(({ app }, directory) => app.setPath('documents', directory), archiveRoot)
    await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, archivePath)
    const backup = await page.evaluate(() => globalThis.gale.app.backupData())
    assert.equal(backup.path, archivePath)
    await page.evaluate(() => globalThis.gale.plugins.uninstall('example-text-tools', true))
    assert.ok(JSON.stringify(await readHistoryImages(page, persisted.thread.id)).includes('iVBORw0KGgo'), 'Uninstalling a plugin must not remove its ordinary history images.')
    await closeElectronTestApplication(application)
    application = await launchApplication(home)
    const restarted = await application.firstWindow()
    await restarted.locator('[data-agent-composer-input]').waitFor()
    assert.ok(JSON.stringify(await readHistoryImages(restarted, persisted.thread.id)).includes('iVBORw0KGgo'), 'Images must survive process restart with their plugin uninstalled.')
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
    await application.evaluate(({ app }, directory) => app.setPath('documents', directory), archiveRoot)
    await restarted.evaluate(path => globalThis.gale.app.restoreData(path), archivePath)
    assert.ok(JSON.stringify(await readHistoryImages(restarted, persisted.thread.id)).includes('iVBORw0KGgo'), 'Restore must recover ordinary image history.')
    assert.equal((await restarted.evaluate(() => globalThis.gale.plugins.invoke('example-text-tools', 'settings.get'))).values.prefix, 'Configured: ')
    assert.equal((await restarted.evaluate(() => globalThis.gale.plugins.list())).find(plugin => plugin.id === 'example-text-tools').backendStatus, 'stopped')
    assert.equal((await restarted.evaluate(() => globalThis.gale.plugins.list())).find(plugin => plugin.id === 'example-text-tools').capabilityChoices.tool.echo, false)
    const builtin = (await restarted.evaluate(() => globalThis.gale.plugins.list())).find(plugin => plugin.id === 'usage-meter')
    assert.equal(builtin.enabled, false, 'Refreshing built-in packages must preserve their disabled state.')
    assert.equal(builtin.error, undefined)
    await assert.rejects(readFile(join(home, 'plugins/_system/usage-meter/stale.txt')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(home, 'examples/plugins/notepad/stale.txt')), { code: 'ENOENT' })
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
