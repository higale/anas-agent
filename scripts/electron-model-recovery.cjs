const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readdir, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const settingsDefaults = require('../data/config/settings.json')
const { restrict_subagents, ...capabilityDefaults } = require('../data/config/capabilities.json')

async function verifyModelRecovery(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-model-recovery-e2e-'))
  const profile = join(root, 'profile'), workspace = join(root, 'workspace')
  const requests = [], errors = []
  let application, release
  const finish = new Promise(resolve => { release = resolve })
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body), index = requests.length
      requests.push(input)
      if (index === 3) await finish
      if (index === 8) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
        response.end(JSON.stringify({ error: { message: 'Controlled rate limit' } }))
        return
      }
      if (index >= 9) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Controlled compression failure' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      const message = index === 0 ? { role: 'assistant', content: null, tool_calls: [{ id: 'plan', type: 'function', function: {
        name: 'write_todos', arguments: JSON.stringify({ todos: [{ content: 'KEEP_COMPLETED_PLAN', status: 'completed' }] }) } }] }
        : index === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'write_todos', arguments: '{"retry_evidence":"MALFORMED_EVIDENCE"' } }] }
          : { role: 'assistant', content: index === 2 ? 'Retained answer prefix.' : index >= 4 && index <= 6 ? `Limited segment ${index}.` : index === 7 ? 'Manual recovery finished.' : 'Recovery finished.' }
      response.end(JSON.stringify({ id: `recovery-${index}`, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, finish_reason: index === 2 || index >= 4 && index <= 6 ? 'length' : index < 2 ? 'tool_calls' : 'stop', message }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }))
    })().catch(error => { errors.push(String(error)); response.destroy() })
  })
  try {
    await mkdir(join(profile, 'config'), { recursive: true })
    await mkdir(workspace)
    await writeFile(join(profile, 'config/settings.json'), JSON.stringify({ ...settingsDefaults, language: 'en' }))
    const capabilities = { ...structuredClone(capabilityDefaults), application_environment: false, background_tools: false,
      subagents: { mode: 'off', names: [] }, planning: true, tool_mode: 'selected', tools: [],
      profile: false, environment: false, workspace: false, memory: false,
      skills: { mode: 'off', project: false, entries: [] }, mcp: { default_mode: 'selected', servers: [] } }
    const timestamp = new Date().toISOString()
    await mkdir(join(profile, 'db/projects/default-workspace'), { recursive: true })
    await writeFile(join(profile, 'db/projects/default-workspace/project.json'), JSON.stringify({ version: 0, project: {
      id: 'default-workspace', kind: 'workspace', name: 'Model recovery test', sourceFolders: [workspace], capabilities,
      restrict_subagents, advanced_settings: true, coding_mode: false, prompt: '', createdAt: timestamp, updatedAt: timestamp
    } }))
    await writeFile(join(profile, 'db/projects/state.json'), JSON.stringify({ version: 0, storage_layout: 'project-directories', projects: [] }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    application = await launchApplication(profile)
    let page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible()
    await page.evaluate(async port => {
      const saved = await globalThis.gale.config.saveModelProvider({ name: 'Retry fixture', protocol: 'openai_chat_completions',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListUrl: '' })
      const providerId = saved.providers.find(provider => provider.name === 'Retry fixture').id
      await globalThis.gale.config.saveProviderModel({ providerId, displayName: 'Retry Model', model: 'retry-fixture', parameters: {}, parameterPresetMode: 'none', parameterPresets: [],
        capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 100000, maxOutputTokens: 5000,
        contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
    }, server.address().port)
    await page.getByRole('button', { name: 'Select model', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^Retry Model(?: |$)/ }).click()
    await page.locator('[data-agent-composer-input]').fill('Exercise automatic recovery without repeating completed tools.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => requests.length).toBe(4)
    await expect(page.getByRole('status').filter({ hasText: 'Recovering: continuing a truncated answer (2/2)' })).toBeVisible()
    await expect(page.getByText('Retained answer prefix.', { exact: true }).first()).toBeVisible()
    assert.match(JSON.stringify(requests[2]), /invalid tool call/)
    assert.match(JSON.stringify(requests[3]), /Continue exactly where it ended/)
    assert.equal(JSON.stringify(requests[3]).match(/Retained answer prefix\./g).length, 1)
    await mkdir(resolve('tmp/model-output-recovery'), { recursive: true })
    await page.screenshot({ path: resolve('tmp/model-output-recovery/recovering.png') })
    release()
    await expect(page.getByText('Recovery finished.', { exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Recovering:' })).toHaveCount(0)
    assert.equal(requests.length, 4)
    const snapshot = await page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      return globalThis.gale.agent.threads.get(thread.id)
    })
    assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 1)
    assert.equal(snapshot.activities.flatMap(activity => activity.tools).length, 1)
    assert.deepEqual(snapshot.todos, [{ content: 'KEEP_COMPLETED_PLAN', status: 'completed' }])
    assert.equal(snapshot.modelRetries, undefined)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve('tmp/model-output-recovery/completed.png') })
    await page.locator('[data-agent-composer-input]').fill('Exercise recovery exhaustion.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const retry = page.getByRole('button', { name: 'Retry', exact: true })
    await expect(retry).toBeEnabled()
    assert.equal(requests.length, 7)
    await retry.click()
    await expect(page.getByText('Manual recovery finished.', { exact: true })).toBeVisible()
    await expect(retry).toHaveCount(0)
    assert.equal(requests.length, 8)
    assert.match(JSON.stringify(requests[7]), /Continue exactly where it ended/)
    assert.deepEqual(errors, [])
    await page.locator('[data-agent-composer-input]').fill('Exercise cancellation during retry backoff.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'waiting to retry after rate limiting' })).toBeVisible()
    await page.waitForTimeout(1100)
    assert.equal(requests.length, 9, 'Retry-After must prevent the ordinary half-second retry.')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    assert.equal(requests.length, 9)
    assert.deepEqual(errors, [])
    const readLogs = async () => (await Promise.all((await readdir(join(profile, 'log')))
      .filter(name => name.endsWith('_main.log')).map(name => readFile(join(profile, 'log', name), 'utf8')))).join('\n')
    await expect.poll(async () => (await readLogs()).includes("outcome: 'cancelled'")).toBe(true)
    const logs = await readLogs()
    for (const event of ['scheduled', 'attempt_started', 'response_accepted', 'exhausted', 'manual_requested', 'manual_started', 'run_finished']) {
      assert.ok(logs.includes(`Model recovery: ${event}.`), `Missing ordinary log event: ${event}`)
    }
    assert.match(logs, /invalid_tool_call/)
    assert.match(logs, /MALFORMED_EVIDENCE/)
    assert.match(logs, /text_continuation/)
    assert.match(logs, /Controlled rate limit/)
    assert.match(logs, /delayMs: 30000/)
    assert.ok(logs.includes(snapshot.thread.id), 'Recovery logs must identify the conversation.')
    await expect.poll(async () => page.evaluate(async threadId => {
      const current = await globalThis.gale.agent.threads.get(threadId)
      return !current.pendingRun && !current.settlingRun
    }, snapshot.thread.id)).toBe(true)
    const compression = await page.evaluate(threadId => globalThis.gale.agent.runs.compress(threadId), snapshot.thread.id)
    await expect.poll(async () => page.evaluate(async ({ threadId, runId }) => {
      const current = await globalThis.gale.agent.threads.get(threadId)
      return current.activities.find(activity => activity.runId === runId)?.status
    }, { threadId: snapshot.thread.id, runId: compression.id })).toBe('failed')
    assert.equal(requests.length, 12, 'Manual compression must share the outer retry budget: three requests, not nine.')
    assert.deepEqual(errors, [])
    console.log('Model recovery Electron E2E passed: shared retry budget, visible recovery status, text continuation, exhaustion/manual retry, Retry-After cancellation, ordinary retry logs, bounded manual compression, and no repeated tools.')
  } finally {
    release()
    await closeElectronTestApplication(application)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
module.exports = { verifyModelRecovery }
