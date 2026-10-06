const assert = require('node:assert/strict')
const { mkdtemp, mkdir, rm, readFile, writeFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')
const { expect } = require('playwright/test')

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
    await application.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, source)
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
    await expect.poll(() => application.windows().length).toBe(1)
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
    const log = join(directory, 'plugin_data/lifecycle-test/executions.log')
    await expect.poll(() => readFile(log, 'utf8').catch(() => '')).toBe('1\n')
    await page.evaluate(() => { globalThis.pluginStop = globalThis.gale.plugins.stopBackend('lifecycle-test') })
    await expect.poll(() => page.evaluate(() => globalThis.pluginCallResults.length), { timeout: 2000 }).toBe(2)
    assert.equal(await readFile(log, 'utf8'), '1\n')
    await writeFile(join(directory, 'plugin_data/lifecycle-test/release'), '')
    await page.evaluate(() => Promise.all([globalThis.pluginStop, globalThis.pluginCalls]))
    assert.equal(await readFile(log, 'utf8'), '1\ndeactivate\n')
    const results = await page.evaluate(() => globalThis.pluginCallResults)
    assert.deepEqual(results.filter(result => result.status === 'fulfilled'), [{ status: 'fulfilled', value: 1 }])
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.includes('before this request started')))
    await writeFile(join(directory, 'plugin_data/lifecycle-test/fail-cleanup'), '')
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
  await writeFile(join(source, 'index.html'), '<html><body><form id="form"><input id="name" required><button id="submit">Submit</button></form><output id="count">0</output><form id="navigation" action="https://example.com/blocked"><button id="navigate">Navigate</button></form><script src="app.js"></script></body></html>')
  await writeFile(join(source, 'app.js'), 'document.getElementById("form").addEventListener("submit", event => { event.preventDefault(); const output = document.getElementById("count"); output.textContent = String(Number(output.textContent) + 1); });')
  await application.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, source)
  await page.evaluate(() => globalThis.gale.plugins.install())
  await settings()
  await page.getByRole('button', { name: 'Form test', exact: true }).click()
  await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
  const frame = page.frameLocator('iframe[title="Form test"]')
  await frame.locator('#submit').click()
  await expect(frame.locator('#count')).toHaveText('0')
  await frame.locator('#name').fill('Example')
  await frame.locator('#name').press('Enter')
  await expect(frame.locator('#count')).toHaveText('1')
  await frame.locator('#submit').click()
  await expect(frame.locator('#count')).toHaveText('2')
  const navigations = []
  const violations = []
  const observe = request => { if (request.url().startsWith('https://example.com/blocked')) navigations.push(request.url()) }
  const consoleMessage = message => { if (message.text().includes('form-action')) violations.push(message.text()) }
  page.on('request', observe)
  page.on('console', consoleMessage)
  await frame.locator('#navigate').click()
  await expect.poll(() => violations.length).toBeGreaterThan(0)
  assert.deepEqual(navigations, [])
  page.off('request', observe)
  page.off('console', consoleMessage)
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
    await page.evaluate(() => globalThis.gale.plugins.openWindow('example-notepad'))
    await expect.poll(() => application.windows().length).toBe(2)
    await page.evaluate(() => globalThis.gale.plugins.startBackend('example-backend'))
    await page.evaluate(path => globalThis.gale.app.restoreData(path), backup.path)
    await expect.poll(() => application.windows().length).toBe(1)
    await expect(page.locator('.plugin-frame')).toHaveCount(0)
    assert.equal(await page.evaluate(() => globalThis.gale.plugins.invoke('example-notepad', 'data.get', { key: 'draft' })), 'Plugin saved draft')
    assert.equal(await page.evaluate(async () => (await globalThis.gale.plugins.list()).find(item => item.id === 'example-backend').backendStatus), 'stopped')
  } finally {
    await rm(backups, { recursive: true, force: true })
  }
}

async function main() {
  const repository = resolve(__dirname, '..')
  const directory = await mkdtemp(join(tmpdir(), 'anas-plugin-e2e-'))
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  let application
  try {
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
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.shift()] })
      BrowserWindow.getAllWindows()[0].setSize(1360, 800)
    }, [join(repository, 'examples/plugins/notepad'), join(repository, 'examples/plugins/backend-demo'), join(repository, 'examples/plugins/notepad')])
    const settings = async () => {
      await page.locator('.sidebar-settings').click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      await page.locator('[data-settings-tab="plugins"]').click()
    }
    await settings()
    await page.getByRole('button', { name: 'Install plugin from folder', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open in side panel', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
    const frame = page.frameLocator('iframe[title="Notepad / 记事本"]')
    await expect(frame.locator('#draft')).toBeEnabled({ timeout: 10000 })
    assert.equal(await frame.locator('body').evaluate(() => typeof globalThis.gale), 'undefined')
    await frame.locator('#draft').fill('Plugin saved draft')
    await frame.locator('#save').click()
    await expect(frame.locator('#status')).toHaveText('Saved / 已保存')
    await frame.locator('#draft').fill('Unsaved page state')
    await page.getByRole('button', { name: 'Hide right workspace', exact: true }).click()
    await expect(page.locator('.plugin-frame')).toBeHidden()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Notepad / 记事本', exact: true }).click()
    await expect(frame.locator('#draft')).toHaveValue('Unsaved page state')
    await settings()
    await expect(page.locator('.plugin-frame')).toBeHidden()
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-settings.png') })
    await page.getByRole('button', { name: 'Open window', exact: true }).click()
    const popup = await expect.poll(() => application.windows().length).toBe(2).then(() => application.windows().find(window => window !== page))
    await expect(popup.locator('#draft')).toHaveValue('Plugin saved draft')
    assert.equal(await popup.evaluate(() => typeof globalThis.gale), 'undefined')
    await page.getByRole('checkbox', { name: 'Enabled', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).not.toBeChecked()
    await expect.poll(() => application.windows().length).toBe(1)
    await expect(page.locator('.plugin-frame')).toHaveCount(0)
    await assert.rejects(page.evaluate(() => globalThis.gale.plugins.invoke('example-notepad', 'data.get', { key: 'draft' })), /disabled/)
    await page.getByRole('checkbox', { name: 'Enabled', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'Install plugin from folder', exact: true }).click()
    await expect(page.getByText('Backend stopped; starts on the first call.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
    const backend = page.frameLocator('iframe[title="Backend demo / 后台示例"]')
    await backend.locator('#call').waitFor()
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-backend.png') })
    await backend.locator('#call').click()
    await expect(backend.locator('#result')).toContainText('"count": 1', { timeout: 10000 })
    await backend.locator('#fail').click()
    await expect(backend.locator('#result')).toContainText('Example backend error')
    await page.getByRole('button', { name: 'Hide right workspace', exact: true }).click()
    const status = await page.evaluate(() => globalThis.gale.plugins.list())
    assert.equal(status.find(item => item.id === 'example-backend').backendStatus, 'running')
    await settings()
    await page.getByRole('button', { name: 'Backend demo / 后台示例', exact: true }).click()
    await page.getByRole('button', { name: 'Stop backend', exact: true }).click()
    await expect(page.getByText('Backend stopped; starts on the first call.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Notepad / 记事本', exact: true }).click()
    await page.getByRole('button', { name: 'Uninstall plugin', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: /Confirm|确认/ }).click()
    await expect(page.getByRole('button', { name: 'Notepad / 记事本', exact: true })).toHaveCount(0)
    assert.equal(JSON.parse(await readFile(join(directory, 'plugin_data/example-notepad/state.json'), 'utf8')).values.draft, 'Plugin saved draft')
    await page.getByRole('button', { name: 'Install plugin from folder', exact: true }).click()
    await page.getByRole('button', { name: 'Open in side panel', exact: true }).click()
    await expect(frame.locator('#draft')).toHaveValue('Plugin saved draft')
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-panel.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
    await expect(page.locator('.workspace-panels-drawer')).toBeVisible()
    await frame.locator('#draft').fill('Narrow panel state')
    await expect(frame.locator('#draft')).toHaveValue('Narrow panel state')
    const slotBounds = await page.locator('[data-plugin-panel="example-notepad"]').boundingBox()
    await expect.poll(async () => {
      const frameBounds = await page.locator('iframe[title="Notepad / 记事本"]').boundingBox()
      return Math.abs(frameBounds.x - slotBounds.x) + Math.abs(frameBounds.width - slotBounds.width)
    }).toBeLessThan(2)
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'light', fontSize: 18 }))
    await page.screenshot({ path: join(tmpdir(), 'anas-plugin-narrow.png') })
    await checkForms(application, page, directory, settings)
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
    console.log('Plugins passed: install, sidebar and narrow drawer, page-state preservation, isolated popup, persistent data, disable, optional backend RPC/errors/stop, queued cancellation with active results, slow-resource isolation, backup/restore, reinstall, and restart without backend activation.')
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
