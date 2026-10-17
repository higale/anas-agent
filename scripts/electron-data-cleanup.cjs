const assert = require('node:assert/strict')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { basename, dirname, join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const settingsDefaults = require('../data/config/settings.json')

async function verifyDataCleanup(launchApplication) {
  const temporaryRoot = resolve(__dirname, '../tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'data-cleanup-e2e-'))
  assert.equal(dirname(root), temporaryRoot)
  assert.ok(basename(root).startsWith('data-cleanup-e2e-'))
  const data = join(root, 'profile'), documents = join(root, 'documents')
  let application
  const file = async (relative, content = 'fixture') => {
    const path = join(data, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  try {
    await mkdir(documents)
    await file('config/settings.json', JSON.stringify({ ...settingsDefaults, language: 'zh-CN', font_size: 18 }))
    application = await launchApplication(data)
    const page = await application.firstWindow()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })

    // Capture the real save-dialog options without opening a native dialog or writing a backup.
    await application.evaluate(({ app, dialog }, documents) => {
      app.setPath('documents', documents)
      dialog.showSaveDialog = async (...args) => {
        globalThis.__cleanupBackupDefault = args.at(-1).defaultPath
        return { canceled: true }
      }
    }, documents)
    await page.evaluate(() => globalThis.gale.app.backupData())
    assert.equal(dirname(await application.evaluate(() => globalThis.__cleanupBackupDefault)), documents)

    const unknown = ['assets/', 'attachments/', 'config/capabilities.json', 'config/custom_tools.json', 'file_edits/', 'old-backup.zip']
    for (const path of unknown) await file(path.endsWith('/') ? `${path}old.txt` : path)
    await file('cache/tool-results/retained.txt')
    await file('db/conversations/unregistered/retained.txt')
    const snapshot = await page.evaluate(() => globalThis.gale.app.getDataStorageUsage())
    assert.deepEqual(snapshot.unknownFiles, unknown)
    assert.equal(snapshot.cleanup.input_history.hasData, false)

    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: '设置', exact: true }).click()
    await page.locator('[data-settings-tab="general"]').click()
    await page.getByRole('button', { name: '清理...', exact: true }).click()
    const dialog = page.getByRole('alertdialog')
    const unknownItem = dialog.locator('.data-cleanup-option').filter({ hasText: '未知文件' })
    await expect(unknownItem.getByRole('checkbox')).toBeEnabled()
    await expect(unknownItem.getByRole('checkbox')).not.toBeChecked()
    await expect(dialog.locator('.data-cleanup-option').filter({ hasText: '输入历史' })).toHaveCount(0)
    await expect(dialog.locator('.data-cleanup-option').filter({ hasText: '记忆' })).toHaveCount(0)
    await dialog.locator('summary').click()
    assert.equal(await dialog.locator('pre').textContent(), unknown.join('\n'))
    const bounds = await dialog.boundingBox()
    const viewportHeight = await page.evaluate(() => globalThis.innerHeight)
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewportHeight, 'Expanded preview must fit inside the window.')
    if (process.env.ANAS_E2E_CLEANUP_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CLEANUP_SCREENSHOT })
    for (const checkbox of await dialog.locator('.data-cleanup-option').getByRole('checkbox').all()) {
      if (await checkbox.isChecked()) await checkbox.uncheck()
    }
    await unknownItem.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: '清理所选', exact: true }).click()
    await expect(dialog).not.toBeVisible({ timeout: 15000 })
    const after = await page.evaluate(() => globalThis.gale.app.getDataStorageUsage())
    assert.deepEqual(after.unknownFiles, [])
    assert.equal(after.cleanup.unknown_files.hasData, false)
    assert.equal(await readFile(join(data, 'cache/tool-results/retained.txt'), 'utf8'), 'fixture')
    assert.equal(await readFile(join(data, 'db/conversations/unregistered/retained.txt'), 'utf8'), 'fixture')
    await page.getByRole('button', { name: '清理...', exact: true }).click()
    await expect(dialog.locator('.data-cleanup-option').filter({ hasText: '未知文件' })).toHaveCount(0)
    assert.deepEqual(pageErrors, [])
    console.log('Data cleanup: Documents backup default, directory previews, empty categories and real IPC cleanup passed.')
  } finally {
    await closeElectronTestApplication(application)
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyDataCleanup }
