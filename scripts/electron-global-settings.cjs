const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function expectTitlebarMenuPosition(page, button) {
  const anchor = await button.boundingBox()
  assert.ok(anchor)
  await expect.poll(() => page.getByRole('menu').evaluate((menu, anchor) => {
    const overlay = globalThis.navigator.windowControlsOverlay
    const titlebarBottom = overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0
    const bounds = menu.getBoundingClientRect()
    const expectedTop = Math.max(anchor.y + anchor.height + 8, titlebarBottom + 12)
    const centeredLeft = anchor.x + anchor.width / 2 - bounds.width / 2
    const expectedLeft = Math.max(12, Math.min(centeredLeft, globalThis.innerWidth - 12 - bounds.width))
    return { belowButton: Math.abs(bounds.top - expectedTop) <= 1,
      centeredOrClamped: Math.abs(bounds.left - expectedLeft) <= 1 }
  }, anchor), { message: 'Both titlebar menus must center below their buttons, clamp inside the window, and clear native controls.' })
    .toEqual({ belowButton: true, centeredOrClamped: true })
  return page.getByRole('menu').evaluate((menu, anchor) => {
    const bounds = menu.getBoundingClientRect()
    return Math.abs(bounds.left + bounds.width / 2 - anchor.x - anchor.width / 2) > 1
  }, anchor)
}

async function verifyGlobalSettings(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-global-settings-'))
  let application
  try {
    const extraFolder = join(root, 'extra')
    await mkdir(extraFolder)
    application = await launchApplication(root)
    const page = await application.firstWindow()
    await page.waitForSelector('[data-agent-composer-input]')
    const projectNames = await page.evaluate(async (root) => {
      await globalThis.gale.config.updateSettings({ language: 'en' })
      const project = (await globalThis.gale.projects.list()).find((item) => item.id === 'default-workspace')
      const capabilities = {
        ...project.capabilities, profile: false, subagents: { mode: 'off', names: [] }, memory: false,
        skills: { ...project.capabilities.skills, mode: 'off' }, mcp: { defaultMode: 'selected', servers: [] }
      }
      const first = await globalThis.gale.projects.create({ ...project, name: 'Custom workspace', capabilities })
      const second = await globalThis.gale.projects.create({ ...project, name: 'Other workspace', sourceFolders: [root], skillDirectories: [root] })
      if (first.status !== 'ok' || second.status !== 'ok') throw new Error('Project fixture setup failed.')
      return [first.value.name, second.value.name]
    }, root)
    await application.evaluate(({ ipcMain }, extraFolder) => {
      globalThis.__globalSettingsReloads = 0
      ipcMain.removeHandler('mcp:reloadFailed')
      ipcMain.handle('mcp:reloadFailed', () => {
        globalThis.__globalSettingsReloads += 1
        return { scheduled: false, reason: 'no_servers' }
      })
      ipcMain.removeHandler('skills:get')
      ipcMain.handle('skills:get', (_event, projectId, skillDirectories) => {
        const roots = ['system', 'user', ...(projectId && skillDirectories?.length ? ['project'] : []), ...(skillDirectories?.length > 1 ? ['project-extra'] : [])].map((id) => ({
          id, kind: id.startsWith('project') ? 'project' : id, name: `${id} directory`, shortcutAlias: id,
          path: `/skills/${id}`, removable: false, available: true
        }))
        return { projectId, roots, skills: roots.map((source) => ({
          id: `${source.id}:search`, rootId: source.id, name: `${source.id}-search`, description: 'Search skill',
          modelAvailable: true, userAvailable: true, linked: false, dirPath: `${source.path}/search`,
          relativePath: 'search', source: source.kind, rootName: source.name, shortcutAlias: source.shortcutAlias,
          shortcut: `/${source.id}-search`
        })) }
      })
      ipcMain.removeHandler('projects:chooseSourceFolders')
      ipcMain.handle('projects:chooseSourceFolders', () => ({ status: 'ok', value: [extraFolder] }))
      ipcMain.removeHandler('projects:chooseSkillDirectories')
      ipcMain.handle('projects:chooseSkillDirectories', () => ({ status: 'ok', value: [extraFolder] }))
    }, extraFolder)
    await page.reload()
    let globalPreferences = ''
    for (const name of projectNames) {
      await page.locator('.project-thread-group').filter({ has: page.locator('.project-thread-label', { hasText: name }) })
        .locator('.project-thread-new-chat').click()
      if (name === 'Other workspace') {
        await page.locator('[data-agent-composer-input]').fill('/project')
        await expect(page.locator('.composer-suggestion-apply').filter({ hasText: 'project-search' })).toBeVisible()
        await page.locator('[data-agent-composer-input]').fill('')
        await page.locator('.project-thread-group').filter({ hasText: name }).locator('.project-thread-more').click()
        await page.locator('.project-details-action').filter({ hasText: /Edit/ }).click()
        const dialog = page.locator('.project-dialog')
        const dialogEdges = await dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const titlebar = globalThis.navigator.windowControlsOverlay?.getTitlebarAreaRect()
          return {
            top: bounds.top,
            bottomGap: globalThis.innerHeight - bounds.bottom,
            titlebarBottom: globalThis.document.documentElement.dataset.platform === 'win32' ? (titlebar?.bottom || 36) : 0
          }
        })
        const topInset = Math.max(18, dialogEdges.titlebarBottom + 4)
        assert.ok(dialogEdges.top >= topInset - 1, 'Project editing must clear the window title bar.')
        assert.ok(dialogEdges.bottomGap >= 17, 'Project editing must keep space below the footer.')
        assert.ok(Math.abs(dialogEdges.top - topInset - (dialogEdges.bottomGap - 18)) < 2,
          'Project editing must be centered between the title bar and the bottom inset.')
        await dialog.getByRole('button', { name: 'Add folders', exact: true }).click()
        await expect(dialog.locator('.project-folder-item')).toHaveCount(2)
        await dialog.getByRole('button', { name: 'Add skill directories', exact: true }).click()
        await dialog.locator('button[type="submit"]').click()
        await expect(dialog).not.toBeVisible()
        await page.locator('[data-agent-composer-input]').fill('/project-extra')
        await expect(page.locator('.composer-suggestion-apply').filter({ hasText: 'project-extra-search' })).toBeVisible()
        await page.locator('[data-agent-composer-input]').fill('')
      }
      const composer = page.locator('[data-agent-composer-input]')
      await composer.fill('/')
      await expect(page.locator('.composer-suggestions')).toBeVisible()
      await page.locator('.sidebar-settings').click()
      await page.locator('.app-menu-item').first().click()
      await expect(page.locator('main.settings-workspace')).toBeVisible()
      await expect(page.locator('.composer-suggestions')).toHaveCount(0)
      await page.locator('[data-settings-tab="general"]').click()
      await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
      await expect(page.locator('[data-settings-tab="appearance"], [data-settings-tab="localData"]')).toHaveCount(0)
      for (const heading of ['Assistant profile', 'Appearance', 'Data management']) {
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      }
      await expect(page.getByRole('heading', { name: 'User profile', exact: true })).toHaveCount(0)
      await expect(page.locator('#assistant-instructions-input')).toHaveCount(0)
      const role = page.locator('#assistant-role-input')
      await role.fill('Use concise examples.')
      await role.blur()
      await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.profile.assistant.role)).toBe('Use concise examples.')
      const assistantName = `Assistant for ${name}`
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(assistantName)
      await page.getByRole('textbox', { name: 'Name', exact: true }).blur()
      await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.profile.assistant.name)).toBe(assistantName)
      await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByText('Dark', { exact: true }).click()
      await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.theme)).toBe('dark')
      const titlebarIcon = page.getByRole('checkbox', { name: 'Titlebar icon', exact: true })
      await expect(titlebarIcon).toBeChecked()
      await titlebarIcon.uncheck()
      await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.showThemeInTitlebar)).toBe(false)
      await expect(page.locator('.topbar').getByRole('button', { name: /^Theme: / })).toHaveCount(0)
      await titlebarIcon.check()
      await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.showThemeInTitlebar)).toBe(true)
      if (process.env.ANAS_E2E_GENERAL_SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_GENERAL_SETTINGS_SCREENSHOT })
      await page.getByRole('button', { name: 'Clean up...', exact: true }).click()
      const cleanup = page.getByRole('alertdialog')
      await expect(cleanup).toBeVisible()
      await cleanup.getByRole('button', { name: 'Cancel', exact: true }).click()
      for (const tab of ['general', 'subagents', 'skills', 'memory', 'mcp']) {
        await page.locator(`[data-settings-tab="${tab}"]`).click()
        await expect(page.locator('.settings-page-header [role="img"]')).toHaveCount(0)
      }
      const reload = page.getByRole('button', { name: 'Restart failed MCP servers', exact: true })
      await expect(reload).toBeEnabled()
      await reload.click()
      await page.locator('[data-settings-tab="skills"]').click()
      await page.getByRole('button', { name: /^All Skills/ }).click()
      await page.getByRole('button', { name: 'Expand group “All Skills”', exact: true }).click()
      await expect(page.locator('.settings-skill-tree-split:not(.settings-skill-tree-root) .settings-skill-tree-select')).toHaveCount(2)
      await expect(page.locator('.settings-skill-tree')).not.toContainText('project-search')
      await expect(page.locator('.settings-skill-tree')).not.toContainText('Project')
      await page.locator('[data-settings-tab="memory"]').click()
      const memory = page.locator('.settings-global-memory')
      if (globalPreferences) await expect(memory).toContainText(globalPreferences)
      await memory.getByRole('button', { name: 'Edit', exact: true }).click()
      const editor = memory.getByRole('region', { name: 'MEMORY.md' })
      await editor.locator('.monaco-editor .view-lines').click()
      await page.keyboard.press('ControlOrMeta+a')
      globalPreferences = [globalPreferences, `Memory from ${name}`].filter(Boolean).join('\n')
      await page.keyboard.insertText(globalPreferences)
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(() => page.evaluate(async () => (await globalThis.gale.preferences.read({ kind: 'global' })).content.split(/\r?\n/))).toEqual(globalPreferences.split('\n'))
      if (process.env.ANAS_E2E_GLOBAL_SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_GLOBAL_SETTINGS_SCREENSHOT })
      await page.getByRole('button', { name: 'Back to app', exact: true }).click()
      await expect(composer).toHaveValue('/')
      await expect(page.locator('.composer-suggestions')).toBeVisible()
      await composer.fill('')
      const themeButton = page.locator('.topbar').getByRole('button', { name: /^Theme: / })
      await expect(themeButton).toBeVisible()
      assert.equal(await themeButton.evaluate(element => element.nextElementSibling?.getAttribute('aria-label')), 'Workspace menu')
      for (const [label, value] of [['Light', 'light'], ['Dark', 'dark']]) {
        await themeButton.click()
        await expect(themeButton).toHaveAccessibleName(`Theme: ${label}`)
        await expect(page.getByRole('menu')).toHaveCount(0)
        await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.theme)).toBe(value)
        await expect(page.locator('html')).toHaveAttribute('data-theme', value)
      }
      async function chooseTheme(label, value) {
        const previous = await page.evaluate(async () => (await globalThis.gale.config.get()).settings.theme)
        await themeButton.click({ button: 'right' })
        const choices = page.getByRole('menuitemradio')
        await expect(choices).toHaveCount(3)
        await expectTitlebarMenuPosition(page, themeButton)
        await expect(page.getByRole('menuitemradio', { name: { system: 'System', light: 'Light', dark: 'Dark' }[previous], exact: true })).toBeChecked()
        assert.equal(await page.evaluate(async () => (await globalThis.gale.config.get()).settings.theme), previous)
        await page.getByRole('menuitemradio', { name: label, exact: true }).click()
        await expect(page.getByRole('menu')).toHaveCount(0)
        await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.theme)).toBe(value)
      }
      await chooseTheme('System', 'system')
      for (const systemAppearance of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: systemAppearance })
        await expect(page.locator('html')).toHaveAttribute('data-theme', systemAppearance)
        await expect(themeButton).toHaveAccessibleName('Theme: System')
        await themeButton.click()
        const next = systemAppearance === 'dark' ? 'light' : 'dark'
        await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.theme)).toBe(next)
        await expect(page.locator('html')).toHaveAttribute('data-theme', next)
        await chooseTheme('System', 'system')
      }
      await page.emulateMedia({ colorScheme: null })
      await chooseTheme('Light', 'light')
      await chooseTheme('Dark', 'dark')
      await chooseTheme('System', 'system')
      const menuPositions = new Set()
      for (const zoom of [0.8, 1.25, 1.5, 1]) {
        await application.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor), zoom)
        await chooseTheme('System', 'system')
        const workspaceMenu = page.locator('.topbar').getByRole('button', { name: 'Workspace menu', exact: true })
        await workspaceMenu.click()
        await expect(page.getByRole('menu')).toBeVisible()
        menuPositions.add(await expectTitlebarMenuPosition(page, workspaceMenu) ? 'clamped' : 'centered')
        await page.keyboard.press('Escape')
      }
      assert.deepEqual([...menuPositions].sort(), ['centered', 'clamped'], 'Exercise both centered placement and window-edge clamping.')
      if (process.env.ANAS_E2E_THEME_SCREENSHOT) {
        await themeButton.click({ button: 'right' })
        await page.screenshot({ path: process.env.ANAS_E2E_THEME_SCREENSHOT })
        await page.keyboard.press('Escape')
      }
    }
    assert.equal(await application.evaluate(() => globalThis.__globalSettingsReloads), 2)
    await application.close()
    application = await launchApplication(root)
    const restarted = await application.firstWindow()
    await expect(restarted.locator('.topbar').getByRole('button', { name: 'Theme: System', exact: true })).toBeVisible()
    const settings = await restarted.evaluate(async () => (await globalThis.gale.config.get()).settings)
    assert.equal(settings.theme, 'system')
    assert.equal(settings.showThemeInTitlebar, true)
    console.log('Global settings E2E passed: profile/theme saves, titlebar visibility, two-state left-click including system appearance changes, three-state right-click selection and restart persistence, cleanup access, project-independent pages, global skills and memories, MCP without a model, manual project skill directories, and composer suggestions hidden in settings while preserving the draft.')
  } finally {
    await application?.close()
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyGlobalSettings }
