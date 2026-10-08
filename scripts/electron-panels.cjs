const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')
const { expect } = require('playwright/test')
const { panelPage, panelWindow, panelGeometry } = require('./electron-panel-helpers.cjs')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function verifyOpeningBeforePageLoad(application, main, fixture, root) {
  const source = join(root, 'opening-plugin')
  await mkdir(source)
  await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'opening-test', name: 'Opening test', plugin_version: '1.0.0', api_version: 1, ui: 'index.html' }))
  await writeFile(join(source, 'index.html'), '<html><body>Plugin ready</body></html>')
  await application.evaluate(({ dialog }, path) => {
    globalThis.__panelOriginalDialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, join(source, 'PLUGIN.json'))
  try { await main.evaluate(() => globalThis.gale.plugins.install()) }
  finally { await application.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__panelOriginalDialog; delete globalThis.__panelOriginalDialog }) }
  // Delay native content navigation itself; host windows and IPC keep running.
  await application.evaluate(({ app }) => {
    globalThis.__panelLoads = []
    globalThis.__holdPanelLoad = (_event, contents) => {
      const load = contents.loadURL.bind(contents)
      contents.loadURL = (url, ...args) => {
        if (!url.includes('panel-content.html') && !url.includes('opening-test')) return load(url, ...args)
        return new Promise((resolve, reject) => {
          globalThis.__panelLoads.push({ contentsId: contents.id,
            release: () => contents.isDestroyed() ? resolve() : load(url, ...args).then(resolve, reject) })
        })
      }
    }
    app.on('web-contents-created', globalThis.__holdPanelLoad)
  })
  const open = content => {
    globalThis.__openingResult = 'pending'
    const result = content.kind === 'plugin'
      ? globalThis.gale.plugins.invoke('opening-test', 'host.openView', { instanceId: 'main', location: 'sidebar' })
      : globalThis.gale.panels.open(content)
    void result.then(() => { globalThis.__openingResult = 'opened' }, error => { globalThis.__openingResult = String(error) })
  }
  const geometry = () => application.evaluate(({ BrowserWindow }) => {
    const contentsId = globalThis.__panelLoads.at(-1)?.contentsId
    for (const owner of BrowserWindow.getAllWindows()) for (const child of owner.contentView.children) {
      if (child.webContents?.id === contentsId) return { ...child.getBounds(), visible: child.getVisible() }
    }
    return null
  })
  try {
    for (const content of [
      { kind: 'document', documentId: 'USER_GUIDE.en.md' },
      { kind: 'files', projectId: fixture.projectId, threadId: fixture.threadId },
      { kind: 'subagent', projectId: fixture.projectId, threadId: fixture.threadId, runId: fixture.runId, subagentId: 'child', name: 'Panel child' },
      { kind: 'plugin' }
    ]) {
      await main.evaluate(open, content)
      const slot = main.locator(`[data-panel-kind="${content.kind}"]`)
      await expect(slot).toBeVisible()
      await expect(slot).toHaveAttribute('aria-busy', 'true')
      await expect(slot.getByRole('status')).toContainText('Loading')
      assert.equal(await main.evaluate(() => globalThis.__openingResult), 'pending')
      await expect.poll(async () => (await geometry())?.visible).toBe(false)
      const view = (await main.evaluate(() => globalThis.gale.panels.list()))[0]
      assert.equal(view.loading, true)
      assert.equal(view.pendingLocation, undefined)
      // Resizing before DOM readiness must update the attached page's geometry.
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 800))
      await expect.poll(async () => Math.abs((await geometry()).x - (await slot.boundingBox()).x)).toBeLessThan(2)
      await main.getByRole('button', { name: 'Hide right workspace', exact: true }).click()
      await expect(main.locator('.workspace-panels')).toHaveCount(0)
      await expect.poll(async () => (await main.evaluate(() => globalThis.gale.panels.list()))[0].sidebarVisible).toBe(false)
      await application.evaluate(() => globalThis.__panelLoads.at(-1).release())
      await expect.poll(() => main.evaluate(() => globalThis.__openingResult)).toBe('opened')
      await expect(main.locator('.workspace-panels')).toHaveCount(0)
      assert.equal((await geometry()).visible, false)
      await main.evaluate(open, content)
      await expect(slot).toBeVisible()
      await expect(slot).toHaveAttribute('aria-busy', 'false')
      await expect.poll(async () => (await geometry())?.visible).toBe(true)
      assert.equal((await main.evaluate(() => globalThis.gale.panels.list()))[0].viewId, view.viewId)
      await main.evaluate(id => globalThis.gale.panels.close(id), view.viewId)
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 800))
    }
    await main.evaluate(open, { kind: 'document', documentId: 'USER_GUIDE.en.md' })
    await expect(main.locator('[data-panel-kind="document"]')).toHaveAttribute('aria-busy', 'true')
    await main.locator('.ui-tab-close').click()
    await expect(main.locator('.workspace-panels')).toHaveCount(0)
    await expect.poll(() => main.evaluate(() => globalThis.__openingResult)).toContain('PANEL_CLOSED')
    await application.evaluate(() => globalThis.__panelLoads.at(-1).release())
    assert.deepEqual(await main.evaluate(() => globalThis.gale.panels.list()), [])
  } finally {
    await application.evaluate(({ app }) => {
      app.removeListener('web-contents-created', globalThis.__holdPanelLoad)
      delete globalThis.__holdPanelLoad
    })
    await main.evaluate(() => globalThis.gale.plugins.uninstall('opening-test'))
  }
}

async function verifyBuiltinInteractions(application, main, fixture) {
  const document = { kind: 'document', documentId: 'USER_GUIDE.en.md' }
  await main.evaluate(content => globalThis.gale.panels.open(content), document)
  const help = await panelPage(application, 'document')
  const helpId = (await help.evaluate(() => globalThis.panelContent.getState())).view.viewId
  await expect(help.locator('.ui-document-panel h1')).toBeVisible()
  const checkZoom = async () => {
    const { ownerId, contentsId } = await panelGeometry(application, help)
    const zoom = () => application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.getZoomFactor(), ownerId)
    const press = keyCode => application.evaluate(({ webContents }, { contentsId, keyCode }) => {
      const contents = webContents.fromId(contentsId)
      contents.focus()
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] })
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control'] })
    }, { contentsId, keyCode })
    await help.locator('.ui-document-panel h1').click()
    await press('=')
    await expect.poll(zoom).toBeGreaterThan(1)
    await press('0')
    await expect.poll(zoom).toBe(1)
    // The zoom HUD can overlap the drawer after resizing. CDP would otherwise
    // dispatch keys even while the host has hidden this native page.
    await expect(main.locator('.zoom-hud')).toHaveCount(0)
    await expect.poll(async () => (await panelGeometry(application, help))?.visible).toBe(true)
  }
  const checkContextMenu = async () => {
    await application.evaluate(({ Menu }) => {
      globalThis.__originalPanelPopup = Menu.prototype.popup
      globalThis.__panelMenu = undefined
      Menu.prototype.popup = function(options) {
        globalThis.__panelMenu = { owner: options.window.id, frameUrl: options.frame.url,
          roles: this.items.map(item => item.role || item.type), copyEnabled: this.items.find(item => item.role === 'copy')?.enabled }
      }
    })
    try {
      await help.locator('.ui-document-panel h1').evaluate(heading => {
        const range = document.createRange(); range.selectNodeContents(heading)
        globalThis.getSelection().removeAllRanges(); globalThis.getSelection().addRange(range)
      })
      await help.locator('.ui-document-panel h1').click({ button: 'right' })
      await expect.poll(() => application.evaluate(() => globalThis.__panelMenu?.roles)).toEqual(['copy', 'separator', 'selectall'])
      const menu = await application.evaluate(() => globalThis.__panelMenu)
      assert.equal(menu.owner, (await panelGeometry(application, help)).ownerId)
      assert.equal(menu.frameUrl, help.url())
      assert.equal(menu.copyEnabled, true)
    } finally {
      await application.evaluate(({ Menu }) => { Menu.prototype.popup = globalThis.__originalPanelPopup; delete globalThis.__originalPanelPopup })
    }
  }
  await checkContextMenu()
  await checkZoom()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
  await expect(main.locator('.workspace-panels-drawer')).toBeVisible()
  // DOM visibility precedes the resized native slot; CDP can otherwise target
  // content that is still clipped or hidden by the host.
  await expect.poll(async () => (await panelGeometry(application, help))?.visible).toBe(true)
  await help.getByRole('button', { name: 'Contents', exact: true }).click()
  await expect(help.locator('.ui-document-contents-popover')).toBeVisible()
  await help.keyboard.press('Escape')
  await expect(help.locator('.ui-document-contents-popover')).toHaveCount(0)
  await expect(main.locator('.workspace-panels-drawer')).toBeVisible()
  await expect.poll(async () => (await panelGeometry(application, help))?.visible).toBe(true)
  await help.locator('.ui-document-panel h1').click()
  await help.keyboard.press('Escape')
  await expect(main.locator('.workspace-panels-drawer')).toHaveCount(0)
  assert.equal(help.isClosed(), false)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 800))
  await main.evaluate(content => globalThis.gale.panels.open(content), document)
  await main.evaluate(id => globalThis.gale.panels.move(id, 'window'), helpId)
  await checkContextMenu()
  await checkZoom()

  await main.locator('.thread-open').filter({ hasText: 'Panel origin' }).click()
  await main.getByRole('button', { name: 'File changes', exact: true }).click()
  const first = await panelPage(application, 'files')
  const firstId = (await first.evaluate(() => globalThis.panelContent.getState())).view.viewId
  await main.evaluate(() => globalThis.gale.config.updateSettings({ fontSize: 18, diffViewMode: 'inline', diffWordWrap: false, diffFoldUnchanged: true }))
  const shell = await panelWindow(application, help)
  for (const page of [help, shell, first]) await expect.poll(() => page.evaluate(() => globalThis.getComputedStyle(document.documentElement).getPropertyValue('--font-size-base'))).toBe('18px')
  await first.getByRole('button', { name: 'Word wrap', exact: true }).waitFor()
  // Two in-flight saves from the same rendered state must preserve both fields.
  await first.evaluate(() => {
    document.querySelector('button[aria-label="Side by side"]').click()
    document.querySelector('button[aria-label="Word wrap"]').click()
  })
  const preferences = page => page.evaluate(async () => (await globalThis.panelContent.getState()).preferences)
  await expect.poll(() => preferences(first)).toEqual({ diffViewMode: 'side_by_side', diffWordWrap: true, diffFoldUnchanged: true })
  await main.evaluate(id => globalThis.gale.panels.move(id, 'window'), firstId)
  await expect(first.getByRole('button', { name: 'Word wrap', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(first.getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await main.locator('.thread-open').filter({ hasText: 'Another conversation' }).click()
  const state = () => first.evaluate(() => globalThis.panelContent.getState())
  await expect.poll(async () => (await state()).view.content.threadId).toBe(fixture.otherId)
  await main.getByRole('button', { name: 'File changes', exact: true }).click()
  assert.equal(await panelPage(application, 'files', 'window'), first)
  assert.equal((await state()).view.viewId, firstId)
  await expect(main.locator('[data-panel-kind="files"]')).toHaveCount(0)
  assert.equal((await main.evaluate(() => globalThis.gale.panels.list())).filter(view => view.content.kind === 'files').length, 1)
  await first.getByRole('button', { name: 'Fold unchanged regions', exact: true }).click()
  await expect.poll(() => preferences(first)).toEqual({ diffViewMode: 'side_by_side', diffWordWrap: true, diffFoldUnchanged: false })
  // Saves from settings and the content page still merge and broadcast.
  await Promise.all([
    main.evaluate(() => globalThis.gale.config.updateSettings({ diffViewMode: 'inline' })),
    first.getByRole('button', { name: 'Word wrap', exact: true }).click()
  ])
  await expect.poll(() => preferences(first)).toEqual({ diffViewMode: 'inline', diffWordWrap: false, diffFoldUnchanged: false })
  await first.keyboard.press('Escape')
  assert.equal((await state()).view.location, 'window')
  await main.getByRole('button', { name: 'New chat in Panel alternate', exact: true }).click()
  await expect.poll(async () => (await state()).project.name).toBe('Panel alternate')
  assert.equal((await state()).view.content.threadId, undefined)
  const filesShell = await panelWindow(application, first)
  await expect(filesShell.locator('.panel-window-titlebar')).toContainText('Panel alternate')
  await main.getByRole('button', { name: 'File changes', exact: true }).click()
  assert.equal(await panelPage(application, 'files', 'window'), first)
  await filesShell.getByRole('button', { name: 'Move to side panel', exact: true }).click()
  await panelPage(application, 'files')
  await expect(main.locator('.topbar').getByRole('button', { name: 'Show details for Panel alternate', exact: true })).toBeVisible()
  await main.locator('.thread-open').filter({ hasText: 'Panel origin' }).click()
  await expect(main.locator('[data-panel-kind="files"]')).toBeVisible()
  await expect.poll(async () => (await state()).view.content.threadId).toBe(fixture.threadId)
  await main.evaluate(content => globalThis.gale.panels.open(content), { kind: 'files', projectId: fixture.projectId, threadId: fixture.threadId, runId: fixture.runId })
  await expect(first.getByRole('button', { name: 'Comparison', exact: true })).toContainText('Run changes')
  await main.reload()
  await main.locator('[data-agent-composer-input]').waitFor()
  await expect.poll(async () => (await panelGeometry(application, first))?.visible).toBe(true)
  await expect(first.getByRole('button', { name: 'Comparison', exact: true })).toContainText('Run changes')
  await main.locator('.thread-open').filter({ hasText: 'Another conversation' }).click()
  await expect(first.getByRole('button', { name: 'Comparison', exact: true })).toContainText('Base → working tree')
  assert.equal((await state()).view.content.runId, undefined)
  assert.equal((await state()).view.viewId, firstId)
  // Review completion reloads the conversation list before opening its result.
  await application.evaluate(({ BrowserWindow }, fixture) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))
    main.webContents.send('panels:reviewStarted', fixture.threadId, { projectId: fixture.projectId, threadId: fixture.otherId })
  }, fixture)
  await expect(main.locator('.topbar')).toContainText('Panel origin')
  await main.evaluate(async () => {
    for (const view of await globalThis.gale.panels.list()) await globalThis.gale.panels.close(view.viewId)
    await globalThis.gale.config.updateSettings({ fontSize: 14, diffFoldUnchanged: true })
  })
}

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
      const { app } = require('electron')
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
    await verifyOpeningBeforePageLoad(application, main, fixture, root)
    await verifyBuiltinInteractions(application, main, fixture)

    for (const content of [
      { kind: 'document', documentId: 'USER_GUIDE.en.md' },
      { kind: 'files', projectId: fixture.projectId, threadId: fixture.threadId },
      { kind: 'subagent', projectId: fixture.projectId, threadId: fixture.threadId, runId: fixture.runId, subagentId: 'child', name: 'Panel child' }
    ]) {
      if (content.kind === 'files') await main.locator('.thread-open').filter({ hasText: 'Panel origin' }).click()
      await main.evaluate(content => globalThis.gale.panels.open(content), content)
      const page = await panelPage(application, content.kind)
      page.setDefaultTimeout(15000)
      assert.equal(await page.evaluate(() => typeof globalThis.gale), 'undefined', 'Content pages must not expose the full main-window API.')
      if (content.kind === 'document') await expect(page.getByRole('heading', { name: /user guide/i }).first()).toBeVisible()
      if (content.kind === 'files') await expect(page.getByRole('button', { name: 'Comparison', exact: true })).toBeVisible()
      if (content.kind === 'subagent') {
        await expect(page.locator('.agent-subagent-panel-title')).toContainText('Panel child')
        await page.getByRole('button', { name: 'Load earlier activities', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Load earlier activities', exact: true })).toHaveCount(0)
      }
      const geometry = await panelGeometry(application, page)
      const viewId = (await page.evaluate(() => globalThis.panelContent.getState())).view.viewId
      await page.evaluate(() => { globalThis.__panelDraft = 'retained'; globalThis.__panelUnloadCount = 0; globalThis.addEventListener('pagehide', () => globalThis.__panelUnloadCount++) })
      for (let round = 0; round < 2; round++) {
        await main.getByRole('button', { name: 'Move to window', exact: true }).click()
        await panelPage(application, content.kind, 'window')
        const shell = await panelWindow(application, page)
        assert.equal((await panelGeometry(application, page)).contentsId, geometry.contentsId)
        const header = await shell.locator('.panel-window-titlebar').boundingBox()
        const slot = await shell.locator('.panel-window-slot').boundingBox()
        assert.ok(header.height >= 36 && slot.y >= header.y + header.height)
        if (content.kind !== 'document') {
          await main.locator('.thread-open').filter({ hasText: 'Another conversation' }).click()
          await expect.poll(async () => (await page.evaluate(() => globalThis.panelContent.getState())).view.content.threadId)
            .toBe(content.kind === 'files' ? fixture.otherId : fixture.threadId)
        }
        if (content.kind === 'subagent') {
          await application.evaluate((_, fixture) => globalThis.__panelFixture.publishAgentEvent({ type: 'subagent_updated', threadId: fixture.threadId,
            runId: fixture.runId, subagent: { id: 'child', name: 'Panel child', sequence: 1, status: 'completed', result: 'Updated while detached' } }), fixture)
          await expect(page.locator('.agent-subagent-panel')).toContainText('Updated while detached')
        }
        await shell.getByRole('button', { name: 'Move to side panel', exact: true }).click()
        await panelPage(application, content.kind)
        assert.equal((await panelGeometry(application, page)).contentsId, geometry.contentsId)
        assert.deepEqual(await page.evaluate(() => [globalThis.__panelDraft, globalThis.__panelUnloadCount]), ['retained', 0])
        if (content.kind !== 'document') await expect(main.locator('.topbar')).toContainText(content.kind === 'files' ? 'Another conversation' : 'Panel origin')
      }
      await main.reload()
      await main.locator('[data-agent-composer-input]').waitFor()
      await expect.poll(async () => (await panelGeometry(application, page))?.visible).toBe(true)
      assert.equal((await panelGeometry(application, page)).contentsId, geometry.contentsId)
      await main.evaluate(id => globalThis.gale.panels.close(id), viewId)
      await expect.poll(() => page.isClosed()).toBe(true)
      const snapshot = await main.evaluate(id => globalThis.gale.agent.threads.get(id), fixture.threadId)
      assert.equal(snapshot.thread.id, fixture.threadId, 'Closing a view must retain its conversation and run.')
    }
    assert.deepEqual(errors, [])
    console.log('Unified panels passed: native text menus, Escape, live settings, concurrent diff saves, global file panel following projects/conversations without duplication, run reset, scoped subagent docking, repeated live transfers, main reload and closing without deleting task data.')
  } finally {
    await closeElectronTestApplication(application)
    await rm(root, { recursive: true, force: true })
  }
}
module.exports = { verifyUnifiedPanels }
