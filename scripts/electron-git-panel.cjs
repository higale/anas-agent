const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdir, mkdtemp, realpath, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')
const { panelPage, panelGeometry } = require('./electron-panel-helpers.cjs')
const { monacoState } = require('./electron-diff-view.cjs')

async function verifyTopbarActions(page) {
  const aligned = await page.locator('.topbar').evaluate((bar) => {
    const actions = bar.lastElementChild, title = bar.querySelector('.thread-topbar')
    return Math.abs(actions.getBoundingClientRect().right - (bar.getBoundingClientRect().right - Number.parseFloat(globalThis.getComputedStyle(bar).paddingRight))) < 1
      && title.getBoundingClientRect().right <= actions.getBoundingClientRect().left
  })
  assert.ok(aligned, 'Git and workspace actions must align to the right without overlapping the title.')
}

async function verifyPanelTogglePosition(application, page) {
  const hide = page.getByRole('button', { name: 'Hide right workspace', exact: true })
  const show = page.getByRole('button', { name: 'Show right workspace', exact: true })
  for (const zoom of [1, 0.5, 0.8, 1.5]) {
    await application.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
    // Zoom can remount the panel between docked and drawer layouts.
    await hide.click({ trial: true })
    const expanded = await hide.boundingBox()
    await hide.click()
    await expect(show).toBeFocused()
    const collapsed = await show.boundingBox()
    assert.ok(['x', 'y', 'width', 'height'].every((key) => Math.abs(expanded[key] - collapsed[key]) < 1),
      `The panel toggle must keep its position and hit area at zoom ${zoom}: ${JSON.stringify({ expanded, collapsed })}`)
    // Click the same screen coordinate to reopen, without moving to a new target.
    await page.mouse.click(collapsed.x + collapsed.width / 2, collapsed.y + collapsed.height / 2)
    await expect(hide).toBeVisible()
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
}

async function verifyGitPanelStates(launchApplication) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'anas-git-panel-e2e-')))
  let application
  try {
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    application = await launchApplication(home)
    application.process().stderr.on('data', chunk => { if (/Error|failed/i.test(String(chunk))) console.error(String(chunk).trim()) })
    const page = await application.firstWindow()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    await page.evaluate(async workspace => {
      const defaults = (await globalThis.gale.projects.list()).find(project => project.id === 'default-workspace')
      const created = await globalThis.gale.projects.create({ ...defaults, name: 'Git panel fixture', sourceFolders: [workspace] })
      if (created.status !== 'ok') throw new Error(JSON.stringify(created))
      await globalThis.gale.agent.workspace.set({ mode: 'new_thread', projectId: created.value.id, modelParameterPresetId: null })
    }, workspace)
    for (const language of ['zh-CN', 'en']) {
      await page.evaluate((language) => globalThis.gale.config.updateSettings({ language, theme: 'dark' }), language)
      await page.reload()
      await page.locator('[data-agent-composer-input]').waitFor()
      await verifyTopbarActions(page)
      await page.getByRole('button', { name: /^(文件改动|File changes)$/ }).click()
      const contentPage = await panelPage(application, 'files')
      const panel = contentPage.locator('.panel-content-root')
      await expect(panel.getByRole('status')).toHaveText(language === 'zh-CN'
        ? '此目录不是 Git 工作区，无法查看 Git 改动。'
        : 'This folder is not a Git working tree. Git changes are unavailable.')
      await expect(panel.getByRole('alert')).toHaveCount(0)
      await expect(panel.getByRole('combobox')).toHaveCount(0)
      await expect(panel.locator('.ui-diff-file-list')).toHaveCount(0)
      if (process.env.ANAS_E2E_GIT_PANEL_SCREENSHOT) await panel.screenshot({
        path: process.env.ANAS_E2E_GIT_PANEL_SCREENSHOT.replace(/\.png$/, `-${language}.png`)
      })
      if (language === 'zh-CN') await page.getByRole('tablist').getByRole('button', { name: /^(关闭|Close) / }).click()
    }
    const contentPage = await panelPage(application, 'files')
    const panel = contentPage.locator('.panel-content-root'), git = (...args) => promisify(execFile)('git', args, { cwd: workspace })
    await verifyTopbarActions(page)
    await verifyPanelTogglePosition(application, page)
    await git('init', '-b', 'main')
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(panel).toContainText('No Git changes in this scope.')
    const longLine = `const message = "${'A long line to verify native word wrapping. '.repeat(30)}";\n`
    await writeFile(join(workspace, 'long-line.js'), longLine)
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(panel.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20000 })
    const wrap = panel.getByRole('button', { name: 'Word wrap', exact: true })
    await expect(wrap).toHaveAttribute('aria-pressed', 'false')
    const original = await monacoState(application, contentPage)
    await wrap.click()
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await monacoState(application, contentPage)).wrapping).toEqual([{ original: false, modified: true }])
    assert.deepEqual((await monacoState(application, contentPage)).models, original.models)
    await page.locator('.workspace-panels-titlebar').getByRole('button', { name: 'Hide right workspace', exact: true }).click()
    await verifyTopbarActions(page)
    await page.getByRole('button', { name: 'Show right workspace', exact: true }).click()
    await expect(panel.locator('.monaco-diff-editor')).toBeVisible()
    for (const sideBySide of [true, false]) {
      const layout = panel.getByRole('button', { name: 'Side by side', exact: true })
      await layout.click()
      await expect(layout).toHaveAttribute('aria-pressed', String(sideBySide))
      await expect.poll(async () => (await monacoState(application, contentPage)).wrapping).toEqual([{ original: sideBySide, modified: true }])
    }
    if (process.env.ANAS_E2E_GIT_PANEL_SCREENSHOT) await panel.screenshot({
      path: process.env.ANAS_E2E_GIT_PANEL_SCREENSHOT.replace(/\.png$/, '-wrap.png')
    })
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await monacoState(application, contentPage)).wrapping).toEqual([{ original: false, modified: true }])
    await wrap.click()
    await expect(wrap).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await monacoState(application, contentPage)).wrapping).toEqual([{ original: false, modified: false }])
    assert.deepEqual((await monacoState(application, contentPage)).models, original.models)
    for (const zoom of [1, 1.5]) {
      await application.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
      const fold = panel.getByRole('button', { name: 'Fold unchanged regions', exact: true })
      await fold.hover()
      await expect(contentPage.getByRole('tooltip')).toHaveText('Fold unchanged regions')
      await expect(contentPage.getByRole('tooltip')).toBeVisible()
      const geometry = await contentPage.getByRole('tooltip').evaluate((element) => {
        const bounds = element.getBoundingClientRect(), overlay = navigator.windowControlsOverlay
        return { top: bounds.top, bottom: bounds.bottom, viewportHeight: globalThis.innerHeight,
          nativeBottom: overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0 }
      })
      const placement = await panelGeometry(application, contentPage)
      assert.ok(placement.y > 0, 'The native content view must stay below the titlebar.')
      assert.ok(geometry.top >= geometry.nativeBottom, 'Tooltip must stay below the native titlebar overlay.')
      assert.ok(geometry.bottom <= geometry.viewportHeight, 'Tooltip must stay inside the viewport.')
      if (process.env.ANAS_E2E_GIT_PANEL_SCREENSHOT) await application.evaluate(async ({ BrowserWindow }, path) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
        process.getBuiltinModule('node:fs').writeFileSync(path, image.toPNG())
      }, process.env.ANAS_E2E_GIT_PANEL_SCREENSHOT.replace(/\.png$/, `-tooltip-${zoom}.png`))
      await contentPage.mouse.move(0, 200)
      await expect(contentPage.getByRole('tooltip')).toHaveCount(0)
    }
    await writeFile(join(workspace, 'other.js'), 'initial other file\n')
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'A other.js', exact: true })).toBeVisible()
    const sideBySide = panel.getByRole('button', { name: 'Side by side', exact: true })
    const fold = panel.getByRole('button', { name: 'Fold unchanged regions', exact: true })
    await sideBySide.click()
    await expect(sideBySide).toHaveAttribute('aria-pressed', 'true')
    await fold.click()
    await expect(fold).toHaveAttribute('aria-pressed', 'false')
    await wrap.click()
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    const controls = await Promise.all([sideBySide, fold, wrap].map((button) => button.elementHandle()))
    await application.evaluate((_, path) => {
      const fs = process.getBuiltinModule('node:fs/promises'), original = fs.lstat
      globalThis.__gitReadPending = false
      let release
      fs.lstat = async (...args) => {
        if (args[0] === path && !globalThis.__gitReadPending) {
          globalThis.__gitReadPending = true
          await new Promise((resolve) => { release = resolve })
        }
        return original(...args)
      }
      globalThis.__releaseGitRead = () => { fs.lstat = original; release?.() }
    }, join(workspace, 'other.js'))
    await writeFile(join(workspace, 'other.js'), 'latest other file\n')
    await panel.getByRole('button', { name: 'A other.js', exact: true }).click()
    try {
      await expect.poll(() => application.evaluate(() => globalThis.__gitReadPending)).toBe(true)
      for (const control of controls) assert.ok(await control.evaluate((element) => element.isConnected), 'Toolbar must remain mounted while the next file loads.')
      await expect(sideBySide).toHaveAttribute('aria-pressed', 'true')
      await expect(fold).toHaveAttribute('aria-pressed', 'false')
      await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await application.evaluate(() => globalThis.__releaseGitRead())
    }
    await expect.poll(async () => (await monacoState(application, contentPage)).models).toContain('latest other file\n')
    for (const control of controls) assert.ok(await control.evaluate((element) => element.isConnected), 'Loaded content must reuse the toolbar.')
    await expect.poll(async () => (await monacoState(application, contentPage)).wrapping).toEqual([{ original: true, modified: true }])
    await writeFile(join(workspace, 'other.js'), 'unrelated edit\n')
    await panel.getByRole('button', { name: 'A long-line.js', exact: true }).click()
    await expect.poll(async () => (await monacoState(application, contentPage)).models).toContain(longLine)
    await writeFile(join(workspace, 'long-line.js'), 'latest selected file\n')
    await panel.getByRole('button', { name: 'A other.js', exact: true }).click()
    await panel.getByRole('button', { name: 'A long-line.js', exact: true }).click()
    await expect.poll(async () => (await monacoState(application, contentPage)).models).toContain('latest selected file\n')
    await expect(fold).toHaveAttribute('aria-pressed', 'false')
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await expect(sideBySide).toHaveAttribute('aria-pressed', 'true')
    assert.deepEqual(pageErrors, [])
    await application.close()
    application = await launchApplication(home)
    const reopenedPage = await application.firstWindow()
    await reopenedPage.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    const settings = await reopenedPage.evaluate(async () => (await globalThis.gale.config.get()).settings)
    assert.equal(settings.diffViewMode, 'side_by_side')
    assert.equal(settings.diffFoldUnchanged, false)
    assert.equal(settings.diffWordWrap, true)
    await reopenedPage.getByRole('button', { name: 'File changes', exact: true }).click()
    const reopenedContent = await panelPage(application, 'files')
    await expect(reopenedContent.getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(reopenedContent.getByRole('button', { name: 'Fold unchanged regions', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(reopenedContent.getByRole('button', { name: 'Word wrap', exact: true })).toHaveAttribute('aria-pressed', 'true')
    console.log('Git panel E2E passed: current file reads, persistent toolbar during loading, shared diff preferences, and settings retained after restart.')
  } finally {
    await application?.close().catch(() => {})
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyGitPanelStates }
