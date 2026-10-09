const assert = require('node:assert/strict')
const { mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { expect } = require('playwright/test')
const { pluginPage, pluginWindow, pluginGeometry, windowCount } = require('./electron-plugin-helpers.cjs')

module.exports = async function checkTransfer(application, page, directory) {
  await application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).setSize(1360, 800), page.url())
  const source = join(directory, 'transfer-fixture')
  await mkdir(source)
  await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'transfer-test', name: 'Transfer test', plugin_version: '1.0.0', api_version: 2, ui: 'index.html', backend: 'backend.cjs' }))
  await writeFile(join(source, 'backend.cjs'), `const id = require('node:crypto').randomUUID(); let ticks = 0, timer;
    module.exports = { activate() { timer = setInterval(() => ticks++, 20) }, call() { return { id, ticks } }, deactivate() { clearInterval(timer) } };`)
  await writeFile(join(source, 'index.html'), '<script src="/_anas/sdk.js"></script><script src="app.js" defer></script><textarea id="draft"></textarea>')
  await writeFile(join(source, 'app.js'), `(async () => {
    const context = await anas.getContext(), draft = globalThis.document.getElementById('draft');
    draft.value = context.restoreState?.draft ?? '';
    globalThis.identity = crypto.randomUUID();
    anas.registerLifecycle({ prepare: async () => ({ draft: draft.value }) });
    await anas.backend.call('state'); await anas.ready();
  })().catch(() => anas.failed());`)
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, join(source, 'PLUGIN.json'))
  await page.evaluate(() => globalThis.gale.plugins.install())
  await page.evaluate(() => globalThis.gale.plugins.invoke('transfer-test', 'host.openHome'))
  let frame = await pluginPage(application, 'transfer-test')
  await frame.locator('#draft').fill('Latest unsaved draft')
  const resource = () => page.evaluate(() => globalThis.gale.plugins.invoke('transfer-test', 'backend.call', { method: 'state' }))
  const original = await resource()
  const view = (await page.evaluate(() => globalThis.gale.panels.list())).find(view => view.content.pluginId === 'transfer-test')
  for (const fontSize of [14, 18]) {
    const identity = await frame.evaluate(() => globalThis.identity)
    await page.evaluate(id => globalThis.gale.panels.move(id, 'window'), view.viewId)
    frame = await pluginPage(application, 'transfer-test', 'main', 'window')
    assert.notEqual(await frame.evaluate(() => globalThis.identity), identity)
    await expect(frame.locator('#draft')).toHaveValue('Latest unsaved draft')
    const shell = await pluginWindow(application, frame)
    await page.evaluate(fontSize => globalThis.gale.config.updateSettings({ fontSize }), fontSize)
    await expect.poll(() => shell.evaluate(() => globalThis.getComputedStyle(globalThis.document.documentElement).getPropertyValue('--font-size-base').trim())).toBe(`${fontSize}px`)
    const layout = await shell.evaluate(() => {
      const header = globalThis.document.querySelector('.panel-window-titlebar'), action = header.querySelector('button'), title = header.querySelector('strong');
      const area = navigator.windowControlsOverlay?.visible ? navigator.windowControlsOverlay.getTitlebarAreaRect() : null;
      return { header: header.getBoundingClientRect().toJSON(), action: action.getBoundingClientRect().toJSON(), title: title.getBoundingClientRect().toJSON(),
        slot: globalThis.document.querySelector('.panel-window-slot').getBoundingClientRect().toJSON(), safeRight: area?.right ?? globalThis.innerWidth,
        drag: globalThis.getComputedStyle(header).getPropertyValue('-webkit-app-region'), actionDrag: globalThis.getComputedStyle(action).getPropertyValue('-webkit-app-region'), platform: globalThis.document.documentElement.dataset.platform };
    })
    assert.ok(layout.header.height >= 36 && layout.header.height < 48)
    assert.equal(layout.slot.y, layout.header.bottom)
    assert.ok(layout.action.right <= layout.safeRight && layout.title.right <= layout.action.x)
    if (layout.platform === 'darwin') assert.ok(layout.title.x >= 84)
    assert.equal(layout.drag, 'drag'); assert.equal(layout.actionDrag, 'no-drag')
    const before = await pluginGeometry(application, frame)
    await shell.getByRole('button', { name: 'Move to side panel', exact: true }).hover()
    await expect(shell.getByRole('tooltip')).toHaveText('Move to side panel')
    assert.deepEqual(await pluginGeometry(application, frame), before)
    await shell.getByRole('button', { name: 'Move to side panel', exact: true }).click()
    frame = await pluginPage(application, 'transfer-test')
    await expect(frame.locator('#draft')).toHaveValue('Latest unsaved draft')
    assert.equal((await resource()).id, original.id)
  }
  await frame.evaluate(() => globalThis.anas.openView({ instanceId: 'main', location: 'window' }))
  assert.equal(await windowCount(application), 1)
  await page.evaluate(id => globalThis.gale.panels.close(id), view.viewId)
  await expect.poll(async () => (await resource()).ticks).toBeGreaterThan(original.ticks)
  assert.equal((await resource()).id, original.id)
  await page.evaluate(() => globalThis.gale.plugins.uninstall('transfer-test'))
  assert.equal((await page.evaluate(() => globalThis.gale.panels.list())).filter(view => view.content.pluginId === 'transfer-test').length, 0)
  console.log('PASS: page reconstruction, draft handoff, backend continuity, compact titlebar, DOM tooltip and instance reuse')
}
