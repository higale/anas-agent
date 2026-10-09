const assert = require('node:assert/strict')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { WebSocketServer } = require('ws')
const { expect } = require('playwright/test')
const { pluginPage, windowCount } = require('./electron-plugin-helpers.cjs')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function verifyMainWindowLifecycle(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-main-window-'))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  server.on('connection', socket => socket.on('message', value => socket.send(value)))
  let application
  let applicationProcess
  try {
    const source = join(root, 'fixture')
    await mkdir(source)
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'window-lifecycle', name: 'Window lifecycle', plugin_version: '1.0.0', api_version: 2, ui: 'index.html', backend: 'backend.cjs' }))
    await writeFile(join(source, 'index.html'), '<script src="/_anas/sdk.js"></script><script src="app.js" defer></script><input id="draft">')
    await writeFile(join(source, 'app.js'), `
      anas.registerLifecycle({ prepare: async () => null }); anas.ready();
      globalThis.echoes = 0;
      const socket = new WebSocket('ws://127.0.0.1:${server.address().port}');
      socket.onopen = () => { setInterval(() => socket.send(String(echoes)), 25); };
      socket.onmessage = () => { echoes++; };
    `)
    await writeFile(join(source, 'backend.cjs'), `
      const { mkdirSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      let directory;
      exports.activate = context => { directory = context.dataDirectory; mkdirSync(directory, { recursive: true }); };
      exports.call = () => ({ pid: process.pid });
      exports.deactivate = () => writeFileSync(join(directory, 'stopped.json'), JSON.stringify({ stopped: true }));
    `)
    application = await launchApplication(root)
    applicationProcess = application.process()
    let main = await application.firstWindow()
    await main.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, join(source, 'PLUGIN.json'))
    await main.evaluate(() => globalThis.gale.plugins.install())
    await main.evaluate(() => globalThis.gale.plugins.invoke('window-lifecycle', 'host.openView', { instanceId: 'main', location: 'window' }))
    const plugin = await pluginPage(application, 'window-lifecycle', 'main', 'window')
    await plugin.locator('#draft').fill('Keep this plugin draft')
    await expect.poll(() => plugin.evaluate(() => globalThis.echoes)).toBeGreaterThan(1)
    const backend = await main.evaluate(() => globalThis.gale.plugins.invoke('window-lifecycle', 'backend.call', { method: 'identity' }))
    assert.ok(backend.pid > 0)
    assert.equal(await windowCount(application), 2)
    const mainUrl = main.url()
    // A canceled close must preserve both the main window and its plugin.
    await application.evaluate(({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)
      globalThis.__cancelMainClose = event => event.preventDefault()
      window.prependListener('close', globalThis.__cancelMainClose)
      window.close()
    }, mainUrl)
    assert.equal(await application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL() === url && window.isVisible()), mainUrl), true)
    assert.equal(await windowCount(application), 2)
    await expect(plugin.locator('#draft')).toHaveValue('Keep this plugin draft')
    await application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).removeListener('close', globalThis.__cancelMainClose), mainUrl)
    if (process.platform !== 'darwin') {
      // Electron cancels unload natively; prevent Playwright from auto-accepting it.
      const unloadDialogHandled = main.waitForEvent('dialog').then(async dialog => {
        assert.equal(dialog.type(), 'beforeunload')
        try { await dialog.dismiss() } catch (error) {
          assert.match(error.message, /No dialog is showing/)
        }
      })
      // Renderer cancellation must not trigger shutdown either.
      await main.evaluate(() => {
        globalThis.__blockMainUnload = event => { event.returnValue = false }
        globalThis.addEventListener('beforeunload', globalThis.__blockMainUnload)
      })
      await application.evaluate(({ BrowserWindow }, url) => {
        const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)
        globalThis.__mainUnloadPrevented = false
        window.webContents.once('will-prevent-unload', () => { globalThis.__mainUnloadPrevented = true })
        setImmediate(() => window.close())
      }, mainUrl)
      await expect.poll(() => application.evaluate(() => globalThis.__mainUnloadPrevented)).toBe(true)
      await unloadDialogHandled
      assert.equal(application.process().exitCode, null)
      assert.equal(await windowCount(application), 2)
      await expect(plugin.locator('#draft')).toHaveValue('Keep this plugin draft')
      await main.evaluate(() => globalThis.removeEventListener('beforeunload', globalThis.__blockMainUnload))
    }
    const child = applicationProcess
    await application.evaluate(({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)
      setImmediate(() => window.close())
    }, mainUrl)
    if (process.platform === 'darwin') {
      await expect.poll(() => application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)?.isVisible(), mainUrl)).toBe(false)
      assert.equal(child.exitCode, null)
      const before = await plugin.evaluate(() => globalThis.echoes)
      await expect.poll(() => plugin.evaluate(() => globalThis.echoes)).toBeGreaterThan(before)
      await application.evaluate(({ app }) => { app.emit('activate') })
      await expect.poll(() => application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)?.isVisible(), mainUrl)).toBe(true)
      await application.evaluate(({ app }) => { setImmediate(() => app.quit()) })
    }
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 10000 }).toBe(true)
    assert.equal(child.exitCode, 0, 'Main-window close must complete normal application shutdown.')
    assert.equal(plugin.page().isClosed(), true)
    assert.deepEqual(JSON.parse(await readFile(join(root, 'plugins_data/window-lifecycle/stopped.json'), 'utf8')), { stopped: true })
    await expect.poll(() => server.clients.size).toBe(0)
    await expect.poll(() => {
      try { process.kill(backend.pid, 0); return false } catch { return true }
    }).toBe(true)
    await application.close().catch(() => undefined)
    application = undefined
    application = await launchApplication(root)
    applicationProcess = application.process()
    main = await application.firstWindow()
    await main.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    assert.equal(await windowCount(application), 1, 'The same profile must restart without orphaned windows or a stale instance lock.')
    assert.equal((await main.evaluate(() => globalThis.gale.plugins.list())).find(plugin => plugin.id === 'window-lifecycle').backendStatus, 'stopped')
    console.log(`Main window lifecycle passed on ${process.platform}: canceled close preserves windows; normal quit closes plugin windows, stops backends and connections, and releases the profile for restart.`)
  } finally {
    if (applicationProcess?.exitCode === null && applicationProcess?.signalCode === null) {
      await closeElectronTestApplication(application)
    } else {
      await application?.close().catch(() => undefined)
    }
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep), 'Cleanup must remain within the allocated temporary test directory.')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

module.exports = { verifyMainWindowLifecycle }