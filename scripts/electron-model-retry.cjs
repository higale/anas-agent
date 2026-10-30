const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const settingsDefaults = require('../data/config/settings.json')
const { restrict_subagents, ...capabilityDefaults } = require('../data/config/capabilities.json')

async function verifyModelRetry(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-model-retry-e2e-'))
  const profile = join(root, 'profile'), workspace = join(root, 'workspace')
  const requests = [], errors = []
  let application
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body), index = requests.length
      requests.push(input)
      if ([1, 2, 3, 6, 7, 11, 12].includes(index)) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Controlled provider rejection' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      const producesTools = index === 0 || index === 5 || index === 10
      const message = producesTools ? { role: 'assistant', content: null,
        tool_calls: ['left', 'right'].map(id => ({ id: index === 0 ? id : `${id}-${index}`, type: 'function', function: { name: 'write_todos',
          arguments: JSON.stringify({ todos: [{ content: `PRIVATE_RESULT_${id}`, status: 'completed' }] }) } })) }
        : { role: 'assistant', content: 'Retry completed.' }
      response.end(JSON.stringify({ id: `retry-${index}`, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, finish_reason: producesTools ? 'tool_calls' : 'stop', message }],
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
      id: 'default-workspace', kind: 'workspace', name: 'Model retry test', sourceFolders: [workspace], capabilities,
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
    await page.locator('[data-agent-composer-input]').fill('Test the two retry actions.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const retry = () => page.getByRole('button', { name: 'Retry', exact: true })
    const withhold = () => page.getByRole('button', { name: 'Retry (without tool results)', exact: true })
    await expect(retry()).toBeEnabled()
    await expect(withhold()).toBeEnabled()
    assert.equal(requests.length, 2)
    await mkdir(resolve('tmp/model-retry'), { recursive: true })
    await page.screenshot({ path: resolve('tmp/model-retry/actions.png') })
    await retry().click()
    await expect.poll(() => requests.length).toBe(3)
    await expect(retry()).toBeEnabled()
    const tools = input => input.messages.filter(message => message.role === 'tool')
    assert.deepEqual(tools(requests[2]), tools(requests[1]), 'Ordinary retry must retain original results.')
    await withhold().click()
    await expect.poll(() => requests.length).toBe(4)
    await expect(retry()).toBeEnabled()
    await expect(withhold()).toHaveCount(0)
    for (const result of tools(requests[3])) {
      assert.match(result.content, /user chose to retry without returning this round of tool results/)
      assert.doesNotMatch(result.content, /PRIVATE_RESULT_/)
    }
    assert.deepEqual(tools(requests[3]).map(result => result.tool_call_id), ['left', 'right'])
    const firstTool = page.locator('.agent-activity-tool').first()
    await firstTool.locator(':scope > summary').click()
    await firstTool.locator('.agent-activity-result > summary').click()
    await expect(firstTool.locator('.agent-activity-result pre')).toContainText('user chose to retry without returning')
    await expect(firstTool.locator('.agent-activity-result pre')).not.toContainText('PRIVATE_RESULT_')
    await page.screenshot({ path: resolve('tmp/model-retry/saved-tool-return.png') })
    await closeElectronTestApplication(application)
    application = await launchApplication(profile)
    page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await expect(retry()).toBeEnabled()
    await expect(withhold()).toHaveCount(0)
    await retry().click()
    await expect(page.getByText('Retry completed.', { exact: true })).toBeVisible()
    await expect(retry()).toHaveCount(0)
    assert.equal(requests.length, 5)
    assert.deepEqual(tools(requests[4]), tools(requests[3]))
    const snapshot = await page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      return globalThis.gale.agent.threads.get(thread.id)
    })
    assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 1)
    assert.equal(snapshot.activities.flatMap(activity => activity.tools).length, 2, 'Retry must not execute tools again.')
    for (const tool of snapshot.activities.flatMap(activity => activity.tools)) {
      assert.match(String(tool.output), /user chose to retry without returning/)
      assert.doesNotMatch(String(tool.output), /PRIVATE_RESULT_/)
    }
    assert.equal(snapshot.modelRetries, undefined)

    // A subsequent user input establishes a new failure boundary. Even if the
    // previous batch is still in context, only ordinary retry is offered.
    await page.locator('[data-agent-composer-input]').fill('Test a follow-up after tool results.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => requests.length).toBe(7)
    await expect(withhold()).toBeEnabled()
    await page.locator('[data-agent-composer-input]').fill('继续')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => requests.length).toBe(8)
    await expect(retry()).toHaveCount(2)
    await expect(withhold()).toHaveCount(1)
    await expect(page.locator('.agent-activity-error').last().getByRole('button', { name: 'Retry (without tool results)', exact: true })).toHaveCount(0)
    const refused = await page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      const snapshot = await globalThis.gale.agent.threads.get(thread.id)
      const retry = snapshot.modelRetries.at(-1)
      if (retry.canWithholdToolResults) throw new Error('Unexpected withholding capability after user input')
      try {
        await globalThis.gale.agent.runs.retryModel({ threadId: thread.id, runId: retry.runId,
          expectedRevisionId: retry.revisionId, withholdToolResults: true })
        return ''
      } catch (error) { return String(error) }
    })
    assert.match(refused, /no new tool results to withhold/)
    await page.screenshot({ path: resolve('tmp/model-retry/after-user-input.png') })
    await retry().last().click()
    await expect.poll(() => requests.length).toBe(9)
    await expect(retry()).toHaveCount(1)
    assert.deepEqual(tools(requests[8]), tools(requests[7]))

    // The earlier tool error keeps both buttons after a later turn succeeds.
    // Cancelling the confirmation preserves all later content and sends nothing.
    await retry().click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('All conversation content after this error will be removed')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(requests.length, 9)
    await expect(page.getByText('继续', { exact: true })).toBeVisible()
    await withhold().click()
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: resolve('tmp/model-retry/history-confirm.png') })
    await dialog.getByRole('button', { name: 'Remove later content and retry', exact: true }).click()
    await expect.poll(() => requests.length).toBe(10)
    await expect(retry()).toHaveCount(0)
    await expect(page.getByText('继续', { exact: true })).toHaveCount(0)
    assert.equal(requests[9].messages.filter(message => message.role === 'user').length, 2)
    for (const result of tools(requests[9])) assert.match(result.content, /user chose to retry without returning/)
    const afterRollback = await page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      return globalThis.gale.agent.threads.get(thread.id)
    })
    assert.equal(afterRollback.messages.filter(message => message.role === 'user').length, 2)
    assert.equal(afterRollback.activities.flatMap(activity => activity.tools).length, 4, 'Historical retry must not repeat tools.')
    for (const tool of afterRollback.activities.flatMap(activity => activity.tools)) assert.match(String(tool.output), /user chose to retry without returning/)

    // Reproduce deleting a later failed user turn: idle history still offers retry.
    await page.locator('[data-agent-composer-input]').fill('Test retry after deleting later messages.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => requests.length).toBe(12)
    await expect(withhold()).toBeEnabled()
    await page.locator('[data-agent-composer-input]').fill('Delete this later turn')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => requests.length).toBe(13)
    await expect(retry()).toHaveCount(2)
    // The public delete API uses the same history transition as the delete dialog.
    await page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      const snapshot = await globalThis.gale.agent.threads.get(thread.id)
      const lastUser = snapshot.messages.filter(message => message.role === 'user').at(-1)
      await globalThis.gale.agent.messages.truncate({ threadId: thread.id, messageId: lastUser.id })
    })
    await page.reload()
    await expect(retry()).toHaveCount(1)
    await expect(withhold()).toBeEnabled()
    await retry().click()
    await expect.poll(() => requests.length).toBe(14)
    await expect(retry()).toHaveCount(0)
    await expect(dialog).toHaveCount(0)
    assert.deepEqual(tools(requests[13]), tools(requests[11]))
    assert.deepEqual(errors, [])
    console.log('Model retry Electron E2E passed: ordinary/withholding retries, persistence after restart, historical confirmation/cancel/rollback, and retry after deleting later messages; no repeated tools.')
  } finally {
    await closeElectronTestApplication(application)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
module.exports = { verifyModelRetry }
