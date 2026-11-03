const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { panelPage } = require('./electron-panel-helpers.cjs')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function saveFixtureMemory({ scope, content }) {
  const api = globalThis.gale.preferences
  const current = await api.read(scope)
  const result = await api.save(scope, current.hash, content)
  if (result.status !== 'saved') throw new Error('Fixture memory save conflicted')
}

async function setProjectMemoryEnabled(memory) {
  const api = globalThis.gale
  const project = (await api.projects.list()).find(value => value.id === 'default-workspace')
  const updated = await api.projects.update(project.id, { ...project, capabilities: { ...project.capabilities, memory } })
  if (updated.status !== 'ok') throw new Error(JSON.stringify(updated))
}

async function verifyBackgroundMemory(launch) {
  const root = await mkdtemp(join(tmpdir(), 'anas-memory-e2e-')), requests = [], errors = []
  let application, releaseExtraction, releaseForeground
  const reply = (response, model, content, reportUsage = true) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: `memory-${requests.length}`, object: 'chat.completion', created: 1, model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: reportUsage ? { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } : undefined }))
  }
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''; for await (const chunk of request) body += chunk
      const input = JSON.parse(body); requests.push(input)
      const text = JSON.stringify(input.messages)
      const last = input.messages.at(-1)
      if (last.role === 'user' && JSON.stringify(last.content).includes('foreground preference fixture')) {
        assert.ok(input.tools.some(tool => tool.function?.name === 'update_memory'))
        assert.match(text, /Use update_memory/)
        assert.doesNotMatch(text, /Preference memory updates run in the background/)
        if (/switch while running|edit while running/.test(JSON.stringify(last.content))) await new Promise(resolve => { releaseForeground = resolve })
        const scope = JSON.stringify(last.content).includes('project scope') ? 'project' : 'global'
        const call = { id: 'save-' + scope, type: 'function', function: { name: 'update_memory', arguments: JSON.stringify({ scope, content: '- Foreground ' + scope }) } }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'memory-write', object: 'chat.completion', model: input.model,
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call] } }] }))
      } else if (text.includes('NEW conversation evidence')) {
        if (text.includes('follow-up evidence')) { reply(response, input.model, '{"candidates":[]}', false); return }
        releaseExtraction = () => reply(response, input.model, JSON.stringify({ candidates: [
          { scope: 'global', intent: 'remember', content: '用中文回答。', evidence: '以后请用中文回答。' }
        ] }))
      } else if (text.includes('Consolidate reusable user preferences')) reply(response, input.model, JSON.stringify({ action: 'replace', content: '- 用中文回答。\n' }))
      else reply(response, input.model, text.includes('second turn') && !text.includes('follow-up evidence') ? 'a'.repeat(61000) : 'OK')
    })().catch(error => { errors.push(String(error)); response.writeHead(500); response.end(String(error)) })
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const workspace = join(root, 'workspace'); await mkdir(workspace)
    application = await launch(join(root, 'profile'))
    const page = await application.firstWindow(); page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(String(error)))
    await page.locator('[data-agent-composer-input]').waitFor()
    const models = await page.evaluate(async ({ port, workspace }) => {
      const api = globalThis.gale
      await api.config.updateSettings({ language: 'en', theme: 'dark' })
      const project = (await api.projects.list()).find(item => item.id === 'default-workspace')
      const updated = await api.projects.update(project.id, { ...project, sourceFolders: [workspace], codingMode: false, advancedSettings: true,
        capabilities: { ...project.capabilities, memory: true, toolMode: 'selected', tools: [], planning: false,
          subagents: { mode: 'off', names: [] }, backgroundTools: false, skills: { mode: 'off', project: false, entries: [] },
          mcp: { defaultMode: 'selected', servers: [] } } })
      if (updated.status !== 'ok') throw new Error(JSON.stringify(updated))
      let config = await api.config.saveModelProvider({ name: 'Memory fixture', protocol: 'openai_chat_completions',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListUrl: '' })
      const providerId = config.providers.find(item => item.name === 'Memory fixture').id
      for (const model of ['foreground', 'memory']) config = await api.config.saveProviderModel({ providerId, displayName: model,
        model, parameters: {}, parameterPresetMode: 'none', parameterPresets: [], capabilities: { toolUse: true, vision: false }, stream: false,
        maxContextTokens: 64000, maxOutputTokens: 4096, contextCompressionEnabled: false, contextCompressionThreshold: 0.8 })
      const models = config.providers.find(item => item.id === providerId).models
      const triggerProject = await api.projects.create({ kind: 'simple_chat', name: 'Other chats', prompt: '' })
      if (triggerProject.status !== 'ok') throw new Error(JSON.stringify(triggerProject))
      return { foreground: models.find(item => item.model === 'foreground').id, memory: models.find(item => item.model === 'memory').id,
        triggerProjectId: triggerProject.value.id }
    }, { port: server.address().port, workspace })
    const submitted = await page.evaluate(modelConfigId => globalThis.gale.agent.runs.submit({ requestId: crypto.randomUUID(),
      newThread: { projectId: 'default-workspace', title: 'Memory source', modelConfigId }, text: '以后请用中文回答。' }), models.foreground)
    await expect.poll(() => page.evaluate(async id => (await globalThis.gale.agent.threads.get(id)).thread.status, submitted.thread.id)).toBe('idle')
    assert.equal((await page.evaluate(() => globalThis.gale.preferences.activity())).status, 'unconfigured')
    assert.equal(requests.length, 1)
    await page.evaluate(memoryModelId => globalThis.gale.config.updateSettings({ memoryModelId }), models.memory)
    const openNewChat = () => page.evaluate(({ foreground, triggerProjectId }) => globalThis.gale.agent.runs.submit({
      requestId: crypto.randomUUID(), newThread: { projectId: triggerProjectId, modelConfigId: foreground }, text: 'New chat'
    }), models)
    await page.evaluate(threadId => globalThis.gale.agent.runs.submit({ requestId: crypto.randomUUID(), threadId, text: 'second turn' }), submitted.thread.id)
    await expect.poll(() => page.evaluate(async id => (await globalThis.gale.agent.threads.get(id)).thread.status, submitted.thread.id)).toBe('idle')
    await page.evaluate(async threadId => {
      await globalThis.gale.agent.workspace.set({ mode: 'new_thread', projectId: 'default-workspace', modelParameterPresetId: null })
      await globalThis.gale.agent.workspace.set({ mode: 'thread', threadId })
    }, submitted.thread.id)
    await new Promise(resolve => setTimeout(resolve, 3500))
    assert.equal(requests.filter(input => input.model === 'memory').length, 0)
    const existingB = (await openNewChat()).thread.id
    await expect.poll(() => Boolean(releaseExtraction), { timeout: 20000 }).toBe(true)
    assert.ok(JSON.stringify(requests.find(input => input.model === 'memory').messages).includes('second turn'))
    await expect(page.locator('.memory-activity-spinning')).toBeVisible()
    await page.getByRole('button', { name: /^Memory activity/ }).click()
    const sidebar = await panelPage(application, 'memory')
    await expect(sidebar.locator('.memory-activity-panel')).toContainText('Memory source')
    const shortcut = page.getByRole('button', { name: /^Memory activity/ })
    const checkbox = { name: 'Title bar button', exact: true }
    await expect(sidebar.getByRole('checkbox', checkbox)).toBeChecked()
    assert.ok(await sidebar.getByRole('checkbox', checkbox).evaluate(input => {
      const label = input.closest('label'), panel = input.closest('.memory-activity-panel')
      const contentRight = panel.getBoundingClientRect().left + panel.clientWidth - parseFloat(globalThis.getComputedStyle(panel).paddingRight)
      return Math.abs(contentRight - label.getBoundingClientRect().right) <= 1
    }))
    await sidebar.getByRole('checkbox', checkbox).uncheck()
    await expect(shortcut).toHaveCount(0)
    const viewId = await page.evaluate(async () => (await globalThis.gale.panels.list()).find(view => view.content.kind === 'memory').viewId)
    await page.evaluate(id => globalThis.gale.panels.move(id, 'window'), viewId)
    const detached = await panelPage(application, 'memory', 'window')
    await expect(detached.locator('.memory-activity-panel')).toContainText('Memory source')
    await expect(detached.getByRole('checkbox', checkbox)).not.toBeChecked()
    await detached.getByRole('checkbox', checkbox).check()
    await expect(shortcut).toBeVisible()
    await detached.getByRole('checkbox', checkbox).uncheck()
    await expect(shortcut).toHaveCount(0)
    await page.evaluate(id => globalThis.gale.panels.close(id), viewId)
    await page.evaluate(setProjectMemoryEnabled, false)
    releaseExtraction(); releaseExtraction = undefined
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.preferences.activity()).job?.stage)).toBe('cancelled')
    assert.equal(requests.filter(input => input.model === 'memory').length, 1)
    await page.evaluate(setProjectMemoryEnabled, true)
    await openNewChat()
    await expect.poll(() => Boolean(releaseExtraction), { timeout: 40000 }).toBe(true)
    releaseExtraction(); releaseExtraction = undefined
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.preferences.activity()).job?.stage), { timeout: 20000 }).toBe('completed')
    assert.equal(requests.filter(input => input.model === 'memory').length, 3)
    assert.equal(await readFile(join(root, 'profile/db/MEMORY.md'), 'utf8'), '- 用中文回答。\n')
    await page.getByRole('button', { name: 'Workspace menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Memory activity', exact: true }).click()
    const completed = await panelPage(application, 'memory')
    await expect(completed.getByRole('checkbox', checkbox)).not.toBeChecked()
    await completed.getByRole('checkbox', checkbox).check()
    await expect(shortcut).toBeVisible()
    const published = completed.locator('.memory-activity-panel section').filter({ has: completed.getByRole('heading', { name: 'Global preferences', exact: true }) })
    await expect(published.getByRole('listitem')).toHaveText('用中文回答。')
    await expect(completed.locator('.memory-activity-panel')).toContainText('260 total (2/2 calls reported)')
    await mkdir(resolve('tmp'), { recursive: true })
    await page.screenshot({ path: resolve('tmp/memory-activity-e2e.png') })
    await completed.screenshot({ path: resolve('tmp/memory-panel-e2e.png') })
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="tools"]').click()
    await page.getByRole('button', { name: 'update_memory: View tool definition' }).click()
    const definition = page.getByRole('dialog', { name: 'update_memory' }).locator('pre')
    await expect(definition).toBeVisible()
    const displayedMemoryTool = JSON.parse(await definition.textContent())
    await page.keyboard.press('Escape')
    await page.locator('[data-settings-tab="chatMode"]').click()
    const picker = page.locator('.settings-page-header').getByRole('button', { name: /^Background memory model/ })
    await expect(picker).toHaveCount(0)
    await page.locator('[data-settings-tab="memory"]').click()
    await expect(picker).toHaveText('memory')
    await page.getByRole('radiogroup', { name: 'Memory mode' }).getByText('Foreground memory', { exact: true }).click()
    await expect(picker).toHaveText('memory')
    await picker.click()
    await page.getByRole('menuitemradio', { name: /Not selected/ }).click()
    await expect(picker).toHaveText('No model selected — background memory paused')
    await picker.click()
    await page.getByRole('menuitem', { name: 'Memory fixture', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^memory$/i }).click()
    await expect(picker).toHaveText('memory')
    await page.getByRole('radiogroup', { name: 'Memory mode' }).getByText('Background extraction', { exact: true }).click()
    await expect(picker).toHaveText('memory')
    await expect(page.locator('.settings-content')).toContainText('用中文回答。')
    await expect(page.locator('.settings-content textarea')).toHaveCount(0)
    const global = page.locator('.settings-group').filter({ has: page.getByRole('heading', { name: 'Global memory' }) })
    await global.getByRole('button', { name: 'Edit' }).click()
    const editor = global.getByRole('region', { name: 'MEMORY.md' })
    const mainWindow = await application.browserWindow(page)
    const [mainWidth, mainHeight] = await mainWindow.evaluate(win => win.getContentSize())
    await expect(editor.locator('.monaco-editor')).toBeVisible()
    const initialEditorHeight = (await editor.locator('.monaco-editor').boundingBox()).height
    for (const height of [mainHeight + 160, mainHeight - 120, mainHeight]) {
      await mainWindow.evaluate((win, [w, h]) => win.setContentSize(w, h), [mainWidth, height])
      if (height > mainHeight) {
        await expect.poll(async () => (await editor.locator('.monaco-editor').boundingBox()).height).toBeGreaterThan(initialEditorHeight + 100)
      }
      await expect.poll(() => global.evaluate(group => {
        const pane = group.closest('.settings-content')
        pane.scrollTop = pane.scrollHeight
        const padding = parseFloat(globalThis.getComputedStyle(pane).paddingBottom)
        return Math.abs(globalThis.innerHeight - group.querySelector('.settings-card').getBoundingClientRect().bottom - padding)
      })).toBeLessThanOrEqual(2)
      if (height < mainHeight) await page.screenshot({ path: resolve('tmp/global-memory-edit-inset-e2e.png') })
    }
    await editor.locator('.monaco-editor .view-lines').click()
    await page.keyboard.press('ControlOrMeta+a')
    const markdown = '# Preferences\n\n- Edited global preference'
    await page.keyboard.insertText(markdown)
    await editor.getByRole('button', { name: 'Maximize editor' }).click()
    const expanded = page.getByRole('dialog', { name: 'MEMORY.md' })
    await expect(expanded.locator('.view-lines')).toContainText('Edited global preference')
    await expanded.locator('.view-lines').click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(expanded.locator('.view-lines')).not.toContainText('Edited global preference')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(expanded.locator('.view-lines')).toContainText('Edited global preference')
    await expanded.getByRole('button', { name: 'Restore editor size' }).click()
    await expect(editor.locator('.view-lines')).toContainText('Edited global preference')
    await page.locator('[data-settings-tab="chatMode"]').click()
    await page.locator('[data-settings-tab="memory"]').click()
    await expect(editor.locator('.view-lines')).toContainText('Edited global preference')
    await page.screenshot({ path: resolve('tmp/memory-editor-e2e.png') })
    await editor.getByRole('button', { name: 'Save' }).click()
    await expect(global.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible()
    assert.equal(await readFile(join(root, 'profile/db/MEMORY.md'), 'utf8'), markdown)
    async function expectGlobalViewerToFill(selector) {
      await expect.poll(() => global.evaluate((group, selector) => {
        const pane = group.closest('.settings-content')
        const card = group.querySelector('.settings-card')
        const view = group.querySelector(selector).getBoundingClientRect()
        const outerBottom = globalThis.innerHeight - parseFloat(globalThis.getComputedStyle(pane).paddingBottom)
        const cardBottom = card.getBoundingClientRect().bottom
        const innerBottom = cardBottom - parseFloat(globalThis.getComputedStyle(card.firstElementChild).paddingBottom)
        return Math.max(Math.abs(cardBottom - outerBottom), Math.abs(view.bottom - innerBottom))
      }, selector)).toBeLessThanOrEqual(3)
    }
    await expectGlobalViewerToFill('.settings-package-markdown')
    const previewHeight = (await global.boundingBox()).height
    await global.getByText('Source', { exact: true }).click()
    await expect(global.locator('.monaco-editor .view-lines')).toContainText('#')
    await expectGlobalViewerToFill('.monaco-editor')
    const sourceHeight = (await global.boundingBox()).height
    assert.ok(Math.abs(sourceHeight - previewHeight) <= 1, `Memory group grew from ${previewHeight}px to ${sourceHeight}px`)
    await mainWindow.evaluate((win, [w, h]) => win.setContentSize(w, h + 120), [mainWidth, mainHeight])
    await expect.poll(async () => (await global.boundingBox()).height).toBeGreaterThan(sourceHeight + 90)
    await expectGlobalViewerToFill('.monaco-editor')
    await global.getByText('Preview', { exact: true }).click()
    await expectGlobalViewerToFill('.settings-package-markdown')
    await mainWindow.evaluate((win, size) => win.setContentSize(...size), [mainWidth, mainHeight])
    await expectGlobalViewerToFill('.settings-package-markdown')
    await page.screenshot({ path: resolve('tmp/memory-settings-e2e.png') })
    await picker.click()
    await page.getByRole('menuitemradio', { name: /Not selected/ }).click()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.preferences.activity()).status)).toBe('unconfigured')
    await expect(picker).toHaveText('No model selected — background memory paused')
    await page.screenshot({ path: resolve('tmp/memory-model-paused-e2e.png') })
    await picker.click()
    await page.getByRole('menuitem', { name: 'Memory fixture', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^memory$/i }).click()
    await expect(picker).toHaveText('memory')
    await expect(global.getByRole('listitem')).toHaveText('Edited global preference')
    const longMarkdown = Array.from({ length: 200 }, (_, i) => `- Preference ${i + 1}`).join('\n')
    await page.evaluate(saveFixtureMemory, { scope: { kind: 'global' }, content: longMarkdown })
    await expect(global.getByRole('listitem')).toHaveCount(200)
    const longHeight = (await global.boundingBox()).height
    assert.ok(await global.locator('.settings-package-markdown').evaluate(el => el.scrollHeight > el.clientHeight))
    await global.getByText('Source', { exact: true }).click()
    const source = global.locator('.monaco-editor .view-lines')
    await expect(source).toContainText('Preference')
    assert.ok(Math.abs((await global.boundingBox()).height - longHeight) <= 1)
    await source.click()
    await page.keyboard.press('ControlOrMeta+End')
    await expect(source).toContainText('200')
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.getByRole('button', { name: 'Workspace menu' }).click()
    await page.getByRole('menuitem', { name: 'Project memory', exact: true }).click()
    const projectSidebar = (await panelPage(application, 'projectMemory')).locator('.project-memory-panel')
    await expect(projectSidebar.getByText('No consolidated preferences yet.')).toBeVisible()
    await expectPanelBodyToFill(projectSidebar, '.ui-empty-state')
    await projectSidebar.getByRole('button', { name: 'Edit', exact: true }).click()
    await projectSidebar.locator('.monaco-editor .view-lines').click()
    const projectText = '# Project-only preference'
    await page.keyboard.insertText(projectText)
    const projectPanelId = await page.evaluate(async () => (await globalThis.gale.panels.list()).find(view => view.content.kind === 'projectMemory').viewId)
    await page.evaluate(id => globalThis.gale.panels.close(id), projectPanelId)
    await expect(projectSidebar.locator('.view-lines')).toContainText('Project-only')
    await page.evaluate(id => globalThis.gale.panels.move(id, 'window'), projectPanelId)
    const projectWindow = await panelPage(application, 'projectMemory', 'window')
    const projectEditor = projectWindow.locator('.project-memory-panel')
    await expect(projectEditor.locator('.view-lines')).toContainText('Project-only')
    await page.evaluate(id => globalThis.gale.panels.close(id), projectPanelId)
    await expect(projectEditor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    const unsavedNotice = projectWindow.locator('.notice-toast').filter({ hasText: 'Project memory has unsaved changes' })
    await unsavedNotice.getByRole('button', { name: 'Close' }).click()
    await projectEditor.getByRole('button', { name: 'Maximize editor' }).click()
    const projectExpanded = projectWindow.getByRole('dialog', { name: 'MEMORY.md' })
    await expect(projectExpanded.locator('.view-lines')).toContainText('Project-only')
    await projectExpanded.getByRole('button', { name: 'Restore editor size' }).click()
    await projectWindow.screenshot({ path: resolve('tmp/project-memory-window-e2e.png') })
    await projectEditor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(projectEditor.getByRole('heading', { name: 'Project-only preference' })).toBeVisible()
    assert.equal(await readFile(join(root, 'profile/db/projects/default-workspace/MEMORY.md'), 'utf8'), projectText)
    assert.equal(await readFile(join(root, 'profile/db/MEMORY.md'), 'utf8'), longMarkdown)
    async function expectPanelBodyToFill(panel, selector) {
      await expect(panel.locator(selector)).toBeVisible()
      await expect.poll(() => panel.evaluate((el, selector) => {
        const body = el.querySelector(selector).getBoundingClientRect()
        const availableBottom = el.getBoundingClientRect().bottom - parseFloat(globalThis.getComputedStyle(el).paddingBottom)
        return Math.abs(body.bottom - availableBottom)
      }, selector)).toBeLessThanOrEqual(2)
    }
    await expectPanelBodyToFill(projectEditor, '.settings-package-markdown')
    await projectEditor.getByText('Source', { exact: true }).click()
    await expectPanelBodyToFill(projectEditor, '.monaco-editor')
    const initialPanelHeight = (await projectEditor.boundingBox()).height
    const nativeWindow = await application.browserWindow(projectWindow)
    await nativeWindow.evaluate(win => win.setContentSize(600, 420))
    await expect.poll(async () => (await projectEditor.boundingBox()).height).toBeLessThan(initialPanelHeight)
    await expectPanelBodyToFill(projectEditor, '.monaco-editor')
    await projectEditor.getByText('Preview', { exact: true }).click()
    await expectPanelBodyToFill(projectEditor, '.settings-package-markdown')
    await projectWindow.screenshot({ path: resolve('tmp/project-memory-preview-window-e2e.png') })
    await projectEditor.getByText('Source', { exact: true }).click()
    await expectPanelBodyToFill(projectEditor, '.monaco-editor')
    await projectWindow.screenshot({ path: resolve('tmp/project-memory-source-window-e2e.png') })
    await page.evaluate(id => globalThis.gale.panels.move(id, 'sidebar'), projectPanelId)
    await expectPanelBodyToFill(projectSidebar, '.monaco-editor')
    await projectSidebar.getByText('Preview', { exact: true }).click()
    await expect(projectSidebar.getByRole('heading', { name: 'Project-only preference' })).toBeVisible()
    await expectPanelBodyToFill(projectSidebar, '.settings-package-markdown')
    await page.screenshot({ path: resolve('tmp/project-memory-sidebar-e2e.png') })
    await page.evaluate(saveFixtureMemory, { scope: { kind: 'project', projectId: 'default-workspace' }, content: longMarkdown })
    await expect(projectSidebar.getByRole('listitem')).toHaveCount(200)
    await expectPanelBodyToFill(projectSidebar, '.settings-package-markdown')
    await projectSidebar.getByRole('listitem').last().scrollIntoViewIfNeeded()
    assert.ok(await projectSidebar.locator('.settings-package-markdown').evaluate(el => el.scrollTop > 0))
    await page.evaluate(id => globalThis.gale.panels.close(id), projectPanelId)
    await expect(projectSidebar).toHaveCount(0)
    await page.evaluate(threadId => globalThis.gale.agent.workspace.set({ mode: 'thread', threadId }), submitted.thread.id)
    for (const label of ['first', 'second']) {
      await page.evaluate(({ threadId, label }) => globalThis.gale.agent.runs.submit({ requestId: crypto.randomUUID(), threadId,
        text: 'follow-up evidence ' + label + ' ' + 'x'.repeat(35_000) }), { threadId: submitted.thread.id, label })
      await expect.poll(() => page.evaluate(async id => (await globalThis.gale.agent.threads.get(id)).thread.status, submitted.thread.id)).toBe('idle')
    }
    const beforeBatches = requests.filter(input => input.model === 'memory').length
    await page.evaluate(threadId => globalThis.gale.agent.workspace.set({ mode: 'thread', threadId }), existingB)
    await assert.rejects(page.evaluate(({ threadId, path }) => globalThis.gale.agent.runs.submit({
      requestId: crypto.randomUUID(), threadId, text: 'Check attachment',
      attachments: [{ path, name: 'missing.txt', kind: 'text', mimeType: 'text/plain', size: 1, contextPolicy: 'conversation' }]
    }), { threadId: existingB, path: join(root, 'missing.txt') }))
    assert.equal(requests.filter(input => input.model === 'memory').length, beforeBatches)
    await page.evaluate(threadId => globalThis.gale.agent.runs.submit({ requestId: crypto.randomUUID(), threadId, text: 'Speaking in B again' }), existingB)
    await expect.poll(() => page.evaluate(async () => {
      const { job } = await globalThis.gale.preferences.activity()
      return job?.stage === 'completed' && job.input.includes('follow-up evidence second') && !job.input.includes('follow-up evidence first')
    }), { timeout: 40000 }).toBe(true)
    const batches = requests.filter(input => input.model === 'memory').slice(beforeBatches)
    assert.equal(batches.length, 2)
    assert.ok(JSON.stringify(batches[0].messages).includes('follow-up evidence first'))
    assert.ok(batches.every(input => !JSON.stringify(input.messages).includes('以后请用中文回答。')))
    await page.getByRole('button', { name: /^Memory activity/ }).click()
    const latest = await panelPage(application, 'memory')
    await expect(latest.locator('.memory-activity-panel')).toContainText('No usage reported by the model')
    await expect(latest.locator('.memory-activity-panel')).not.toContainText('260 total')
    const backgroundCount = requests.filter(input => input.model === 'memory').length
    await page.evaluate(() => globalThis.gale.config.updateSettings({ memoryMode: 'foreground' }))
    for (const scope of ['global', 'project']) {
      await page.evaluate(({ threadId, scope }) => globalThis.gale.agent.runs.submit({ requestId: crypto.randomUUID(), threadId,
        text: 'foreground preference fixture ' + scope + ' scope' }), { threadId: submitted.thread.id, scope })
      await expect.poll(() => page.evaluate(async id => (await globalThis.gale.agent.threads.get(id)).thread.status, submitted.thread.id)).toBe('idle')
      assert.equal((await page.evaluate(scope => globalThis.gale.preferences.read(scope === 'global' ? { kind: scope } : { kind: scope, projectId: 'default-workspace' }), scope)).content, '- Foreground ' + scope)
    }
    const memoryDeclaration = requests.flatMap(input => input.tools ?? []).find(tool => tool.function?.name === 'update_memory')
    assert.deepEqual(displayedMemoryTool, memoryDeclaration?.function)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ memoryMode: 'background' }))
    await openNewChat()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.preferences.activity()).status)).toBe('idle')
    assert.equal(requests.filter(input => input.model === 'memory').length, backgroundCount)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ memoryMode: 'foreground' }))
    await page.evaluate(threadId => globalThis.gale.agent.runs.submit({ requestId: crypto.randomUUID(), threadId,
      text: 'foreground preference fixture edit while running' }), submitted.thread.id)
    await expect.poll(() => Boolean(releaseForeground)).toBe(true)
    await page.evaluate(saveFixtureMemory, { scope: { kind: 'global' }, content: '- Edited during model request' })
    releaseForeground(); releaseForeground = undefined
    await expect.poll(() => page.evaluate(async id => (await globalThis.gale.agent.threads.get(id)).thread.status, submitted.thread.id)).toBe('idle')
    assert.equal((await page.evaluate(() => globalThis.gale.preferences.read({ kind: 'global' }))).content, '- Edited during model request')
    assert.match(JSON.stringify(requests.filter(input => input.model === 'foreground').at(-1).messages.at(-1)), /Preference memory changed/)
    await page.evaluate(threadId => globalThis.gale.agent.runs.submit({ requestId: crypto.randomUUID(), threadId,
      text: 'foreground preference fixture switch while running' }), submitted.thread.id)
    await expect.poll(() => Boolean(releaseForeground)).toBe(true)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ memoryMode: 'background' }))
    releaseForeground(); releaseForeground = undefined
    await expect.poll(() => page.evaluate(async id => (await globalThis.gale.agent.threads.get(id)).thread.status, submitted.thread.id)).toBe('idle')
    const nextRound = requests.filter(input => input.model === 'foreground').at(-1)
    assert.ok(!nextRound.tools?.some(tool => tool.function?.name === 'update_memory'))
    assert.match(JSON.stringify(nextRound.messages[0]), /Preference memory updates run in the background/)
    assert.doesNotMatch(JSON.stringify(nextRound.messages[0]), /Use update_memory/)
    assert.ok(JSON.stringify(nextRound.messages.at(-1)).includes('Foreground memory is disabled'))
    assert.deepEqual(errors, [])
    console.log('Memory Electron E2E passed: background extraction, foreground tool writes, incremental resume, live prompt and tool switching, activity panels and Markdown editing.')
  } finally {
    releaseForeground?.(); releaseExtraction?.()
    await closeElectronTestApplication(application)
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}
module.exports = { verifyBackgroundMemory }
