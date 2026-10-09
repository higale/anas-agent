const assert = require('node:assert/strict')
const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { WebSocketServer } = require('ws')
const { expect } = require('playwright/test')
const { pluginPage, pluginWindow, pluginGeometry, windowCount, tooltipPage } = require('./electron-plugin-helpers.cjs')

module.exports = async function checkTransfer(application, page, directory) {
  await application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).setSize(1360, 800), page.url())
  const source = join(directory, 'transfer-fixture')
  await mkdir(source)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  let connections = 0, closes = 0, messages = 0
  server.on('connection', socket => {
    connections++
    socket.on('close', () => closes++)
    socket.on('message', value => { messages++; socket.send(value) })
  })
  try {
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'transfer-test', name: 'Transfer test', plugin_version: '1.0.0', api_version: 1, ui: 'index.html' }))
    await writeFile(join(source, 'index.html'), '<script src="/_anas/sdk.js"></script><script src="app.js" defer></script><textarea id="draft"></textarea>')
    await writeFile(join(source, 'app.js'), `
      globalThis.identity = crypto.randomUUID();
      globalThis.memory = new WebAssembly.Memory({ initial: 1 });
      new Uint8Array(memory.buffer)[123] = 73;
      globalThis.events = []; globalThis.echoes = 0; globalThis.pageHides = 0;
      anas.onViewChanged(view => events.push(view.location));
      addEventListener('pagehide', () => pageHides++);
      const socket = new WebSocket('ws://127.0.0.1:${server.address().port}');
      socket.onopen = () => { globalThis.timer = setInterval(() => socket.send(String(echoes)), 25) };
      socket.onmessage = () => echoes++;
    `)
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, join(source, 'PLUGIN.json'))
    await page.evaluate(() => globalThis.gale.plugins.install())
    await page.evaluate(() => globalThis.gale.plugins.invoke('transfer-test', 'host.openHome'))
    const live = await pluginPage(application, 'transfer-test')
    await expect.poll(() => live.evaluate(() => globalThis.echoes)).toBeGreaterThan(1)
    await live.locator('#draft').fill('Live connection and unsaved draft')
    const identity = await live.evaluate(() => globalThis.identity)
    const { contentsId } = await pluginGeometry(application, live)
    const retained = async location => {
      await expect.poll(async () => (await live.evaluate(() => globalThis.anas.getInfo())).view.location).toBe(location)
      assert.equal((await pluginGeometry(application, live)).contentsId, contentsId)
      assert.deepEqual(await live.evaluate(() => [globalThis.identity, new Uint8Array(globalThis.memory.buffer)[123], globalThis.pageHides]), [identity, 73, 0])
      await expect(live.locator('#draft')).toHaveValue('Live connection and unsaved draft')
      assert.equal(connections, 1); assert.equal(closes, 0)
    }
    for (let i = 0; i < 4; i++) {
      const before = await live.evaluate(() => globalThis.echoes)
      await page.getByRole('button', { name: 'Move to window', exact: true }).click()
      await retained('window')
      assert.equal(await windowCount(application), 2)
      const shell = await pluginWindow(application, live)
      if (i === 0) {
        await application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).minimize(), shell.url())
        await page.getByRole('button', { name: 'Plugins', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Transfer test', exact: true }).click()
        await retained('window')
        assert.equal(await windowCount(application), 2)
        assert.equal((await page.evaluate(() => globalThis.gale.panels.list())).filter(view => view.content.pluginId === 'transfer-test' && view.content.instanceId === 'main').length, 1)
        await expect.poll(() => application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).isMinimized(), shell.url())).toBe(false)
      }
      assert.equal(await shell.evaluate(() => typeof globalThis.gale), 'undefined')
      const move = shell.getByRole('button', { name: 'Move to side panel', exact: true })
      await expect(move).toHaveText('')
      const beforeTooltip = await pluginGeometry(application, live)
      await move.hover()
      const tip = await tooltipPage(application, 'Move to side panel')
      assert.deepEqual(await pluginGeometry(application, live), beforeTooltip)
      const duringTooltip = await live.evaluate(() => globalThis.echoes)
      await expect.poll(() => live.evaluate(() => globalThis.echoes)).toBeGreaterThan(duringTooltip)
      await expect(tip.getByRole('tooltip')).toHaveText('Move to side panel')
      await shell.mouse.move(200, 18)
      await expect.poll(() => tip.isClosed()).toBe(true)
      await expect.poll(async () => (await pluginGeometry(application, live)).visible).toBe(true)
      if (i < 2) {
        // One shared title row, including at the minimum size and larger font.
        const fontSize = i === 0 ? 14 : 18
        await page.evaluate(({ fontSize, theme }) => globalThis.gale.config.updateSettings({ fontSize, theme }),
          { fontSize, theme: i === 0 ? 'dark' : 'light' })
        await expect.poll(() => shell.evaluate(() => globalThis.getComputedStyle(globalThis.document.documentElement).getPropertyValue('--font-size-base').trim())).toBe(`${fontSize}px`)
        await application.evaluate(({ BrowserWindow }, narrow) => {
          const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('panel-window.html'))
          window.setSize(narrow ? 400 : 960, narrow ? 300 : 680)
        }, i === 1)
        await expect.poll(async () => {
          const slot = await shell.locator('.panel-window-slot').boundingBox()
          const view = await pluginGeometry(application, live)
          return Math.abs(slot.y - view.y) + Math.abs(slot.width - view.width) + Math.abs(slot.height - view.height)
        }).toBeLessThan(3)
        const layout = await shell.evaluate(() => {
          const header = globalThis.document.querySelector('.panel-window-titlebar')
          const action = header.querySelector('button')
          const title = header.querySelector('strong')
          const overlay = navigator.windowControlsOverlay
          const area = overlay?.visible ? overlay.getTitlebarAreaRect() : null
          const rect = element => {
            const bounds = element.getBoundingClientRect()
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom }
          }
          return { header: rect(header), action: rect(action), title: rect(title), slot: rect(globalThis.document.querySelector('.panel-window-slot')),
            borderWidth: Number.parseFloat(globalThis.getComputedStyle(header).borderBottomWidth), overlayBottom: area?.bottom ?? 0,
            titleDrag: globalThis.getComputedStyle(header).getPropertyValue('-webkit-app-region'),
            actionDrag: globalThis.getComputedStyle(action).getPropertyValue('-webkit-app-region'),
            safeRight: area?.right ?? globalThis.innerWidth, platform: globalThis.document.documentElement.dataset.platform }
        })
        assert.equal(layout.header.y, 0)
        assert.ok(layout.header.height >= 36 && layout.header.height < 48, 'Keep a single compact title row.')
        assert.ok(layout.header.bottom - layout.borderWidth >= layout.overlayBottom, 'The divider must be below the native window controls.')
        assert.equal(layout.slot.y, layout.header.bottom)
        assert.ok(layout.action.bottom <= layout.header.bottom && layout.action.y >= 0)
        assert.ok(layout.action.right <= layout.safeRight)
        assert.ok(layout.title.right <= layout.action.x)
        if (layout.platform === 'darwin') assert.ok(layout.title.x >= 84)
        assert.equal(layout.action.width, layout.action.height)
        assert.equal(layout.titleDrag, 'drag'); assert.equal(layout.actionDrag, 'no-drag')
        const frameHeight = await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('panel-window.html'))
          return window.getBounds().height - window.getContentBounds().height
        })
        assert.ok(frameHeight < 24, `A second native title row must not remain: ${frameHeight}px`)
        await shell.screenshot({ path: join(tmpdir(), `anas-plugin-titlebar-${i}.png`) })
      }
      await move.click()
      await retained('sidebar')
      await expect.poll(() => windowCount(application)).toBe(1)
      await expect.poll(() => live.evaluate(() => globalThis.echoes)).toBeGreaterThan(before)
    }
    // Host reload recreates only the tab projection, never the live plugin.
    await page.reload()
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.evaluate(() => globalThis.gale.plugins.invoke('transfer-test', 'host.openHome'))
    await retained('sidebar')
    // Native surfaces must not cover host dialogs/notifications.
    await page.evaluate(() => {
      const dialog = globalThis.document.createElement('div'); dialog.id = 'test-plugin-overlay'
      dialog.role = 'dialog'; dialog.dataset.state = 'open'
      dialog.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#202020'
      globalThis.document.body.append(dialog)
    })
    await expect.poll(async () => (await pluginGeometry(application, live)).visible).toBe(false)
    await page.locator('#test-plugin-overlay').evaluate(element => element.remove())
    await expect.poll(async () => (await pluginGeometry(application, live)).visible).toBe(true)
    await retained('sidebar')
    // Display scaling does not resize the native view in the wrong coordinate space.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
    await expect.poll(async () => {
      const slot = await page.locator('[data-plugin-panel="transfer-test"]').boundingBox()
      const view = await pluginGeometry(application, live)
      if (!slot || !view) return Infinity
      return Math.abs(slot.x * 1.25 - view.x) + Math.abs(slot.width * 1.25 - view.width)
    }).toBeLessThan(3)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    // Directly requesting the other location also reuses the single home.
    await live.evaluate(() => globalThis.anas.openView({ instanceId: 'main', location: 'window' }))
    await retained('sidebar')
    assert.equal(await windowCount(application), 1)
    // Business pages retain independent instances per location and conflict protection.
    await live.evaluate(() => globalThis.anas.openView({ instanceId: 'document', location: 'sidebar' }))
    const document = await pluginPage(application, 'transfer-test', 'document', 'sidebar')
    await document.locator('#draft').fill('Independent sidebar page')
    await document.evaluate(() => globalThis.anas.openView({ instanceId: 'document', location: 'window' }))
    const other = await pluginPage(application, 'transfer-test', 'document', 'window')
    await other.locator('#draft').fill('Other independent page')
    await assert.rejects(document.evaluate(() => globalThis.anas.moveView('window')), /PANEL_CONFLICT/)
    await expect(document.locator('#draft')).toHaveValue('Independent sidebar page')
    await expect(other.locator('#draft')).toHaveValue('Other independent page')
    const registry = await page.evaluate(() => globalThis.gale.panels.list())
    for (const view of registry.filter(view => view.content.pluginId === 'transfer-test' && view.content.instanceId === 'document')) {
      await page.evaluate(id => globalThis.gale.panels.close(id), view.viewId)
    }
    await expect.poll(() => windowCount(application)).toBe(1)
    const locations = await live.evaluate(() => globalThis.events)
    assert.ok(locations.filter(value => value === 'window').length >= 4)
    assert.ok(messages > 10)
    await page.evaluate(() => globalThis.gale.plugins.uninstall('transfer-test'))
    await expect.poll(() => server.clients.size).toBe(0)
    assert.equal(live.isClosed(), true)
    console.log('PASS: compact native title bar, live native page transfer, WebSocket/WASM/draft retention, target conflict, reload, overlays, zoom and cleanup')
  } finally {
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}
