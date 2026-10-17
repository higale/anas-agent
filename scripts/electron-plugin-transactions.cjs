const assert = require('node:assert/strict')
const { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function verifyPluginTransactions(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-plugin-transactions-e2e-'))
  const id = 'recovery-fixture', live = join(root, 'plugins', id), data = join(root, 'db/plugins', id)
  let application
  try {
    await mkdir(join(live, 'package'), { recursive: true })
    await writeFile(join(live, 'package/PLUGIN.json'), JSON.stringify({ version: 0, id, name: 'Recovery fixture',
      plugin_version: '1.0.0', api_version: 2, ui: 'index.html' }))
    await writeFile(join(live, 'package/index.html'), 'original package')
    await writeFile(join(live, 'installation.json'), '{"version":0,"enabled":false}')
    await mkdir(data, { recursive: true })
    const saved = '{"version":0,"values":{"draft":"retained original data"}}'
    await writeFile(join(data, 'state.json'), saved)
    // An interrupted first journal write is still preparation, outside recovery.
    const preparing = join(root, 'tmp/plugin-remove-interrupted')
    await mkdir(preparing, { recursive: true })
    await writeFile(join(preparing, '.transaction.json.interrupted.tmp'), '{"version":0')
    for (const operation of ['replace', 'remove', 'committed-remove']) {
      const replace = operation === 'replace', committed = operation === 'committed-remove'
      const stage = join(root, 'plugins', replace ? '.replace-e2e' : '.remove-e2e')
      await mkdir(stage)
      if (replace) {
        await cp(live, join(stage, 'incoming'), { recursive: true })
        await writeFile(join(stage, 'incoming/package/index.html'), 'uncommitted replacement')
      }
      await rename(live, join(stage, 'previous'))
      await rename(data, join(stage, 'data'))
      if (replace) await rename(join(stage, 'incoming'), live)
      await writeFile(join(stage, 'transaction.json'), JSON.stringify({ version: 0, plugin_id: id,
        operation: replace ? 'replace' : 'remove', had_package: true, move_data: true,
        phase: committed ? 'committed' : 'pending', completed_moves: replace ? 3 : committed ? 2 : 1,
        move_pending: !replace && !committed }))
      application = await launchApplication(root)
      const page = await application.firstWindow()
      await expect(page.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
      const plugins = await page.evaluate(() => globalThis.gale.plugins.list())
      for (const file of ['plugins/README.md', 'plugins/README.en.md', 'skills/weather/SKILL.md',
        'tools/read_text_raw/TOOL.json', 'plugins/notepad/PLUGIN.json']) {
        assert.deepEqual(await readFile(join(root, 'examples', file)), await readFile(join(process.cwd(), 'data/examples', file)))
      }
      if (committed) {
        assert.equal(plugins.some(plugin => plugin.id === id), false)
        await assert.rejects(lstat(live), { code: 'ENOENT' })
        await assert.rejects(lstat(data), { code: 'ENOENT' })
      } else {
        assert.equal(plugins.find(plugin => plugin.id === id).enabled, false)
        assert.equal(await readFile(join(live, 'package/index.html'), 'utf8'), 'original package')
        assert.equal(await readFile(join(data, 'state.json'), 'utf8'), saved)
      }
      await assert.rejects(lstat(stage), { code: 'ENOENT' })
      await closeElectronTestApplication(application)
      application = undefined
    }
    const unknown = join(root, 'plugins/.replace-unrecognized')
    await mkdir(unknown)
    await writeFile(join(unknown, 'retained'), 'must not discard')
    application = await launchApplication(root)
    const recovery = await application.firstWindow()
    await expect(recovery.locator('.initial-app-status-error')).toBeVisible({ timeout: 20000 })
    await expect(recovery.locator('[data-agent-composer-input]')).toHaveCount(0)
    await recovery.locator('summary').click()
    const detail = recovery.locator('textarea').first()
    await expect(detail).toBeVisible()
    await expect(detail).toHaveValue(/Plugin transaction needs recovery/)
    await expect(detail).toHaveValue(new RegExp(unknown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(await readFile(join(unknown, 'retained'), 'utf8'), 'must not discard')
    await closeElectronTestApplication(application)
    application = undefined
    const retained = join(root, 'retained-unknown')
    await rename(unknown, retained)
    application = await launchApplication(root)
    await expect((await application.firstWindow()).locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    assert.equal(await readFile(join(retained, 'retained'), 'utf8'), 'must not discard')
    console.log('Plugin transactions Electron E2E passed: interrupted preparation, replacement/removal rollback, committed cleanup, retained data, complete examples and visible recovery error for unknown state.')
  } finally {
    await closeElectronTestApplication(application)
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyPluginTransactions }
