const assert = require('node:assert/strict')
const { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function verifySkillSettings(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-skill-settings-e2e-'))
  let application
  try {
    const configFile = join(root, 'config', 'skills.json')
    const legacyConfig = JSON.stringify({ version: 0, external_directories: [], availability: {},
      script_auto_approve: true, script_auto_approve_skills: ['system:config'] })
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(configFile, legacyConfig)
    const longDescription = 'Long description. '.repeat(83) + 'x'.repeat(16)
    await mkdir(join(root, 'skills', 'long-description'), { recursive: true })
    await writeFile(join(root, 'skills', 'long-description', 'SKILL.md'), `---\nname: long-description\ndescription: ${longDescription}\n---\n\nUse this skill.\n`)
    application = await launchApplication(root)
    let page = await application.firstWindow()
    await page.waitForSelector('[data-agent-composer-input]')
    const initial = await page.evaluate(() => globalThis.gale.skills.get())
    assert.equal(Object.hasOwn(initial, 'scriptAutoApprove'), false)
    assert.equal(initial.skills.some(skill => Object.hasOwn(skill, 'scriptAutoApprove')), false)
    assert.equal(await readFile(configFile, 'utf8'), legacyConfig, 'Reading retired settings must not rewrite the file.')
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
    await page.reload()
    await page.waitForSelector('[data-agent-composer-input]')
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="skills"]').click()
    const global = page.getByRole('checkbox', { name: 'Auto-approve Skill scripts', exact: true })
    await expect(global).toHaveCount(0)
    await page.locator('.settings-skill-tree-root').filter({ hasText: 'System' }).locator('.settings-skill-tree-toggle').click()
    await page.locator('.settings-skill-tree-select').filter({ hasText: /^config$/ }).click()
    await expect(page.getByRole('checkbox', { name: 'Auto-approve scripts', exact: true })).toHaveCount(0)
    const current = () => page.evaluate(async () => {
      const snapshot = await globalThis.gale.skills.get()
      const skill = snapshot.skills.find(skill => skill.id === 'system:config')
      return { model: skill.modelAvailable, shortcut: skill.userAvailable }
    })
    const model = page.getByRole('checkbox', { name: 'Available to model', exact: true })
    const user = page.getByRole('checkbox', { name: 'Shortcut', exact: true })
    await expect(model).toBeChecked()
    await expect(user).toBeChecked()
    await model.press('Space')
    await expect.poll(current).toEqual({ model: false, shortcut: true })
    await user.press('Space')
    await expect.poll(current).toEqual({ model: false, shortcut: false })
    await model.press('Space')
    await expect.poll(current).toEqual({ model: true, shortcut: false })
    await user.press('Space')
    await expect.poll(current).toEqual({ model: true, shortcut: true })
    const viewer = page.locator('.settings-skill-viewer')
    await expect(viewer.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0)
    const path = await page.evaluate(async () => (await globalThis.gale.skills.get()).skills.find(skill => skill.id === 'system:config').dirPath)
    const location = viewer.getByRole('button', { name: path, exact: true })
    await expect(location).toBeVisible()
    const shortcut = viewer.getByText('/config', { exact: true })
    assert.ok((await location.boundingBox()).y < (await shortcut.boundingBox()).y, 'Skill location belongs above its shortcut.')
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('files:showItemInFolder')
      ipcMain.handle('files:showItemInFolder', (_event, path) => { globalThis.__revealedSkill = path })
    })
    await location.click()
    await expect.poll(() => application.evaluate(() => globalThis.__revealedSkill)).toBe(path)
    if (process.env.ANAS_E2E_SKILL_SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_SKILL_SETTINGS_SCREENSHOT })
    await model.press('Space')
    await expect.poll(current).toEqual({ model: false, shortcut: true })
    await page.locator('.settings-skill-tree-root').filter({ hasText: /^User/ }).locator('.settings-skill-tree-toggle').click()
    await page.locator('.settings-skill-tree-select').filter({ hasText: /^long-description$/ }).click()
    await expect(viewer.getByRole('img', { name: /description exceeds/ })).toBeVisible()
    await expect(viewer.getByRole('img', { name: /description exceeds/ })).toHaveAttribute('data-tooltip', new RegExp(`currently ${longDescription.length}`))
    const titleBox = await viewer.getByRole('button', { name: 'long-description', exact: true }).boundingBox()
    const warningBox = await viewer.getByRole('img', { name: /description exceeds/ }).boundingBox()
    assert.ok(Math.abs(titleBox.y + titleBox.height / 2 - warningBox.y - warningBox.height / 2) < 2, 'Warning belongs beside the skill name.')
    await expect(model).toBeEnabled()
    await expect(model).toBeChecked()
    await expect(user).toBeEnabled()
    await expect(user).toBeChecked()
    const invocation = await page.evaluate(() => globalThis.gale.skills.invoke(undefined, 'long-description', undefined, 'Use it'))
    assert.ok(invocation.promptText.includes(longDescription), 'Shortcut must preserve the complete description.')
    if (process.env.ANAS_E2E_SKILL_WARNING_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_SKILL_WARNING_SCREENSHOT })
    const names = ['z-imported', 'a-imported']
    const sources = await Promise.all(names.map(async name => {
      const source = join(root, 'incoming', name)
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Imported example\n---\n`)
      return source
    }))
    const guides = join(root, 'incoming', 'shared-guides')
    await mkdir(guides)
    await writeFile(join(guides, 'walkthrough.md'), 'Open this linked guide.')
    await symlink(guides, join(sources[0], 'linked-guides'), process.platform === 'win32' ? 'junction' : 'dir')
    await application.evaluate(({ dialog }, paths) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original
        return { canceled: false, filePaths: paths }
      }
    }, sources)
    await page.getByRole('button', { name: 'Import skill', exact: true }).click()
    await expect(viewer.getByRole('button', { name: 'z-imported', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => globalThis.gale.skills.get().then(snapshot =>
      snapshot.skills.filter(skill => skill.source === 'user').map(skill => skill.name)))).toEqual(expect.arrayContaining(names))
    await rename(join(root, 'incoming'), join(root, 'moved-source'))
    await page.getByRole('button', { name: 'Expand Skill “z-imported”', exact: true }).click()
    await page.getByRole('button', { name: 'linked-guides', exact: true }).click()
    await page.getByRole('button', { name: 'walkthrough.md', exact: true }).click()
    await expect(viewer.getByText('Open this linked guide.', { exact: true })).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled()
    await page.evaluate(async () => {
      const id = 'user:z-imported', path = 'linked-guides/walkthrough.md'
      const preview = await globalThis.gale.skills.readFile(undefined, id, path)
      await globalThis.gale.skills.saveFile(undefined, id, path, {
        content: 'Edited after import.', revision: preview.revision, resolvedPath: preview.resolvedPath
      })
    })
    assert.equal(await readFile(join(root, 'skills', 'z-imported', 'linked-guides', 'walkthrough.md'), 'utf8'), 'Edited after import.')
    assert.equal(await readFile(join(root, 'moved-source', 'shared-guides', 'walkthrough.md'), 'utf8'), 'Open this linked guide.')
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('skills:importDirectories')
      ipcMain.handle('skills:importDirectories', () => ({
        status: 'completed', names: [],
        failures: Array.from({ length: 60 }, (_, i) => ({ name: `skill-${i + 1}`, error: { code: 'failed', detail: 'Disk full' } }))
      }))
    })
    await page.getByRole('button', { name: 'Import skill', exact: true }).click()
    const details = page.locator('[data-sonner-toast] [data-description]').filter({ hasText: 'skill-60' })
    await expect(details).toBeVisible()
    await details.hover()
    await page.mouse.wheel(0, await details.evaluate(el => el.scrollHeight))
    await expect.poll(() => details.evaluate(el => {
      const text = el.firstChild
      const line = el.ownerDocument.createRange()
      line.setStart(text, text.textContent.lastIndexOf('skill-60'))
      line.setEnd(text, text.length)
      const rect = line.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      return el.scrollTop > 0 && rect.top >= box.top && rect.bottom <= Math.min(box.bottom + 1, el.ownerDocument.documentElement.clientHeight)
    })).toBe(true)
    await application.close()
    application = await launchApplication(root)
    page = await application.firstWindow()
    await page.waitForSelector('[data-agent-composer-input]')
    await expect.poll(current).toEqual({ model: false, shortcut: true })
    const saved = JSON.parse(await readFile(configFile, 'utf8'))
    assert.deepEqual(saved.availability['system:config'], { model_available: false, user_available: true })
    assert.equal(Object.hasOwn(saved, 'script_auto_approve'), false)
    assert.equal(Object.hasOwn(saved, 'script_auto_approve_skills'), false)
    console.log('Skill settings E2E passed: skill import and selection, scrollable import failures, availability persistence, keyboard toggles, location reveal, and long-description warning.')
  } finally {
    await application?.close().catch(() => undefined)
    assert.ok(root.startsWith(join(tmpdir(), 'anas-skill-settings-e2e-')))
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifySkillSettings }
