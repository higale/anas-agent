const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function verifyCurrentData(launchApplication) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'anas-current-data-e2e-'))
  const root = join(temporaryRoot, 'profile')
  let application
  try {
    await mkdir(join(root, 'config'), { recursive: true })
    const path = join(root, 'config/tools.json')
    await writeFile(path, JSON.stringify({ version: 0, order: ['user:example-read-text-raw'], external_directories: [] }))
    await cp(resolve(__dirname, '../data/tools_examples/read_text_raw'), join(root, 'tools/read_text_raw'), { recursive: true })
    application = await launchApplication(root)
    const page = await application.firstWindow()
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    const name = await page.evaluate(async () => {
      const initial = await globalThis.gale.config.get()
      const tool = initial.customTools.find(tool => tool.id === 'user:example-read-text-raw')
      if (!tool?.definition) throw new Error('Current tool definition is unavailable')
      const saved = await globalThis.gale.config.saveCustomTool({ ...tool.definition, description: 'Saved without upgrade modules' })
      return saved.customTools.find(item => item.id === tool.id)?.description
    })
    assert.equal(name, 'Saved without upgrade modules')
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 0)
    await assert.rejects(readFile(`${path}.v0.bak`), { code: 'ENOENT' })
    await closeElectronTestApplication(application)
    application = undefined
    for (const file of ['settings', 'models', 'capabilities', 'subagents', 'mcp_servers', 'skills', 'tools']) {
      assert.equal(JSON.parse(await readFile(join(root, `config/${file}.json`), 'utf8')).version, 0)
    }
    assert.equal(JSON.parse(await readFile(join(root, 'projects.json'), 'utf8')).version, 0)
    await writeFile(join(root, 'sqlite/agent.sqlite'), 'Keep unrelated historical data')
    application = await launchApplication(root)
    await expect((await application.firstWindow()).locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    await closeElectronTestApplication(application)
    application = undefined
    for (const invalid of ['{"order":["user:example-read-text-raw"]}', '{"version":1,"order":["user:example-read-text-raw"]}']) {
      await writeFile(path, invalid)
      const numbered = Object.hasOwn(JSON.parse(invalid), 'version')
      if (numbered) {
        const projects = JSON.parse(await readFile(join(root, 'projects.json'), 'utf8'))
        await writeFile(join(root, 'projects.json'), JSON.stringify({ ...projects, version: 4 }))
        await promisify(execFile)(require('electron'), ['-e', `
          const Database = require('better-sqlite3');
          const db = new Database(require('node:path').join(process.argv[1], 'sqlite/catalog.sqlite'));
          db.pragma('user_version = 1'); db.close();
        `, root], { cwd: resolve(__dirname, '..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      }
      application = await launchApplication(root)
      const failed = await application.firstWindow()
      await expect(failed.locator('.initial-app-status-error')).toBeVisible({ timeout: 20000 })
      await expect(failed.locator('[data-agent-composer-input]')).toHaveCount(0)
      assert.equal(await readFile(path, 'utf8'), invalid)
      const fileRow = failed.getByRole('group', { name: 'tools.json', exact: true })
      const repairButton = fileRow.getByRole('button', { name: /^(修复|Repair)$/ })
      {
        await repairButton.click()
        await failed.getByRole('alertdialog').getByRole('button', { name: /^(修复|Repair)$/ }).click()
        await expect.poll(async () => JSON.parse(await readFile(path, 'utf8')).version).toBe(0)
        await expect(failed.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
        const preserved = await failed.evaluate(async () => (await globalThis.gale.recovery.inspect()).lastPreservationPath)
        assert.ok(preserved)
        assert.equal(await readFile(join(preserved, 'data/config/tools.json'), 'utf8'), invalid)
        const repaired = JSON.parse(await readFile(path, 'utf8'))
        assert.deepEqual(repaired.order, ['user:example-read-text-raw'])
        assert.deepEqual(repaired.external_directories, [])
        if (numbered) {
          const projectsBefore = await readFile(join(root, 'projects.json'), 'utf8')
          await failed.getByRole('group', { name: 'projects.json', exact: true }).getByRole('button', { name: /^(修复|Repair)$/ }).click()
          await failed.getByRole('alertdialog').getByRole('button', { name: /^(修复|Repair)$/ }).click()
          await expect.poll(async () => JSON.parse(await readFile(join(root, 'projects.json'), 'utf8')).version, { timeout: 15000 }).toBe(0)
          await expect(failed.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
          const status = await failed.evaluate(() => globalThis.gale.recovery.inspect())
          assert.equal(status.files.find(file => file.name === 'projects.json').error, undefined)
          assert.equal(await readFile(join(status.lastPreservationPath, 'data/projects.json'), 'utf8'), projectsBefore)
          assert.equal(await readFile(join(root, 'sqlite/agent.sqlite'), 'utf8'), 'Keep unrelated historical data')
        }
        await closeElectronTestApplication(application)
        application = await launchApplication(root)
        await expect((await application.firstWindow()).locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
      }
      await closeElectronTestApplication(application)
      application = undefined
    }
    const history = { maxHistory: 100, items: Array.from({ length: 59 }, (_, index) => ({
      text: `Keep input ${index}`, pinned: index % 2 === 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z'
    })) }
    for (const file of ['input_history.json', 'assets/avatar-transform.json']) {
      const current = file === 'input_history.json' ? history : JSON.parse(await readFile(join(root, file), 'utf8'))
      const invalid = JSON.stringify({ ...current, version: 1 })
      await writeFile(join(root, file), invalid)
      application = await launchApplication(root)
      const recovery = await application.firstWindow()
      await expect(recovery.getByRole('group', { name: file, exact: true })).toBeVisible({ timeout: 20000 })
      await expect(recovery.locator('[data-agent-composer-input]')).toHaveCount(0)
      await expect(recovery.locator('.app-issue-tray')).toHaveCount(0)
      assert.equal(await readFile(join(root, file), 'utf8'), invalid)
      await recovery.getByRole('group', { name: file, exact: true }).getByRole('button', { name: /^(修复|Repair)$/ }).click()
      await recovery.getByRole('alertdialog').getByRole('button', { name: /^(修复|Repair)$/ }).click()
      await expect(recovery.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
      const status = await recovery.evaluate(() => globalThis.gale.recovery.inspect())
      assert.equal(status.files.find(item => item.name === file).error, undefined)
      assert.equal(await readFile(join(status.lastPreservationPath, 'data', file), 'utf8'), invalid)
      assert.deepEqual(JSON.parse(await readFile(join(root, file), 'utf8')), { ...current, version: 0 })
      await closeElectronTestApplication(application)
      application = await launchApplication(root)
      const restored = await application.firstWindow()
      await expect(restored.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
      assert.equal((await restored.evaluate(() => globalThis.gale.inputHistory.get())).items.length, 59)
      assert.ok(await restored.evaluate(() => globalThis.gale.files.getAvatar()))
      await closeElectronTestApplication(application)
      application = undefined
    }
    const mixedHistory = JSON.stringify({ version: 0, ...history, items: [...history.items, { text: 7 }] })
    await writeFile(join(root, 'input_history.json'), mixedHistory)
    const sourceName = (await readdir(join(root, 'assets'))).find(name => /^avatar-source\./.test(name))
    assert.ok(sourceName)
    const cropBefore = await readFile(join(root, 'assets/avatar-crop.png'))
    await writeFile(join(root, 'assets', sourceName), 'damaged avatar source')
    await rm(join(root, 'assets/avatar.png'))
    await rm(join(root, 'assets/avatar-dock.png'))
    application = await launchApplication(root)
    const rescue = await application.firstWindow()
    await expect(rescue.getByRole('group', { name: 'input_history.json', exact: true })).toBeVisible({ timeout: 20000 })
    await expect(rescue.getByRole('group', { name: 'assets/avatar-transform.json', exact: true })).toBeVisible()
    await expect(rescue.locator('[data-agent-composer-input]')).toHaveCount(0)
    for (const file of ['input_history.json', 'assets/avatar-transform.json']) {
      await rescue.getByRole('group', { name: file, exact: true }).getByRole('button', { name: /^(修复|Repair)$/ }).click()
      await rescue.getByRole('alertdialog').getByRole('button', { name: /^(修复|Repair)$/ }).click()
      await expect(rescue.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
      const status = await rescue.evaluate(() => globalThis.gale.recovery.inspect())
      assert.equal(status.files.find(item => item.name === file).error, undefined)
      if (file === 'input_history.json') {
        assert.equal(await readFile(join(status.lastPreservationPath, 'data/input_history.json'), 'utf8'), mixedHistory)
        await expect(rescue.getByText(/已部分修复|Partially repaired/)).toBeVisible()
      } else {
        assert.equal(await readFile(join(status.lastPreservationPath, 'data/assets', sourceName), 'utf8'), 'damaged avatar source')
        assert.deepEqual(await readFile(join(root, 'assets/avatar-crop.png')), cropBefore)
      }
    }
    await closeElectronTestApplication(application)
    application = await launchApplication(root)
    const usable = await application.firstWindow()
    await expect(usable.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    assert.equal((await usable.evaluate(() => globalThis.gale.inputHistory.get())).items.length, 59)
    const avatar = await usable.evaluate(() => globalThis.gale.files.getAvatar())
    assert.ok(avatar)
    assert.equal(await application.evaluate(({ nativeImage }, path) => !nativeImage.createFromPath(path).isEmpty(), avatar.path), true)
    console.log('Data v0 Electron E2E passed: current data, version repair, project/catalog repair, partial history rescue, avatar crop recovery, original preservation and successful restart without upgrades.')
  } finally {
    await closeElectronTestApplication(application)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

module.exports = { verifyCurrentData }
