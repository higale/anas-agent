const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')
const { expect } = require('playwright/test')
const { panelPage } = require('./electron-panel-helpers.cjs')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function verifyUnifiedPanels() {
  const repository = resolve(__dirname, '..')
  const root = await mkdtemp(join(tmpdir(), 'anas-panels-e2e-'))
  let application
  try {
    await mkdir(join(root, 'documents'))
    await symlink(join(repository, 'data'), join(root, 'data'), 'junction')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'anas-panels-test', version: '1.0.0', main: 'main.cjs' }))
    // Test-only access to the real storage and event publisher, with no production hooks.
    await writeFile(join(root, 'main.cjs'), `
      const { app, dialog, ipcMain } = require('electron')
      const handle = ipcMain.handle.bind(ipcMain)
      ipcMain.handle = (channel, callback) => handle(channel, async (...args) => {
        if (channel === 'app:readHelp' && globalThis.__pauseHelp) {
          globalThis.__pauseHelp = false
          globalThis.__helpPending = true
          await new Promise(resolve => { globalThis.__releaseHelp = resolve })
        }
        return callback(...args)
      })
      dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1) }
      const Module = require('node:module')
      app.setPath('documents', ${JSON.stringify(join(root, 'documents'))})
      const compiledRoot = ${JSON.stringify(join(repository, 'out/main'))}
      const originalCompile = Module.prototype._compile
      Module.prototype._compile = function(content, filename) {
        if (filename.startsWith(compiledRoot) && content.includes('function currentStorage()')) {
          content += '\\n;globalThis.__panelFixture = { currentStorage, currentDatabase, publishAgentEvent, nativeRequire: require };'
        }
        return originalCompile.call(this, content, filename)
      }
      require(${JSON.stringify(join(repository, 'out/main/index.js'))})
      Module.prototype._compile = originalCompile
    `)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    application = await electron.launch({ executablePath: require('electron'), args: [root, '--data-dir', join(root, 'profile')], cwd: repository, env, timeout: 45000 })
    application.process().stderr.on('data', chunk => { if (/Error|failed/i.test(String(chunk))) console.error(String(chunk).trim()) })
    const errors = []
    application.context().on('page', page => page.on('pageerror', error => errors.push(String(error))))
    const main = await application.firstWindow()
    main.setDefaultTimeout(15000)
    await main.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    await main.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en', theme: 'dark', workspacePanelWidth: 480 }))
    await mkdir(join(root, 'alternate'))
    await main.evaluate(async folder => {
      const defaults = (await globalThis.gale.projects.list()).find(project => project.id === 'default-workspace')
      const result = await globalThis.gale.projects.create({ ...defaults, name: 'Panel alternate', sourceFolders: [folder] })
      if (result.status !== 'ok') throw new Error(JSON.stringify(result))
    }, join(root, 'alternate'))
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 800))
    const fixture = await application.evaluate(async () => {
      const { currentStorage } = globalThis.__panelFixture
      const storage = currentStorage()
      const thread = storage.createThread({ title: 'Panel origin', projectId: 'default-workspace' })
      const other = storage.createThread({ title: 'Another conversation', projectId: 'default-workspace' })
      const db = storage.conversationForThread(thread.id)
      const run = db.createRun(thread.id)
      const { emptyCheckpoint } = globalThis.__panelFixture.nativeRequire('@langchain/langgraph-checkpoint')
      db.checkpointer.retainRun(run.id, thread.id)
      const checkpoint = emptyCheckpoint()
      checkpoint.channel_values = { messages: [], anasRunLifecycle: { runId: run.id, status: 'completed' } }
      checkpoint.channel_versions = { messages: 1, anasRunLifecycle: 1 }
      await db.checkpointer.put({ configurable: { thread_id: thread.id } }, checkpoint, { source: 'loop', step: 0, parents: {} })
      db.finishRun(run.id, 'completed')
      await db.checkpointer.releaseRun(run.id)
      db.recordSubagentActivity(run.id, 'child', 'Panel child', 'completed')
      for (let index = 0; index < 120; index++) db.recordSubagentActivity(run.id, `other-${index}`, `Other child ${index}`, 'completed')
      storage.refreshConversation(thread.id)
      return { threadId: thread.id, otherId: other.id, runId: run.id, projectId: thread.projectId }
    })
    await main.reload()
    await main.locator('[data-agent-composer-input]').waitFor()

    for (const content of [
      { kind: 'document', documentId: 'USER_GUIDE.en.md' },
      { kind: 'files', projectId: fixture.projectId, threadId: fixture.threadId },
      { kind: 'subagent', projectId: fixture.projectId, threadId: fixture.threadId, runId: fixture.runId, subagentId: 'child', name: 'Panel child' }
    ]) {
      console.log('Checking panel', content.kind)
      await main.evaluate(content => globalThis.gale.panels.open(content), content)
      const source = await panelPage(application, content.kind)
      const state = (await main.evaluate(() => globalThis.gale.panels.pages.list())).find(item => item.view.content.kind === content.kind)
      if (content.kind === 'document') {
        await expect(source.locator('.ui-document-panel h1')).toBeVisible()
        await source.locator('.ui-document-panel').evaluate(node => { node.scrollTop = 300; node.dispatchEvent(new Event('scroll')) })
      }
      if (content.kind === 'subagent') await expect(source.locator('.agent-subagent-panel-title')).toContainText('Panel child')
      for (let round = 0; round < 2; round++) {
        console.log('Moving', content.kind, round)
        await expect(main.getByRole('button', { name: 'Move to window', exact: true })).toHaveCount(0)
        await main.locator(`[role="tab"][data-panel-id="${state.panelId}"]`).click({ button: 'right' })
        await main.getByRole('menuitem', { name: 'Move to window', exact: true }).click()
        const target = await panelPage(application, content.kind, 'window')
        const page = (await target.evaluate(() => globalThis.panelWindow.pages.list()))[0]
        assert.notEqual(page.pageId, state.pageId)
        assert.equal(page.panelId, state.panelId)
        assert.equal(await target.evaluate(() => typeof globalThis.gale), 'undefined')
        const header = await target.locator('.panel-window-titlebar').boundingBox()
        const body = await target.locator('.panel-window-slot').boundingBox()
        assert.ok(header.height >= 36 && body.y >= header.y + header.height)
        if (content.kind === 'document') await expect.poll(() => target.locator('.ui-document-panel').evaluate(node => node.scrollTop)).toBeGreaterThan(280)
        await target.evaluate(() => { void globalThis.panelWindow.moveToSidebar() })
        await panelPage(application, content.kind)
        await expect.poll(() => target.isClosed()).toBe(true)
      }
      await main.evaluate(id => globalThis.gale.panels.close(id), state.panelId)
    }
    // A target may finish loading after the user selects another retained tab.
    await main.evaluate(() => globalThis.gale.panels.open({ kind: 'document', documentId: 'USER_GUIDE.zh-CN.md' }))
    await main.evaluate(() => globalThis.gale.panels.open({ kind: 'document', documentId: 'USER_GUIDE.en.md' }))
    const documents = await main.evaluate(() => globalThis.gale.panels.list())
    const english = documents.find(view => view.content.documentId === 'USER_GUIDE.en.md')
    const chinese = documents.find(view => view.content.documentId === 'USER_GUIDE.zh-CN.md')
    const reader = main.locator(`[data-panel-view="${english.viewId}"] .ui-document-panel`)
    await reader.evaluate(node => { node.scrollTop = 300; node.dispatchEvent(new Event('scroll')) })
    await main.evaluate(id => globalThis.gale.panels.move(id, 'window'), english.viewId)
    const detached = await panelPage(application, 'document', 'window')
    await application.evaluate(() => { globalThis.__pauseHelp = true })
    await detached.evaluate(() => { void globalThis.panelWindow.moveToSidebar() })
    await expect.poll(() => application.evaluate(() => globalThis.__helpPending)).toBe(true)
    await main.locator(`[role="tab"][data-panel-id="${chinese.viewId}"]`).click()
    await application.evaluate(() => { globalThis.__releaseHelp() })
    await expect.poll(() => detached.isClosed()).toBe(true)
    await main.locator(`[role="tab"][data-panel-id="${english.viewId}"]`).click()
    await expect.poll(() => reader.evaluate(node => node.scrollTop)).toBeGreaterThan(280)
    await main.evaluate(ids => Promise.all(ids.map(id => globalThis.gale.panels.close(id))), [english.viewId, chinese.viewId])

    const plugin = join(root, 'plugin')
    await mkdir(plugin)
    await writeFile(join(plugin, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'handoff-test', name: 'Handoff test', plugin_version: '1.0.0', api_version: 2, ui: 'index.html' }))
    await writeFile(join(plugin, 'index.html'), '<html><body><textarea id="draft"></textarea><script src="/_anas/sdk.js"></script><script type="module" src="app.js"></script></body></html>')
    await writeFile(join(plugin, 'app.js'), `
      const page = await anas.getContext();
      const draft = document.getElementById('draft');
      draft.value = page.restoreState?.draft ?? '';
      globalThis.identity = crypto.randomUUID();
      anas.registerLifecycle({
        prepare: async () => ({ draft: draft.value }),
        activate: async () => { if (draft.value === 'fail-restore') throw new Error('requested failure'); },
        resume: async () => {}, dispose: async () => {}
      });
      await anas.ready();
    `)
    await application.evaluate(({ dialog }, path) => {
      globalThis.__originalDialog = dialog.showOpenDialog
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, join(plugin, 'PLUGIN.json'))
    await main.evaluate(() => globalThis.gale.plugins.install())
    await application.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__originalDialog })
    await main.evaluate(() => globalThis.gale.plugins.invoke('handoff-test', 'host.openView', { instanceId: 'main', location: 'sidebar' }))
    const currentFrame = page => page.frames().find(frame => frame.url().startsWith('anas-plugin://handoff-test/'))
    const source = currentFrame(main)
    await expect(source.locator('#draft')).toBeVisible()
    const view = (await main.evaluate(() => globalThis.gale.panels.list())).find(view => view.content.pluginId === 'handoff-test')
    const identity = await source.evaluate(() => globalThis.identity)
    await source.locator('#draft').fill('unsaved edit')
    await main.evaluate(() => globalThis.gale.panels.open({ kind: 'document', documentId: 'USER_GUIDE.en.md' }))
    await main.getByRole('tab', { name: 'Handoff test' }).click()
    assert.equal(await source.evaluate(() => globalThis.identity), identity, 'Tab switch must preserve the iframe.')
    await expect(source.locator('#draft')).toHaveValue('unsaved edit')
    await main.getByRole('tab', { name: 'Handoff test' }).hover()
    await expect(main.getByRole('tooltip')).toBeVisible()
    await expect(source.locator('#draft')).toBeVisible()
    await main.getByRole('tab', { name: 'Handoff test' }).click({ button: 'right' })
    await expect(main.getByRole('menu')).toBeVisible()
    await expect(source.locator('#draft')).toBeVisible()
    await main.keyboard.press('Escape')
    await expect(main.locator('[role="menu"]')).toHaveCount(0)
    const tabs = main.getByRole('tab')
    const first = await main.getByRole('tab', { name: 'Handoff test' }).boundingBox()
    const last = await tabs.last().boundingBox()
    await main.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
    await main.mouse.down()
    await main.mouse.move(last.x + last.width - 3, last.y + last.height / 2, { steps: 10 })
    await expect(main.locator('.ui-tab-insertion-marker')).toBeVisible()
    await main.mouse.up()
    await expect(tabs.last()).toHaveAttribute('aria-label', 'Handoff test')
    for (let round = 0; round < 2; round++) {
      if (round === 0) {
        const tab = await main.getByRole('tab', { name: 'Handoff test' }).boundingBox()
        await main.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2)
        await main.mouse.down()
        await main.mouse.move(tab.x + tab.width / 2, tab.y + tab.height + 110, { steps: 10 })
        await main.mouse.up()
      } else {
        await main.getByRole('tab', { name: 'Handoff test' }).click({ button: 'right' })
        await main.getByRole('menuitem', { name: 'Move to window', exact: true }).click()
      }
      const target = await panelPage(application, 'plugin', 'window')
      const restored = currentFrame(target)
      await expect(restored.locator('#draft')).toHaveValue('unsaved edit')
      assert.notEqual(await restored.evaluate(() => globalThis.identity), identity)
      await target.evaluate(() => { void globalThis.panelWindow.moveToSidebar() })
      await panelPage(application, 'plugin')
      await expect(currentFrame(main).locator('#draft')).toHaveValue('unsaved edit')
    }
    await currentFrame(main).locator('#draft').fill('fail-restore')
    await assert.rejects(main.evaluate(id => globalThis.gale.panels.move(id, 'window'), view.viewId))
    await expect(currentFrame(main).locator('#draft')).toHaveValue('fail-restore')
    await expect(currentFrame(main).locator('#draft')).toBeEditable()
    assert.equal((await main.evaluate(() => globalThis.gale.panels.list())).find(item => item.viewId === view.viewId).location, 'sidebar')
    await main.evaluate(id => globalThis.gale.panels.close(id), view.viewId)
    assert.deepEqual(errors, [])
    console.log('Panel handoffs passed: built-ins, reading position, isolated iframe, drafts, retained tabs, DOM tooltip/menu, failure rollback, repeated moves and window cleanup.')
  } finally {
    await closeElectronTestApplication(application)
    await rm(root, { recursive: true, force: true })
  }
}
module.exports = { verifyUnifiedPanels }
