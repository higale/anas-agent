const assert = require('node:assert/strict')
const { createWriteStream } = require('node:fs')
const { cp, mkdtemp, mkdir, rm, readFile, readdir, writeFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join, relative, resolve } = require('node:path')
const { _electron: electron } = require('playwright')
const { expect } = require('playwright/test')
const { ZipFile } = require('yazl')
const { pluginPage, pluginGeometry, pluginWindow, windowCount, tooltipPage } = require('./electron-plugin-helpers.cjs')

async function zipExample(directory, archive, prefix = '') {
  const files = await readdir(directory, { recursive: true, withFileTypes: true })
  await new Promise((resolve, reject) => {
    const zip = new ZipFile()
    const output = createWriteStream(archive)
    output.on('close', resolve)
    output.on('error', reject)
    zip.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output)
    for (const file of files) {
      if (!file.isFile()) continue
      const path = join(file.parentPath, file.name)
      zip.addFile(path, `${prefix}${relative(directory, path).replaceAll('\\', '/')}`)
    }
    zip.end()
  })
}

async function checkNotepadLanguages(application, page, sidebar, popup) {
  const shell = await pluginWindow(application, popup)
  await popup.locator('#draft').fill('Window language draft')
  for (const [language, title, save, status] of [
    ['zh-CN', '记事本', '保存', '未保存'],
    ['fr', 'Bloc-notes', 'Save', 'Unsaved'],
    ['en', 'Notepad', 'Save', 'Unsaved']
  ]) {
    await page.evaluate(language => globalThis.gale.config.updateSettings({ language }), language)
    for (const [view, value] of [[sidebar, 'Unsaved page state'], [popup, 'Window language draft']]) {
      await view.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
      await expect(view.locator('#save')).toHaveText(save, { timeout: 10000 })
      await expect(view.locator('label')).toHaveText(title)
      await expect(view.locator('#status')).toHaveText(status)
      await expect(view.locator('#draft')).toHaveValue(value)
      await expect(view.locator('html')).toHaveAttribute('lang', language)
      await expect(view.locator('#language-warning')).toBeHidden()
    }
    await expect(shell.locator('.panel-window-titlebar > strong')).toHaveText(title)
    if (language === 'zh-CN') await popup.screenshot({ path: join(tmpdir(), 'anas-notepad-chinese.png') })
    if (language === 'en') await sidebar.screenshot({ path: join(tmpdir(), 'anas-notepad-english.png') })
  }
}

async function checkPanelResize(application, page, frame) {
  const panel = page.locator('.workspace-panels')
  const handle = page.locator('.workspace-panel-resize')
  const initial = await panel.boundingBox()
  const target = await handle.boundingBox()
  assert.ok(target.x >= initial.x - 1, 'The resize target must leave the adjacent conversation scrollbar available.')
  for (const [offset, movement] of [[6, -40], [14, 40]]) {
    const bounds = await panel.boundingBox()
    const content = await pluginGeometry(application, frame)
    const y = content.y + content.height / 2
    const x = bounds.x + offset
    const hits = await page.evaluate(({ x, top, height }) => [0.1, 0.5, 0.9].map(fraction => (
      Boolean(globalThis.document.elementFromPoint(x, top + height * fraction)?.closest('.workspace-panel-resize'))
    )), { x, top: content.y, height: content.height })
    assert.ok(hits.every(Boolean), `Plugin panel divider must respond ${offset}px inside its edge: ${JSON.stringify(hits)}`)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + movement, y, { steps: 8 })
    await page.mouse.up()
    const expected = Math.round(bounds.width - movement)
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.workspacePanelWidth)).toBe(expected)
    await expect.poll(async () => Math.round((await panel.boundingBox()).width)).toBe(expected)
    await expect.poll(async () => {
      const slot = await page.locator('[data-plugin-panel="example-notepad"]').boundingBox()
      const nativeView = await pluginGeometry(application, frame)
      return Math.abs(slot.x - nativeView.x) + Math.abs(slot.width - nativeView.width)
    }).toBeLessThan(2)
    await expect(frame.locator('#draft')).toHaveValue('Unsaved page state')
  }
  assert.equal(Math.round((await panel.boundingBox()).width), Math.round(initial.width))
  await frame.locator('#draft').click()
  await expect(frame.locator('#draft')).toBeFocused()
}

async function checkLifecycle(application, page, directory) {
  const source = join(directory, 'plugin-fixture')
  await mkdir(source)
  const responses = []
  const server = createServer((_request, response) => responses.push(response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'lifecycle-test', name: 'Lifecycle test', plugin_version: '1.0.0', api_version: 1, ui: 'index.html', backend: 'backend.cjs' }))
    await writeFile(join(source, 'index.html'), `<html><body>Slow image<img src="http://127.0.0.1:${server.address().port}/slow.png"></body></html>`)
    await writeFile(join(source, 'backend.cjs'), `
      const fs = require('node:fs/promises'); const path = require('node:path'); let directory;
      module.exports = {
        activate(context) { directory = context.dataDirectory },
        async call(_method, params) {
          await fs.appendFile(path.join(directory, 'executions.log'), params.id + '\\n');
          while (!(await fs.stat(path.join(directory, 'release')).catch(() => false))) await new Promise(resolve => setTimeout(resolve, 20));
          return params.id;
        },
        async deactivate() {
          await fs.appendFile(path.join(directory, 'executions.log'), 'deactivate\\n');
          if (await fs.stat(path.join(directory, 'fail-cleanup')).catch(() => false)) throw new Error('cleanup unavailable');
        }
      };
    `)
    await application.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, join(source, 'PLUGIN.json'))
    await page.evaluate(() => globalThis.gale.plugins.install())
    await page.evaluate(() => {
      globalThis.pluginWindowResult = undefined
      void globalThis.gale.plugins.openWindow('lifecycle-test').then(() => { globalThis.pluginWindowResult = 'opened' }, error => { globalThis.pluginWindowResult = String(error) })
    })
    await expect.poll(() => responses.length).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => globalThis.pluginWindowResult)).toBe('opened')
    // The image remains pending throughout these operations, including closing the window.
    await page.evaluate(() => {
      globalThis.pluginDataResult = undefined
      void globalThis.gale.plugins.invoke('example-notepad', 'data.set', { key: 'parallel', value: 42 }).then(() => { globalThis.pluginDataResult = 'saved' })
    })
    await expect.poll(() => page.evaluate(() => globalThis.pluginDataResult)).toBe('saved')
    await page.evaluate(() => globalThis.gale.plugins.setEnabled('lifecycle-test', false))
    await expect.poll(() => windowCount(application)).toBe(1)
    responses.forEach(response => response.end())
    await page.evaluate(() => globalThis.gale.plugins.setEnabled('lifecycle-test', true))
    await page.evaluate(() => globalThis.gale.plugins.startBackend('lifecycle-test'))
    await page.evaluate(() => {
      globalThis.pluginCallResults = []
      globalThis.pluginCalls = Promise.all([1, 2, 3].map(id => globalThis.gale.plugins.invoke('lifecycle-test', 'backend.call', { method: 'work', params: { id } }).then(
        value => { globalThis.pluginCallResults.push({ status: 'fulfilled', value }) },
        error => { globalThis.pluginCallResults.push({ status: 'rejected', reason: String(error) }) }
      )))
    })
    const log = join(directory, 'plugins_data/lifecycle-test/executions.log')
    await expect.poll(() => readFile(log, 'utf8').catch(() => '')).toBe('1\n')
    await page.evaluate(() => { globalThis.pluginStop = globalThis.gale.plugins.stopBackend('lifecycle-test') })
    await expect.poll(() => page.evaluate(() => globalThis.pluginCallResults.length), { timeout: 2000 }).toBe(2)
    assert.equal(await readFile(log, 'utf8'), '1\n')
    await writeFile(join(directory, 'plugins_data/lifecycle-test/release'), '')
    await page.evaluate(() => Promise.all([globalThis.pluginStop, globalThis.pluginCalls]))
    assert.equal(await readFile(log, 'utf8'), '1\ndeactivate\n')
    const results = await page.evaluate(() => globalThis.pluginCallResults)
    assert.deepEqual(results.filter(result => result.status === 'fulfilled'), [{ status: 'fulfilled', value: 1 }])
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.includes('before this request started')))
    await writeFile(join(directory, 'plugins_data/lifecycle-test/fail-cleanup'), '')
    await page.evaluate(() => globalThis.gale.plugins.startBackend('lifecycle-test'))
    await assert.rejects(page.evaluate(() => globalThis.gale.plugins.stopBackend('lifecycle-test')), /cleanup failed: cleanup unavailable/)
    assert.equal(await page.evaluate(async () => (await globalThis.gale.plugins.list()).find(item => item.id === 'lifecycle-test').backendStatus), 'failed')
    await page.evaluate(() => globalThis.gale.plugins.uninstall('lifecycle-test'))
  } finally {
    responses.forEach(response => response.end())
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

async function checkForms(application, page, directory, settings) {
  const source = join(directory, 'form-fixture')
  await mkdir(source)
  await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'form-test', name: 'Form test', plugin_version: '1.0.0', api_version: 1, ui: 'index.html' }))
  await writeFile(join(source, 'index.html'), '<html><body><script src="/_anas/sdk.js"></script><form id="form"><input id="name" required><button id="submit">Submit</button></form><output id="count">0</output><form id="navigation" action="https://example.com/blocked"><button id="navigate">Navigate</button></form><script src="app.js"></script></body></html>')
  await writeFile(join(source, 'app.js'), 'document.getElementById("form").addEventListener("submit", event => { event.preventDefault(); const output = document.getElementById("count"); output.textContent = String(Number(output.textContent) + 1); });')
  await application.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, join(source, 'PLUGIN.json'))
  await page.evaluate(() => globalThis.gale.plugins.install())
  await settings()
  await page.getByRole('button', { name: 'Form test', exact: true }).click()
  await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
  const frame = await pluginPage(application, 'form-test')
  await frame.locator('#submit').click()
  await expect(frame.locator('#count')).toHaveText('0')
  await frame.locator('#name').fill('Example')
  await frame.locator('#name').press('Enter')
  await expect(frame.locator('#count')).toHaveText('1')
  await frame.locator('#submit').click()
  await expect(frame.locator('#count')).toHaveText('2')
  await frame.evaluate(async () => {
    globalThis.anas.onToolbarAction(async id => {
      if (id !== 'save') throw new Error('Wrong action')
      globalThis.document.getElementById('count').textContent = String(Number(globalThis.document.getElementById('count').textContent) + 1)
      await new Promise(resolve => { globalThis.completeAction = resolve })
    })
    await globalThis.anas.setToolbar({ status: { label: 'Ready', tone: 'success' }, actions: [{ id: 'save', label: 'Save fixture', icon: 'save' }] })
    await globalThis.anas.moveView('window')
  })
  const shell = await pluginWindow(application, frame)
  await expect(shell.getByRole('status')).toHaveText('Ready')
  const beforeTooltip = await pluginGeometry(application, frame)
  await shell.getByRole('button', { name: 'Save fixture', exact: true }).hover()
  const tip = await tooltipPage(application, 'Save fixture')
  assert.deepEqual(await pluginGeometry(application, frame), beforeTooltip, 'Tooltip must not hide, resize, or replace the native page')
  const nativeTip = await application.evaluate(async ({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)
    const pixels = (await window.webContents.capturePage()).toBitmap()
    return { focused: window.isFocused(), cornerAlpha: pixels[3] }
  }, tip.url())
  assert.deepEqual(nativeTip, { focused: false, cornerAlpha: 0 }, 'Tooltip surface must be transparent and must not take focus')
  const previousTheme = await page.evaluate(async () => (await globalThis.gale.config.get()).settings.theme)
  await page.evaluate(theme => globalThis.gale.config.updateSettings({ theme }), previousTheme === 'dark' ? 'light' : 'dark')
  const themedAlpha = await application.evaluate(async ({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)
    return (await window.webContents.capturePage()).toBitmap()[3]
  }, tip.url())
  assert.equal(themedAlpha, 0, 'Theme updates must preserve tooltip transparency')
  await page.evaluate(theme => globalThis.gale.config.updateSettings({ theme }), previousTheme)
  await tip.screenshot({ path: join(tmpdir(), 'anas-native-tooltip.png') })
  await shell.mouse.move(200, 18)
  await expect.poll(() => tip.isClosed()).toBe(true)
  await expect.poll(async () => (await pluginGeometry(application, frame)).visible).toBe(true)
  await shell.getByRole('button', { name: 'Save fixture', exact: true }).click()
  await expect(frame.locator('#count')).toHaveText('3')
  await expect(shell.getByRole('button', { name: 'Save fixture', exact: true })).toBeDisabled()
  await frame.evaluate(() => globalThis.completeAction())
  await expect(shell.getByRole('button', { name: 'Save fixture', exact: true })).toBeEnabled()
  await shell.getByRole('button', { name: 'Move to side panel', exact: true }).hover()
  await tooltipPage(application, 'Move to side panel')
  await shell.getByRole('button', { name: 'Move to side panel', exact: true }).click()
  await expect.poll(async () => (await frame.evaluate(() => globalThis.anas.getInfo())).view.location).toBe('sidebar')
  await expect(frame.locator('#count')).toHaveText('3')
  const navigations = []
  const violations = []
  const observe = request => { if (request.url().startsWith('https://example.com/blocked')) navigations.push(request.url()) }
  const consoleMessage = message => { if (message.text().includes('form-action')) violations.push(message.text()) }
  frame.on('request', observe)
  frame.on('console', consoleMessage)
  await frame.locator('#navigate').click({ noWaitAfter: true })
  await expect.poll(() => violations.length).toBeGreaterThan(0)
  assert.deepEqual(navigations, [])
  frame.off('request', observe)
  frame.off('console', consoleMessage)
  await page.evaluate(() => globalThis.gale.plugins.uninstall('form-test'))
}

async function checkBackup(application, page) {
  const backups = await mkdtemp(join(tmpdir(), 'anas-plugin-backups-'))
  try {
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, join(backups, 'plugins.zip'))
    await page.evaluate(() => globalThis.gale.plugins.startBackend('example-backend'))
    const backup = await page.evaluate(() => globalThis.gale.app.backupData())
    assert.ok(backup?.path)
    assert.equal(await page.evaluate(async () => (await globalThis.gale.plugins.list()).find(item => item.id === 'example-backend').backendStatus), 'stopped')
    await page.evaluate(() => globalThis.gale.plugins.invoke('example-notepad', 'data.set', { key: 'draft', value: 'Changed after backup' }))
    const home = await page.evaluate(() => globalThis.gale.panels.list().then(views => views.find(view => view.content.pluginId === 'example-notepad' && view.content.instanceId === 'main')))
    assert.ok(home)
    await page.evaluate(id => globalThis.gale.panels.close(id), home.viewId)
    await page.evaluate(() => globalThis.gale.plugins.openWindow('example-notepad'))
    await expect.poll(() => windowCount(application)).toBe(2)
    await page.evaluate(() => globalThis.gale.plugins.startBackend('example-backend'))
    await page.evaluate(path => globalThis.gale.app.restoreData(path), backup.path)
    await expect.poll(() => windowCount(application)).toBe(1)
    assert.equal((await page.evaluate(() => globalThis.gale.panels.list())).length, 0)
    assert.equal(await page.evaluate(() => globalThis.gale.plugins.invoke('example-notepad', 'data.get', { key: 'draft' })), 'Plugin saved draft')
    assert.equal(await page.evaluate(async () => (await globalThis.gale.plugins.list()).find(item => item.id === 'example-backend').backendStatus), 'stopped')
  } finally {
    await rm(backups, { recursive: true, force: true })
  }
}

async function checkHomePolicies(application, page, directory) {
  for (const location of ['window', 'sidebar']) {
    const id = `home-${location}`
    const source = join(directory, id)
    await mkdir(source)
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id, name: id, plugin_version: '1.0.0', api_version: 1,
      ui: 'index.html', home: { locations: [location] } }))
    await writeFile(join(source, 'index.html'), '<script src="/_anas/sdk.js"></script><p>Home fixture</p>')
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, join(source, 'PLUGIN.json'))
    await page.evaluate(() => globalThis.gale.plugins.install())
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByRole('menuitem', { name: id, exact: true }).click()
    const plugin = await pluginPage(application, id, 'main', location)
    if (location === 'window') {
      await expect.poll(() => windowCount(application)).toBe(2)
      const popup = plugin
      await expect(popup.locator('p')).toHaveText('Home fixture')
      assert.deepEqual(await popup.evaluate(() => globalThis.anas.getHome()), { location, locations: [location] })
      await popup.evaluate(() => globalThis.anas.openHome())
      assert.equal(await windowCount(application), 2)
    } else {
      await expect(plugin.locator('p')).toHaveText('Home fixture')
      await assert.rejects(page.evaluate(id => globalThis.gale.plugins.openWindow(id), id), /[Uu]nsupported.*location|home location/)
    }
    const other = location === 'window' ? 'sidebar' : 'window'
    await assert.rejects(page.evaluate(({ id, other }) => globalThis.gale.plugins.invoke(id, 'host.openView', { instanceId: 'main', location: other }), { id, other }), /[Uu]nsupported.*location|home location/)
    await assert.rejects(page.evaluate(({ id, other }) => globalThis.gale.plugins.invoke(id, 'data.set', { key: 'home_open_location', value: other }), { id, other }), /[Uu]nsupported.*location|home location/)
    // Home restrictions do not constrain a plugin's other pages.
    await page.evaluate(({ id, other }) => globalThis.gale.plugins.invoke(id, 'host.openView', { instanceId: 'document', location: other }), { id, other })
    await page.evaluate(id => globalThis.gale.plugins.uninstall(id), id)
    await expect.poll(() => windowCount(application)).toBe(1)
    assert.equal((await page.evaluate(() => globalThis.gale.panels.list())).filter(view => view.content.pluginId === id).length, 0)
  }
}

async function main() {
  const repository = resolve(__dirname, '..')
  const directory = await mkdtemp(join(tmpdir(), 'anas-plugin-e2e-'))
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  let application
  try {
    const backendZip = join(directory, 'backend.zip')
    const notepadZip = join(directory, 'notepad.zip')
    const notepadSource = join(directory, 'notepad-source')
    await cp(join(repository, 'examples/plugins/notepad'), notepadSource, { recursive: true })
    // Partial translations exercise missing and empty text fallback in the real example.
    await writeFile(join(notepadSource, 'lang/fr.json'), JSON.stringify({ version: 0, _meta: { name: 'Français' }, plugin: { name: 'Bloc-notes' }, actions: { save: '' } }))
    await mkdir(join(directory, 'lang'))
    await writeFile(join(directory, 'lang/fr.json'), JSON.stringify({ version: 0, _meta: { name: 'Français' } }))
    await zipExample(join(repository, 'examples/plugins/backend-demo'), backendZip, 'backend-demo/')
    await zipExample(join(repository, 'examples/plugins/notepad'), notepadZip)
    application = await electron.launch({ args: [repository, '--data-dir', directory], cwd: repository, env: environment, executablePath: require('electron'), timeout: 45000 })
    const page = await application.firstWindow({ timeout: 45000 })
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en', theme: 'dark' }))
    await page.reload()
    await page.locator('[data-agent-composer-input]').waitFor()
    await application.evaluate(({ dialog, BrowserWindow }, paths) => {
      globalThis.__pluginTestErrors = []
      dialog.showErrorBox = (title, content) => globalThis.__pluginTestErrors.push(`${title}: ${content}`)
      dialog.showOpenDialog = async (...args) => {
        globalThis.__pluginInstallDialog = args.at(-1)
        return { canceled: false, filePaths: [paths.shift()] }
      }
      BrowserWindow.getAllWindows()[0].setSize(1360, 800)
    }, [join(notepadSource, 'PLUGIN.json'), backendZip, notepadZip])
    const settings = async () => {
      await page.locator('.sidebar-settings').click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      await page.locator('[data-settings-tab="plugins"]').click()
    }
    await settings()
    await page.getByRole('button', { name: 'Install plugin', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open in side panel', exact: true })).toBeEnabled()
    const installDialog = await application.evaluate(() => globalThis.__pluginInstallDialog)
    assert.deepEqual(installDialog.properties, ['openFile'])
    assert.deepEqual(installDialog.filters.flatMap(filter => filter.extensions), ['zip', 'json'])
    await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
    let frame = await pluginPage(application, 'example-notepad')
    await expect(frame.locator('#draft')).toBeEnabled({ timeout: 10000 })
    assert.equal(await frame.locator('body').evaluate(() => typeof globalThis.gale), 'undefined')
    await frame.locator('#draft').fill('Plugin saved draft')
    await frame.locator('#save').click()
    await expect(frame.locator('#status')).toHaveText('Saved')
    await frame.locator('#draft').fill('Unsaved page state')
    await checkPanelResize(application, page, frame)
    await page.getByRole('button', { name: 'Hide right workspace', exact: true }).click()
    await expect.poll(async () => (await pluginGeometry(application, frame))?.visible).toBe(false)
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Notepad', exact: true }).click()
    await expect(frame.locator('#draft')).toHaveValue('Unsaved page state')
    await settings()
    await expect.poll(async () => (await pluginGeometry(application, frame))?.visible).toBe(false)
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-settings.png') })
    await page.getByRole('button', { name: 'Open window', exact: true }).click()
    await expect(frame.locator('#draft')).toHaveValue('Unsaved page state')
    assert.equal(await windowCount(application), 1, 'Opening a home again must reuse its current sidebar placement.')
    assert.equal((await page.evaluate(() => globalThis.gale.panels.list())).filter(view => view.content.pluginId === 'example-notepad' && view.content.instanceId === 'main').length, 1)
    // A separate business page still has its own placement and unsaved draft.
    await frame.evaluate(() => globalThis.anas.openView({ instanceId: 'language-window', location: 'window' }))
    await expect.poll(() => windowCount(application)).toBe(2)
    const popup = await pluginPage(application, 'example-notepad', 'language-window', 'window')
    await expect(popup.locator('#draft')).toHaveValue('Plugin saved draft')
    assert.equal(await popup.evaluate(() => typeof globalThis.gale), 'undefined')
    // The public API is identical in both native view placements.
    await popup.evaluate(() => globalThis.anas.openView({ instanceId: 'second', location: 'window', title: 'Second notepad' }))
    await expect.poll(() => windowCount(application)).toBe(3)
    const second = await pluginPage(application, 'example-notepad', 'second', 'window')
    await expect(second.locator('#draft')).toBeEnabled()
    assert.deepEqual(await second.evaluate(async () => (await globalThis.anas.getInfo()).view), { instanceId: 'second', location: 'window' })
    await second.locator('#draft').fill('Second window state')
    await popup.evaluate(() => globalThis.anas.openView({ instanceId: 'second', location: 'window' }))
    assert.equal(await windowCount(application), 3)
    await expect(second.locator('#draft')).toHaveValue('Second window state')
    await second.evaluate(() => globalThis.anas.openView({ instanceId: 'side-two', location: 'sidebar', title: 'Second sidebar' }))
    const sideTwo = await pluginPage(application, 'example-notepad', 'side-two')
    await expect(sideTwo.locator('#draft')).toBeEnabled()
    assert.deepEqual(await sideTwo.locator('body').evaluate(async () => (await globalThis.anas.getInfo()).view), { instanceId: 'side-two', location: 'sidebar' })
    await sideTwo.locator('#draft').fill('Second sidebar state')
    await second.evaluate(() => globalThis.anas.openView({ instanceId: 'side-two', location: 'sidebar', title: 'Second sidebar' }))
    assert.equal(application.context().pages().filter(item => item.url() === sideTwo.url()).length, 1)
    await expect(sideTwo.locator('#draft')).toHaveValue('Second sidebar state')
    await second.evaluate(() => globalThis.anas.openView({ instanceId: 'main', location: 'sidebar', title: 'Notepad' }))
    await expect(frame.locator('#draft')).toHaveValue('Unsaved page state')
    await checkNotepadLanguages(application, page, frame, popup)
    assert.equal((await page.evaluate(() => globalThis.gale.panels.list())).filter(view => view.content.pluginId === 'example-notepad' && view.content.instanceId === 'main' && view.location === 'sidebar').length, 1)
    await assert.rejects(second.evaluate(() => globalThis.anas.openView({ instanceId: '../bad', location: 'window' })), /Invalid plugin view/)
    await settings()
    await page.getByRole('checkbox', { name: 'Enabled', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).not.toBeChecked()
    await expect.poll(() => windowCount(application)).toBe(1)
    assert.equal((await page.evaluate(() => globalThis.gale.panels.list())).length, 0)
    await assert.rejects(page.evaluate(() => globalThis.gale.plugins.invoke('example-notepad', 'data.get', { key: 'draft' })), /disabled/)
    await page.getByRole('checkbox', { name: 'Enabled', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'Install plugin', exact: true }).click()
    await expect(page.getByText('Backend stopped; starts on the first call.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
    const backend = await pluginPage(application, 'example-backend')
    await backend.locator('#call').waitFor()
    await expect(backend.getByRole('heading')).toHaveText('Optional backend')
    await expect(backend.locator('#call')).toHaveText('Call')
    await expect(backend.locator('#fail')).toHaveText('Test error')
    await backend.screenshot({ path: join(tmpdir(), 'anas-plugin-backend.png') })
    await backend.locator('#call').click()
    await expect(backend.locator('#result')).toContainText('"count": 1', { timeout: 10000 })
    await backend.locator('#fail').click()
    await expect(backend.locator('#result')).toContainText('Example backend error')
    await page.getByRole('button', { name: 'Hide right workspace', exact: true }).click()
    const status = await page.evaluate(() => globalThis.gale.plugins.list())
    assert.equal(status.find(item => item.id === 'example-backend').backendStatus, 'running')
    await settings()
    await page.getByRole('button', { name: 'Backend demo', exact: true }).click()
    await page.getByRole('button', { name: 'Stop backend', exact: true }).click()
    await expect(page.getByText('Backend stopped; starts on the first call.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Notepad', exact: true }).click()
    await page.getByRole('button', { name: 'Uninstall plugin', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: /Confirm|确认/ }).click()
    await expect(page.getByRole('button', { name: 'Notepad', exact: true })).toHaveCount(0)
    assert.equal(JSON.parse(await readFile(join(directory, 'plugins_data/example-notepad/state.json'), 'utf8')).values.draft, 'Plugin saved draft')
    await page.getByRole('button', { name: 'Install plugin', exact: true }).click()
    await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
    frame = await pluginPage(application, 'example-notepad')
    await expect(frame.locator('#draft')).toHaveValue('Plugin saved draft')
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'fr' }))
    await frame.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
    await expect.poll(() => frame.evaluate(async () => (await globalThis.anas.getInfo()).language)).toBe('fr')
    await expect(frame.locator('#save')).toHaveText('Save')
    await expect(frame.locator('html')).toHaveAttribute('lang', 'en')
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-panel.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
    await expect(page.locator('.workspace-panels-drawer')).toBeVisible()
    await frame.locator('#draft').fill('Narrow panel state')
    await expect(frame.locator('#draft')).toHaveValue('Narrow panel state')
    const slotBounds = await page.locator('[data-plugin-panel="example-notepad"]').boundingBox()
    await expect.poll(async () => {
      const frameBounds = await pluginGeometry(application, frame)
      return Math.abs(frameBounds.x - slotBounds.x) + Math.abs(frameBounds.width - slotBounds.width)
    }).toBeLessThan(2)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'light', fontSize: 18 }))
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-narrow.png') })
    await checkForms(application, page, directory, settings)
    await require('./electron-plugin-transfer.cjs')(application, page, directory)
    await checkLifecycle(application, page, directory)
    await checkBackup(application, page)
    assert.deepEqual(errors, [])
    assert.deepEqual(await application.evaluate(() => globalThis.__pluginTestErrors), [])
    await application.close()
    application = await electron.launch({ args: [repository, '--data-dir', directory], cwd: repository, env: environment, executablePath: require('electron'), timeout: 45000 })
    const restarted = await application.firstWindow({ timeout: 45000 })
    await restarted.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    const restored = await restarted.evaluate(() => globalThis.gale.plugins.list())
    assert.equal(restored.length, 2)
    assert.equal(restored.find(item => item.id === 'example-backend').backendStatus, 'stopped')
    assert.equal(await restarted.evaluate(() => globalThis.gale.plugins.invoke('example-notepad', 'data.get', { key: 'draft' })), 'Plugin saved draft')
    await checkHomePolicies(application, restarted, directory)
    console.log('Plugins passed: PLUGIN.json and root/wrapped ZIP installation, nested language files, live translations and English fallback with unsaved drafts, sidebar and narrow drawer, named sidebar/window instances, duplicate/default instance reuse, isolated popup, persistent data, disable, optional backend RPC/errors/stop, queued cancellation with active results, slow-resource isolation, backup/restore, reinstall, and restart without backend activation.')
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
