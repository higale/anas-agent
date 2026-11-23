const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { panelPage } = require('./electron-panel-helpers.cjs')
const { windowsProbe } = require('./electron-pty-lifecycle.cjs')

const quote = text => `'${text.replaceAll("'", "'\\''")}'`
const quotePowerShell = text => `'${text.replaceAll("'", "''")}'`
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const fixtureSource = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [root, role] = process.argv.slice(2)
const probe = process.platform === 'win32' ? (${windowsProbe.toString()})(require(${JSON.stringify(require.resolve('koffi'))})) : undefined
writeFileSync(join(root, role + '.json'), JSON.stringify({ pid: process.pid, birth: probe?.birth() }))
if (!role.endsWith('-helper')) spawn(process.execPath, [__filename, root, role + '-helper'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()
let count = 0
setInterval(() => writeFileSync(join(root, role + '.heartbeat'), String(++count)), 100)
`

async function verifyProcessList(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-process-list-'))
  const workspace = join(root, 'workspace'), errors = [], identities = new Map(), handles = new Map()
  const probe = process.platform === 'win32' ? windowsProbe(require('koffi')) : undefined
  let application, requests = 0, toolResult
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/v1/chat/completions')
      let body = ''
      for await (const chunk of request) { body += chunk; assert.ok(body.length < 1_000_000) }
      const input = JSON.parse(body)
      requests++
      let message, finishReason
      if (requests === 1) {
        const shell = input.tools.filter(tool => tool.function.parameters.properties.pty)
        assert.equal(shell.length, 1)
        assert.equal('keep_processes' in shell[0].function.parameters.properties, false)
        const launch = role => {
          const args = [join(workspace, 'fixture.cjs'), workspace, role]
          return process.platform === 'win32'
            ? `Start-Process -WindowStyle Hidden -FilePath ${quotePowerShell(process.execPath)} -ArgumentList @(${args.map(arg => quotePowerShell('"' + arg + '"')).join(',')})`
            : `nohup ${[process.execPath, ...args].map(quote).join(' ')} >/dev/null 2>&1 &`
        }
        const command = process.platform === 'win32'
          ? `${launch('one')}; ${launch('two')}; Start-Sleep -Milliseconds 1500`
          : `${launch('one')} ${launch('two')} sleep 1.5`
        message = { role: 'assistant', content: null, tool_calls: [{ id: 'process-list-call', type: 'function', function: {
          name: shell[0].function.name, arguments: JSON.stringify({ command, working_dir: workspace, summary: '进程列表验证' })
        } }] }
        finishReason = 'tool_calls'
      } else {
        assert.equal(requests, 2, 'Only one Shell must be launched.')
        const result = input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'process-list-call')
        assert.ok(result)
        toolResult = JSON.parse(typeof result.content === 'string' ? result.content : result.content.map(part => part.text ?? '').join(''))
        assert.equal(toolResult.ok, true)
        assert.ok(toolResult.remaining_processes.length >= 2, 'Completion must include observed child PIDs without read_call.')
        assert.deepEqual(Object.keys(toolResult).sort(), ['ok', 'remaining_processes'])
        for (const process of toolResult.remaining_processes) assert.deepEqual(Object.keys(process).sort(), ['name', 'pid'])
        message = { role: 'assistant', content: '已启动两个独立测试进程。' }; finishReason = 'stop'
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `process-response-${requests}`, object: 'chat.completion', created: 1,
        model: input.model, choices: [{ index: 0, finish_reason: finishReason, message }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }))
    })().catch(error => { errors.push(String(error)); response.writeHead(500); response.end(JSON.stringify({ error: { message: String(error) } })) })
  })
  try {
    await mkdir(workspace)
    await writeFile(join(workspace, 'fixture.cjs'), fixtureSource)
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    application = await launchApplication(join(root, 'profile'))
    const page = await application.firstWindow({ timeout: 45_000 })
    await page.waitForSelector('[data-agent-composer-input]', { timeout: 45_000 })
    const submitted = await page.evaluate(async ({ baseUrl, workspace }) => {
      const api = globalThis.gale
      const providers = await api.config.saveModelProvider({ name: 'Process fixture', protocol: 'openai_chat_completions', baseUrl, apiKey: '', parameters: {} })
      const providerId = providers.providers.find(provider => provider.name === 'Process fixture').id
      const models = await api.config.saveProviderModel({ providerId, displayName: 'Process fixture', model: 'process-fixture',
        parameters: {}, parameterPresetMode: 'none', capabilities: { vision: false, toolUse: true }, stream: false,
        maxContextTokens: 128000, maxOutputTokens: 4096, contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
      const modelConfigId = models.providers.find(provider => provider.id === providerId).models[0].id
      await api.config.selectDefaultModel(modelConfigId)
      const result = await api.projects.create({ name: '进程列表验证', sourceFolders: [workspace], codingMode: true,
        prompt: '', restrictSubagents: false, capabilities: { profile: false, environment: false, workspace: true, memory: false,
          applicationEnvironment: false, backgroundTools: true, subagents: { mode: 'off', names: [] }, planning: false,
          toolMode: 'selected', tools: ['run_shell', 'read_call', 'cancel_call'], customTools: { project: false, entries: [] },
          mcp: { defaultMode: 'selected', servers: [] }, skills: { project: false, mode: 'off', entries: [] } } })
      if (result.status === 'error') throw new Error(JSON.stringify(result.error))
      return api.agent.runs.submit({ requestId: globalThis.crypto.randomUUID(),
        newThread: { title: '进程列表验证', projectId: result.value.id, modelConfigId, accessMode: 'full_access' },
        text: '运行进程列表测试。' })
    }, { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, workspace })
    await expect(async () => {
      assert.deepEqual(errors, [])
      assert.equal(requests, 2)
      const thread = await page.evaluate(id => globalThis.gale.agent.threads.get(id), submitted.thread.id)
      assert.equal(thread.thread.status, 'idle')
    }).toPass({ timeout: 25_000 })
    for (const role of ['one', 'two', 'one-helper', 'two-helper']) {
      const identity = JSON.parse(await readFile(join(workspace, `${role}.json`), 'utf8'))
      identities.set(role, identity)
      if (probe) { const handle = probe.capture(identity); assert.ok(handle); handles.set(role, handle) }
      assert.equal(toolResult.remaining_processes.some(process => process.pid === identity.pid), !role.endsWith('-helper'), 'Only direct Shell children belong in the result.')
    }
    const listing = await page.evaluate(threadId => globalThis.gale.agent.processes.list({ threadId }), submitted.thread.id)
    assert.ok(listing.calls.some(call => call.summary === '进程列表验证' && call.status === 'completed'))
    assert.ok(listing.calls.some(call => call.command.includes('fixture.cjs') && call.snapshot.processes.some(process => process.birth)))
    await page.evaluate(threadId => globalThis.gale.agent.workspace.set({ mode: 'thread', threadId }), submitted.thread.id)
    await page.reload()
    await page.getByRole('button', { name: /工作区菜单|Workspace menu/ }).click()
    const menu = await page.getByRole('menuitem').allTextContents()
    const memory = menu.findIndex(text => /项目记忆|Project memory/.test(text))
    assert.ok(memory >= 0)
    assert.match(menu[memory + 1], /进程列表|Process list/)
    await page.getByRole('menuitem', { name: /进程列表|Process list/ }).click()
    const panel = await panelPage(application, 'processes')
    const first = identities.get('one'), second = identities.get('two')
    await expect(panel.getByText(`PID ${first.pid}`, { exact: true })).toBeVisible()
    await expect(panel.getByText(`PID ${second.pid}`, { exact: true })).toBeVisible()
    for (const role of ['one-helper', 'two-helper']) {
      await expect(panel.getByText(`PID ${identities.get(role).pid}`, { exact: true })).toHaveCount(0)
      assert.ok(!listing.calls.some(call => call.snapshot.processes.some(process => process.pid === identities.get(role).pid)))
    }
    await expect(panel.locator('.process-list-call').first()).toContainText(/已完成|Completed/)
    await mkdir(resolve(__dirname, '../tmp'), { recursive: true })
    await page.screenshot({ path: resolve(__dirname, '../tmp/process-list.png') })
    await panel.getByRole('button', { name: new RegExp(`\\(${first.pid}\\)$`) }).click()
    await expect.poll(() => probe ? probe.exited(handles.get('one')) : !alive(first.pid), { timeout: 5_000 }).toBe(true)
    await expect(panel.getByText(`PID ${first.pid}`, { exact: true })).toHaveCount(0)
    assert.equal(probe ? probe.exited(handles.get('one-helper')) : !alive(identities.get('one-helper').pid), false, 'Stopping an application must not terminate its helper.')
    assert.equal(probe ? probe.exited(handles.get('two')) : !alive(second.pid), false, 'Manual termination must not kill sibling processes.')
    const main = application.process()
    await application.evaluate(({ app }) => { setImmediate(() => app.quit()) })
    await expect.poll(() => main.exitCode, { timeout: 15_000 }).toBe(0)
    assert.equal(probe ? probe.exited(handles.get('two')) : !alive(second.pid), false, 'Quitting Anas must preserve an independently running child.')
    const heartbeat = Number(await readFile(join(workspace, 'two.heartbeat'), 'utf8'))
    await expect.poll(async () => Number(await readFile(join(workspace, 'two.heartbeat'), 'utf8'))).toBeGreaterThan(heartbeat)
    assert.deepEqual(errors, [])
    console.log('Process list passed: direct-child PIDs without application helpers, menu placement, right sidebar, exact manual termination, independent child survives normal app quit.')
  } finally {
    await application?.close().catch(() => undefined)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    try {
      for (const role of ['one', 'two', 'one-helper', 'two-helper']) {
        const identity = identities.get(role) ?? await readFile(join(workspace, `${role}.json`), 'utf8').then(JSON.parse).catch(() => undefined)
        if (!identity) continue
        if (probe) {
          const handle = handles.get(role) ?? probe.capture(identity)
          if (handle) { handles.set(role, handle); probe.terminate(handle); await expect.poll(() => probe.exited(handle)).toBe(true) }
        } else if (alive(identity.pid)) { process.kill(identity.pid, 'SIGKILL'); await expect.poll(() => !alive(identity.pid)).toBe(true) }
      }
    } finally { if (probe) for (const handle of handles.values()) probe.close(handle) }
    await rm(root, { recursive: true, force: true })
  }
}
module.exports = { verifyProcessList }
