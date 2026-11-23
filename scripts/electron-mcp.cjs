const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, mkdir, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const { observeStableControls, expectWarningColor } = require('./electron-plugin-helpers.cjs')

async function verifyMcp(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-mcp-'))
  const requests = [], errors = []
  let application, page, mode = 'success', starts = 0, lists = 0, calls = 0, releaseList
  let listGate
  const tools = ['lookup', 'read'].map(name => ({ name, description: `Fixture ${name}.`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }))
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      if (request.url === '/mcp') {
        if (input.id === undefined) { response.writeHead(202); response.end(); return }
        let result
        if (input.method === 'initialize') {
          starts++
          if (mode === 'failure') { response.writeHead(503); response.end('Fixture startup failure'); return }
          result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'MCP fixture', version: '1' } }
        } else if (input.method === 'tools/list') {
          lists++
          if (listGate) await listGate
          result = { tools: mode === 'missing' ? [] : tools }
        } else if (input.method === 'tools/call') {
          calls++
          result = { content: [{ type: 'text', text: 'MCP_FIXTURE_RESULT' }] }
        } else result = {}
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }))
        return
      }
      requests.push({ mode, input })
      const finished = input.messages.at(-1).role === 'tool'
      const toolCalls = finished ? undefined : [{ id: `mcp-${requests.length}`, type: 'function', function: { name: 'mcp__fixture__lookup', arguments: '{}' } }]
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `model-${requests.length}`, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, finish_reason: toolCalls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: toolCalls ? null : `MCP_DONE_${mode}`, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }))
    })().catch(error => { errors.push(String(error)); response.writeHead(500); response.end() })
  })
  const status = () => page.evaluate(() => globalThis.gale.mcp.status())
  const configurePage = async () => {
    page = await application.firstWindow()
    page.setDefaultTimeout(30_000)
    page.on('pageerror', error => errors.push(String(error)))
    await page.locator('[data-agent-composer-input]').waitFor()
  }
  const openSettings = async () => {
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.locator('[data-settings-tab="mcp"]').click()
  }
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    application = await launchApplication(home)
    await configurePage()
    await page.evaluate(async ({ port, home }) => {
      const api = globalThis.gale
      await api.config.updateSettings({ language: 'en', theme: 'dark' })
      await api.config.saveMcpServer({ id: 'fixture', name: 'MCP Fixture', enabled: false, type: 'http', url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000, args: [], env: {} })
      const saved = await api.config.saveModelProvider({ name: 'MCP test', protocol: 'openai_chat_completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {} })
      const providerId = saved.providers.find(provider => provider.name === 'MCP test').id
      const config = await api.config.saveProviderModel({ providerId, displayName: 'MCP test', model: 'mcp-test', parameters: {}, parameterPresetMode: 'none', parameterPresets: [],
        capabilities: { vision: false, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 1000, contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
      await api.config.selectDefaultModel(config.providers.find(provider => provider.id === providerId).models[0].id)
      const base = (await api.projects.list()).find(project => project.id === 'default-workspace')
      const project = await api.projects.create({ ...base, name: 'MCP fixture', sourceFolders: [home], capabilities: { ...base.capabilities,
        toolMode: 'selected', tools: [], planning: false, environment: false, profile: false, workspace: false, memory: false, backgroundTools: false,
        skills: { mode: 'off', project: false, entries: [] }, subagents: { mode: 'off', names: [] }, pluginGroupMode: 'off',
        mcp: { mode: 'all', defaultMode: 'all', servers: [] } } })
      if (project.status !== 'ok') throw new Error(JSON.stringify(project))
      await api.agent.workspace.set({ mode: 'new_thread', projectId: project.value.id, modelParameterPresetId: null })
    }, { port: server.address().port, home })
    await page.reload()
    await page.locator('[data-agent-composer-input]').waitFor()
    await openSettings()
    await expect(page.getByText('No tool catalog yet. Start the server to discover tools.')).toBeVisible()
    assert.equal(starts, 0, 'Saving a server and opening settings must not connect it.')
    await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'lookup', exact: true })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).toBeEnabled()
    await expect(page.getByText('settings.tools', { exact: true })).toHaveCount(0)
    assert.equal(starts, 1)
    assert.equal(lists, 1)
    await expect(page.locator('.ui-list-item').getByText(/^running$/i)).toBeVisible()
    const previewTools = () => page.evaluate(async () => {
      const api = globalThis.gale
      const project = (await api.projects.list()).find(project => project.name === 'MCP fixture')
      return (await api.agent.context.previewModelRequest({ projectId: project.id, project, settings: (await api.config.get()).settings })).content
    })
    assert.equal((await previewTools()).includes('mcp__fixture__lookup'), false, 'Manual startup must not enable model tools.')
    const stable = await observeStableControls(page, page.locator('.ui-editor .ui-capability-list'))
    await expect(page.getByRole('button', { name: 'read', exact: true })).toHaveCount(0)
    await page.locator('.ui-capability-list code').filter({ hasText: /^read$/ }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await status()).servers[0].toolChoices?.mcp__fixture__read).toBe(false)
    await stable()
    assert.equal((await status()).servers[0].state, 'ready', 'Saving a tool choice must not stop a manually started disabled server.')
    await mkdir(resolve(__dirname, '../tmp'), { recursive: true })
    await page.screenshot({ path: resolve(__dirname, '../tmp/mcp-disabled-running.png') })
    await page.getByRole('checkbox', { name: 'Enabled', exact: true }).check()
    await expect.poll(async () => (await previewTools()).includes('mcp__fixture__lookup')).toBe(true)
    assert.equal((await status()).servers[0].state, 'ready')
    assert.equal(starts, 1, 'Enabling a manually started server must reuse its connection.')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(async () => (await status()).servers[0].state).toBe('stopped')
    await expect(page.getByRole('checkbox', { name: 'lookup', exact: true })).toBeChecked()
    const saved = JSON.parse(await readFile(join(home, 'config/mcp_servers.json'), 'utf8'))
    assert.equal(saved.version, 0)
    assert.equal(saved.mcp_servers[0].tool_catalog.tools.length, 2)
    assert.equal(saved.mcp_servers[0].tool_choices.mcp__fixture__read, false)
    await expect(page.getByRole('button', { name: 'lookup', exact: true })).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: resolve(__dirname, '../tmp/mcp-settings.png') })
    await page.locator('[data-settings-tab="tools"]').click()
    await page.getByRole('button', { name: /^MCP\s*2$/ }).click()
    await expectWarningColor(page.locator('.settings-tool-catalog-name').filter({ hasText: 'mcp__fixture__read' }))
    await page.getByRole('button', { name: /^mcp__fixture__lookup:/ }).click()
    const details = page.getByRole('dialog', { name: 'mcp__fixture__lookup', exact: true })
    await expect(details).toBeVisible()
    assert.deepEqual(JSON.parse(await details.locator('pre').innerText()), {
      name: 'mcp__fixture__lookup', description: tools[0].description, parameters: tools[0].inputSchema
    })
    await page.screenshot({ path: resolve(__dirname, '../tmp/mcp-tool-preview.png') })
    await details.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe(JSON.stringify({
      name: 'mcp__fixture__lookup', description: tools[0].description, parameters: tools[0].inputSchema
    }, null, 2))
    await details.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal((await status()).servers[0].state, 'stopped', 'Inspecting tools must not start the server.')
    assert.equal(starts, 1)
    await closeElectronTestApplication(application)
    application = await launchApplication(home)
    await configurePage()
    await expect.poll(async () => (await status())?.tools.length).toBe(2)
    assert.equal(starts, 1, 'Restarting the app must hydrate the catalog without connecting.')
    assert.equal((await status()).servers[0].toolChoices.mcp__fixture__read, false)
    // Catalog hydration can finish before the saved draft project is restored.
    await expect(page.locator('.project-thread-heading[data-selected="true"]')).toContainText('MCP fixture')
    listGate = new Promise(done => { releaseList = done })
    await page.locator('[data-agent-composer-input]').fill('Call the MCP lookup tool.')
    await expect(page.locator('[data-agent-composer-input]')).toHaveValue('Call the MCP lookup tool.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('· Starting MCP MCP Fixture…', { exact: true }).first()).toBeVisible()
    releaseList(); listGate = undefined
    await expect(page.getByText('MCP_DONE_success', { exact: true })).toBeVisible()
    assert.equal(starts, 2)
    assert.equal(lists, 2)
    assert.equal(calls, 1)
    assert.deepEqual(requests[0].input.tools.map(tool => tool.function.name), ['mcp__fixture__lookup'])
    assert.ok(JSON.stringify(requests.at(-1).input.messages).includes('MCP_FIXTURE_RESULT'))
    for (const nextMode of ['failure', 'missing']) {
      await page.evaluate(() => globalThis.gale.mcp.setRunning('fixture', false))
      mode = nextMode
      await page.locator('[data-agent-composer-input]').fill(`Call the lookup tool again: ${mode}.`)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(page.getByText(`MCP_DONE_${mode}`, { exact: true })).toBeVisible()
      const returned = requests.at(-1).input
      assert.ok(JSON.stringify(returned.messages.at(-1)).includes(mode === 'failure' ? 'MCP 启动失败' : '此工具已不存在'))
      assert.equal((await status()).tools.length, mode === 'failure' ? 2 : 0)
      if (mode === 'missing') assert.equal((returned.tools ?? []).length, 0, 'The next model request must omit vanished tools in the same turn.')
    }
    assert.equal(calls, 1, 'Failed startup and vanished tools must never be dispatched.')
    await openSettings()
    await page.getByRole('checkbox', { name: 'Enabled', exact: true }).uncheck()
    await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).toBeDisabled()
    await expect.poll(async () => (await page.evaluate(() => globalThis.gale.config.get())).mcpServers[0].enabled).toBe(false)
    await page.screenshot({ path: resolve(__dirname, '../tmp/mcp-empty-disabled.png') })
    assert.deepEqual(errors, [])
    console.log('MCP Electron E2E passed: manual controls, stable tool switches, persistence, restart without connection, lazy startup progress, startup failure, and empty catalog refresh within the same turn.')
  } finally {
    releaseList?.()
    await closeElectronTestApplication(application)
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    await rm(home, { recursive: true, force: true })
  }
}

module.exports = { verifyMcp }
