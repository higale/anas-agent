const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function verifyCurrentData(launch) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'anas-current-data-e2e-'))
  const root = join(temporaryRoot, 'profile')
  const documents = join(temporaryRoot, 'documents')
  await mkdir(documents)
  async function launchApplication(dataRoot) {
    const instance = await launch(dataRoot)
    await instance.evaluate(({ app }, directory) => app.setPath('documents', directory), documents)
    return instance
  }
  let application
  try {
    await mkdir(join(root, 'config'), { recursive: true })
    const path = join(root, 'config/tools.json')
    await writeFile(path, JSON.stringify({ version: 0, order: ['user:example-read-text-raw'], external_directories: [] }))
    await writeFile(join(root, 'projects.json'), 'abandoned project metadata')
    await writeFile(join(root, 'input_history.json'), 'abandoned input history')
    const ignoredProjectFiles = ['db/projects.json', 'db/conversations/old/conversation.sqlite']
    await mkdir(join(root, 'db/conversations/old'), { recursive: true })
    for (const file of ignoredProjectFiles) await writeFile(join(root, file), 'ignored old layout')
    await mkdir(join(root, 'db/projects/personal notes'), { recursive: true })
    await writeFile(join(root, 'db/projects/.DS_Store'), 'Finder metadata')
    await writeFile(join(root, 'db/projects/personal notes/notes.txt'), 'User notes')
    await cp(resolve(__dirname, '../data/examples/tools/read_text_raw'), join(root, 'tools/read_text_raw'), { recursive: true })
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
    for (const file of ['settings', 'models', 'subagents', 'mcp_servers', 'skills', 'tools']) {
      assert.equal(JSON.parse(await readFile(join(root, `config/${file}.json`), 'utf8')).version, file === 'subagents' ? 1 : 0)
    }
    await assert.rejects(readFile(join(root, 'config/capabilities.json')), { code: 'ENOENT' })
    assert.equal(JSON.parse(await readFile(join(root, 'db/projects/state.json'), 'utf8')).version, 0)
    assert.equal(await readFile(join(root, 'projects.json'), 'utf8'), 'abandoned project metadata')
    assert.equal(await readFile(join(root, 'input_history.json'), 'utf8'), 'abandoned input history')
    await mkdir(join(root, 'sqlite'), { recursive: true })
    await writeFile(join(root, 'sqlite/agent.sqlite'), 'Keep unrelated historical data')
    await mkdir(join(root, 'db/projects/default-workspace/conversations/empty-folder'), { recursive: true })
    await writeFile(join(root, 'db/projects/default-workspace/conversations/.DS_Store'), 'Finder metadata')
    application = await launchApplication(root)
    await expect((await application.firstWindow()).locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    const projectCreated = await (await application.firstWindow()).evaluate(() => globalThis.gale.projects.create({
      kind: 'simple_chat', name: 'Retained after database reset', prompt: 'Keep project prompt'
    }))
    assert.equal(projectCreated.status, 'ok')
    await closeElectronTestApplication(application)
    application = undefined
    const projectsBeforeReset = await readFile(join(root, 'db/projects/state.json'))
    await mkdir(join(root, 'db/projects/default-workspace/conversations/reset-scope-fixture'), { recursive: true })
    await writeFile(join(root, 'db/projects/default-workspace/conversations/reset-scope-fixture/material.txt'), 'Retained in preservation copy')
    await promisify(execFile)(require('electron'), ['-e', `
      const Database = require('better-sqlite3');
      const db = new Database(require('node:path').join(process.argv[1], 'db/catalog.sqlite'));
      db.pragma('user_version = 1'); db.close();
    `, root], { cwd: resolve(__dirname, '..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    application = await launchApplication(root)
    const databaseRecovery = await application.firstWindow()
    await expect(databaseRecovery.locator('.initial-app-status-error')).toBeVisible({ timeout: 20000 })
    const resetPlan = await databaseRecovery.evaluate(() => globalThis.gale.recovery.inspect())
    assert.equal(resetPlan.preservationParent, join(documents, 'Anas/recovery'))
    await databaseRecovery.getByRole('button', { name: /^(重置全部项目与会话|Reset all projects and conversations)$/ }).click()
    const allResetDialog = databaseRecovery.getByRole('alertdialog')
    assert.deepEqual(await allResetDialog.locator('li code').allTextContents(), resetPlan.resetTargets.projects.map(target => target.path))
    await allResetDialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
    await databaseRecovery.getByRole('button', { name: /^(重置会话数据库|Reset conversation database)$/ }).click()
    const resetDialog = databaseRecovery.getByRole('alertdialog')
    assert.deepEqual(await resetDialog.locator('li code').allTextContents(), resetPlan.resetTargets.execution.map(target => target.path))
    assert.ok(!resetPlan.resetTargets.execution.some(target => target.path.endsWith('/projects.json')))
    if (process.env.ANAS_E2E_RESET_SCREENSHOT) await databaseRecovery.screenshot({ path: process.env.ANAS_E2E_RESET_SCREENSHOT })
    await resetDialog.getByRole('button', { name: /^(重置会话数据库|Reset conversation database)$/ }).click()
    await expect(databaseRecovery.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
    assert.deepEqual(await readFile(join(root, 'db/projects/state.json')), projectsBeforeReset)
    const resetStatus = await databaseRecovery.evaluate(() => globalThis.gale.recovery.inspect())
    assert.equal(dirname(resetStatus.lastPreservationPath), await realpath(join(documents, 'Anas/recovery')))
    assert.deepEqual(await readFile(join(resetStatus.lastPreservationPath, 'data/db/projects/state.json')), projectsBeforeReset)
    assert.equal(await readFile(join(resetStatus.lastPreservationPath, 'data/db/projects/default-workspace/conversations/reset-scope-fixture/material.txt'), 'utf8'), 'Retained in preservation copy')
    await assert.rejects(readFile(join(root, 'db/projects/default-workspace/conversations/reset-scope-fixture/material.txt')), { code: 'ENOENT' })
    await closeElectronTestApplication(application)
    application = await launchApplication(root)
    const afterReset = await application.firstWindow()
    await expect(afterReset.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    assert.ok((await afterReset.evaluate(() => globalThis.gale.projects.list())).some(project => project.name === 'Retained after database reset'))
    await closeElectronTestApplication(application)
    application = undefined
    for (const invalid of ['{"order":["user:example-read-text-raw"]}', '{"version":1,"order":["user:example-read-text-raw"]}']) {
      await writeFile(path, invalid)
      const numbered = Object.hasOwn(JSON.parse(invalid), 'version')
      if (numbered) {
        const projects = JSON.parse(await readFile(join(root, 'db/projects/state.json'), 'utf8'))
        await writeFile(join(root, 'db/projects/state.json'), JSON.stringify({ ...projects, version: 4 }))
        await promisify(execFile)(require('electron'), ['-e', `
          const Database = require('better-sqlite3');
          const db = new Database(require('node:path').join(process.argv[1], 'db/catalog.sqlite'));
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
          const projectsBefore = await readFile(join(root, 'db/projects/state.json'), 'utf8')
          await failed.getByRole('group', { name: 'projects.json', exact: true }).getByRole('button', { name: /^(修复|Repair)$/ }).click()
          await failed.getByRole('alertdialog').getByRole('button', { name: /^(修复|Repair)$/ }).click()
          await expect.poll(async () => JSON.parse(await readFile(join(root, 'db/projects/state.json'), 'utf8')).version, { timeout: 15000 }).toBe(0)
          await expect(failed.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
          const status = await failed.evaluate(() => globalThis.gale.recovery.inspect())
          assert.equal(status.files.find(file => file.name === 'projects.json').error, undefined)
          assert.equal(await readFile(join(status.lastPreservationPath, 'data/db/projects/state.json'), 'utf8'), projectsBefore)
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
    for (const file of ['input_history.json', 'config/assets/avatar-transform.json']) {
      const relative = file === 'input_history.json' ? 'db/input_history.json' : file
      const current = file === 'input_history.json' ? history : JSON.parse(await readFile(join(root, relative), 'utf8'))
      const invalid = JSON.stringify({ ...current, version: 1 })
      await writeFile(join(root, relative), invalid)
      application = await launchApplication(root)
      const recovery = await application.firstWindow()
      await expect(recovery.getByRole('group', { name: file, exact: true })).toBeVisible({ timeout: 20000 })
      await expect(recovery.locator('[data-agent-composer-input]')).toHaveCount(0)
      await expect(recovery.locator('.app-issue-tray')).toHaveCount(0)
      assert.equal(await readFile(join(root, relative), 'utf8'), invalid)
      await recovery.getByRole('group', { name: file, exact: true }).getByRole('button', { name: /^(修复|Repair)$/ }).click()
      await recovery.getByRole('alertdialog').getByRole('button', { name: /^(修复|Repair)$/ }).click()
      await expect(recovery.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
      const status = await recovery.evaluate(() => globalThis.gale.recovery.inspect())
      assert.equal(status.files.find(item => item.name === file).error, undefined)
      assert.equal(await readFile(join(status.lastPreservationPath, 'data', relative), 'utf8'), invalid)
      assert.deepEqual(JSON.parse(await readFile(join(root, relative), 'utf8')), { ...current, version: 0 })
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
    await writeFile(join(root, 'db/input_history.json'), mixedHistory)
    const sourceName = (await readdir(join(root, 'config', 'assets'))).find(name => /^avatar-source\./.test(name))
    assert.ok(sourceName)
    const cropBefore = await readFile(join(root, 'config/assets/avatar-crop.png'))
    await writeFile(join(root, 'config', 'assets', sourceName), 'damaged avatar source')
    await rm(join(root, 'config/assets/avatar.png'))
    await rm(join(root, 'config/assets/avatar-dock.png'))
    application = await launchApplication(root)
    const rescue = await application.firstWindow()
    await expect(rescue.getByRole('group', { name: 'input_history.json', exact: true })).toBeVisible({ timeout: 20000 })
    await expect(rescue.getByRole('group', { name: 'config/assets/avatar-transform.json', exact: true })).toBeVisible()
    await expect(rescue.locator('[data-agent-composer-input]')).toHaveCount(0)
    for (const file of ['input_history.json', 'config/assets/avatar-transform.json']) {
      await rescue.getByRole('group', { name: file, exact: true }).getByRole('button', { name: /^(修复|Repair)$/ }).click()
      await rescue.getByRole('alertdialog').getByRole('button', { name: /^(修复|Repair)$/ }).click()
      await expect(rescue.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
      const status = await rescue.evaluate(() => globalThis.gale.recovery.inspect())
      assert.equal(status.files.find(item => item.name === file).error, undefined)
      if (file === 'input_history.json') {
        assert.equal(await readFile(join(status.lastPreservationPath, 'data/db/input_history.json'), 'utf8'), mixedHistory)
        await expect(rescue.getByText(/已部分修复|Partially repaired/)).toBeVisible()
      } else {
        assert.equal(await readFile(join(status.lastPreservationPath, 'data/config/assets', sourceName), 'utf8'), 'damaged avatar source')
        assert.deepEqual(await readFile(join(root, 'config/assets/avatar-crop.png')), cropBefore)
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
    await closeElectronTestApplication(application)
    application = undefined
    await writeFile(join(root, 'db/projects/state.json'), 'broken current state')
    application = await launchApplication(root)
    const fullReset = await application.firstWindow()
    await expect(fullReset.locator('.initial-app-status-error')).toBeVisible({ timeout: 20000 })
    await fullReset.getByRole('button', { name: /^(重置全部项目与会话|Reset all projects and conversations)$/ }).click()
    await fullReset.getByRole('alertdialog').getByRole('button', { name: /^(重置全部项目与会话|Reset all projects and conversations)$/ }).click()
    await expect(fullReset.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
    const fullResetStatus = await fullReset.evaluate(() => globalThis.gale.recovery.inspect())
    assert.equal(fullResetStatus.files.find(file => file.name === 'projects.json').error, undefined)
    assert.equal(await readFile(join(fullResetStatus.lastPreservationPath, 'data/db/projects/state.json'), 'utf8'), 'broken current state')
    for (const file of ignoredProjectFiles) assert.equal(await readFile(join(root, file), 'utf8'), 'ignored old layout')
    await closeElectronTestApplication(application)
    application = await launchApplication(root)
    await expect((await application.firstWindow()).locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    await closeElectronTestApplication(application)
    application = undefined
    await rm(join(root, 'db/projects'), { recursive: true })
    application = await launchApplication(root)
    await expect((await application.firstWindow()).locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    await closeElectronTestApplication(application)
    application = undefined
    await rm(join(root, 'db/projects'), { recursive: true })
    await promisify(execFile)(require('electron'), ['-e', `
      const Database = require('better-sqlite3');
      const db = new Database(require('node:path').join(process.argv[1], 'db/catalog.sqlite'));
      db.prepare("INSERT INTO agent_conversations (id,title,project_id,pinned,access_mode,status,user_turn_count,has_queued_inputs,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run('missing-conversation', 'Preserve missing conversation evidence', 'default-workspace', 0, 'smart_approval', 'idle', 0, 0, '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z');
      db.close();
    `, root], { cwd: resolve(__dirname, '..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    application = await launchApplication(root)
    const missingProjects = await application.firstWindow()
    const projectRecovery = missingProjects.getByRole('group', { name: 'projects.json', exact: true })
    await expect(projectRecovery).toBeVisible({ timeout: 20000 })
    await projectRecovery.getByRole('button', { name: /^(修复|Repair)$/ }).click()
    await missingProjects.getByRole('alertdialog').getByRole('button', { name: /^(修复|Repair)$/ }).click()
    await expect(missingProjects.locator('.initial-app-status-error')).toHaveAttribute('aria-busy', 'false')
    const repairedProjects = await missingProjects.evaluate(() => globalThis.gale.recovery.inspect())
    assert.ok(repairedProjects.lastPreservationPath)
    await closeElectronTestApplication(application)
    application = await launchApplication(root)
    await expect((await application.firstWindow()).locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    const backupPage = await application.firstWindow()
    async function readMainLogs() {
      const directory = join(root, 'log')
      const files = (await readdir(directory)).filter(file => file.endsWith('_main.log'))
      return (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('\n')
    }
    const skillFailure = await backupPage.evaluate(async () => {
      try {
        await globalThis.gale.skills.get('default-workspace', ['relative-skill-source'])
        return ''
      } catch (error) {
        return error.message
      }
    })
    assert.match(skillFailure, /Skill source folders must be absolute directory paths/)
    assert.ok(skillFailure.includes('sourceFolders[0]="relative-skill-source"; project="default-workspace"'))
    await expect.poll(readMainLogs).toMatch(/\[ipc\] IPC request failed\.[\s\S]*channel: 'skills:get'[\s\S]*Skill source folders must be absolute directory paths[\s\S]*stack:/)
    await expect.poll(readMainLogs).toContain('sourceFolders[0]="relative-skill-source"; project="default-workspace"')
    await application.evaluate(({ dialog }, archive) => {
      dialog.showSaveDialog = async (_parent, options) => {
        globalThis.__backupDefaultPath = options.defaultPath
        return { canceled: false, filePath: archive }
      }
    }, join(temporaryRoot, 'manual.zip'))
    const backup = await backupPage.evaluate(() => globalThis.gale.app.backupData())
    assert.equal(dirname(await application.evaluate(() => globalThis.__backupDefaultPath)), join(documents, 'Anas/backups'))
    async function confirmRestore(archive) {
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
      }, archive)
      await backupPage.locator('.sidebar-settings').click()
      await backupPage.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click()
      await backupPage.locator('[data-settings-tab="general"]').click()
      await backupPage.getByRole('button', { name: /^(恢复|Restore)$/ }).click()
      await backupPage.getByRole('alertdialog').getByRole('button', { name: /^(恢复|Restore)$/ }).click()
    }
    const invalidBackup = join(temporaryRoot, 'invalid.zip')
    await writeFile(invalidBackup, 'not a ZIP archive')
    await confirmRestore(invalidBackup)
    const restoreFailure = backupPage.getByRole('alert')
    await expect(restoreFailure).toContainText(/恢复数据目录失败|Failed to restore/)
    await expect.poll(readMainLogs).toMatch(/\[ipc\] IPC request failed\.[\s\S]*channel: 'app:restoreData'[\s\S]*stack:/)
    await expect(backupPage.locator('.sidebar-settings')).toHaveCount(0)
    if (process.env.ANAS_E2E_RESTORE_ERROR_SCREENSHOT) await backupPage.screenshot({ path: process.env.ANAS_E2E_RESTORE_ERROR_SCREENSHOT })
    await backupPage.getByRole('button', { name: /^(重新加载|Reload)$/ }).click()
    await expect(backupPage.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })

    const restoreUi = []
    await backupPage.exposeFunction('__recordRestoreUi', record => restoreUi.push(record))
    await backupPage.evaluate(() => {
      const capture = () => {
        for (const node of globalThis.document.querySelectorAll('[role="status"], [data-sonner-toast]')) {
          if (/正在恢复数据|Restoring data/.test(node.textContent ?? '')) void globalThis.__recordRestoreUi('restoring')
          if (node.getAttribute('data-type') === 'error') void globalThis.__recordRestoreUi(`error: ${node.textContent}`)
        }
      }
      new globalThis.MutationObserver(capture).observe(globalThis.document.body, { childList: true, subtree: true, characterData: true })
    })
    const reloaded = backupPage.waitForEvent('domcontentloaded')
    await confirmRestore(backup.path)
    await reloaded
    await expect(backupPage.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 20000 })
    assert.ok(restoreUi.includes('restoring'), 'Restore must replace the normal app with a pending view.')
    assert.deepEqual(restoreUi.filter(value => value.startsWith('error:')), [], 'Restoring must not trigger background loading error notices.')
    const preRestoreRoot = join(documents, 'Anas/backups/before-restore')
    const copies = await readdir(preRestoreRoot)
    assert.equal(copies.length, 1)
    const archives = await readdir(join(preRestoreRoot, copies[0]))
    assert.equal(archives.length, 1)
    assert.ok((await readFile(join(preRestoreRoot, copies[0], archives[0]))).length > 0)
    console.log('Current-data Electron E2E passed: configuration and native storage repair, Documents preservation and backup restore, full reset, missing project initialization, missing conversation isolation and usable restart.')
  } finally {
    await closeElectronTestApplication(application)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

module.exports = { verifyCurrentData }
