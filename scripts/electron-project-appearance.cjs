const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

async function verifyProjectAppearance(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-project-appearance-'))
  let application
  try {
    application = await launchApplication(home)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.locator('[data-agent-composer-input]').waitFor()
    await expect(page.locator('.thread-topbar-project svg')).toHaveClass(/lucide-house/)
    const project = await page.evaluate(async () => {
      await globalThis.gale.config.updateSettings({ language: 'zh-CN', theme: 'dark' })
      const defaults = (await globalThis.gale.projects.list()).find(project => project.id === 'default-workspace')
      const result = await globalThis.gale.projects.create({ ...defaults, icon: undefined, name: '图标选择测试' })
      if (result.status !== 'ok') throw new Error(JSON.stringify(result.error))
      return result.value
    })
    const readProject = () => page.evaluate(async id => (await globalThis.gale.projects.list()).find(project => project.id === id), project.id)
    const group = page.locator('.project-thread-group').filter({ hasText: project.name })
    const dialog = page.locator('.project-dialog')
    const trigger = dialog.locator('.project-appearance-trigger')
    const picker = page.locator('.project-appearance-popover')
    const screenshot = async suffix => {
      await page.evaluate(() => globalThis.document.fonts.ready)
      if (process.env.ANAS_E2E_PROJECT_APPEARANCE_SCREENSHOT) {
        await page.screenshot({ path: `${process.env.ANAS_E2E_PROJECT_APPEARANCE_SCREENSHOT}-${suffix}.png` })
      }
    }
    const openEditor = async (edit = '编辑项目') => {
      await group.locator('.project-thread-more').click()
      await page.locator('.project-details-action').filter({ hasText: edit }).click()
      await expect(dialog).toBeVisible()
      await trigger.click()
    }
    const insideWindow = async () => {
      await expect.poll(() => picker.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= globalThis.innerWidth && bounds.bottom <= globalThis.innerHeight
      })).toBe(true)
      await expect(picker.getByRole('button', { name: /^(完成|Done)$/ })).toBeInViewport()
    }
    await page.reload()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 740))
    await openEditor()
    await expect(picker.getByRole('searchbox')).toHaveCount(0)
    await insideWindow()
    const iconButtons = picker.getByRole('group', { name: '项目图标', exact: true }).getByRole('button')
    await expect(iconButtons).toHaveCount(32)
    const rows = await iconButtons.evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)))
    assert.equal(new Set(rows).size, 4)
    await screenshot('icons-dark')
    for (const [icon, label] of [['pineapple', '选择菠萝'], ['house', '选择房屋']]) {
      await picker.getByRole('button', { name: label, exact: true }).click()
      await picker.getByRole('button', { name: '完成', exact: true }).click()
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      assert.equal((await readProject()).icon, icon)
      await openEditor()
      await expect(picker.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true')
    }
    await picker.getByText('表情符号', { exact: true }).click()
    await expect(picker.getByRole('button', { name: '笑脸与情感', exact: true })).toBeVisible()
    await page.evaluate(() => globalThis.document.fonts.load('23px "Noto Color Emoji"', '🫩🫷🫸🇨🇳'))
    assert.ok(await page.evaluate(() => globalThis.document.fonts.check('23px "Noto Color Emoji"', '🫩🫷🫸🇨🇳')))
    await insideWindow()
    await screenshot('emoji-dark')
    const results = picker.locator('.project-appearance-results')
    const editorScroll = await dialog.evaluate(element => Array.from(element.querySelectorAll('.ui-dialog-body, .ui-dialog-pane')).map(pane => pane.scrollTop))
    await results.hover()
    await page.mouse.wheel(0, 420)
    await expect.poll(() => results.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await page.mouse.wheel(0, 10000)
    await expect.poll(() => results.evaluate(element => Math.ceil(element.scrollTop + element.clientHeight) >= element.scrollHeight)).toBe(true)
    await page.mouse.wheel(0, 420)
    assert.deepEqual(await dialog.evaluate(element => Array.from(element.querySelectorAll('.ui-dialog-body, .ui-dialog-pane')).map(pane => pane.scrollTop)), editorScroll)
    await page.mouse.wheel(0, -10000)
    await expect.poll(() => results.evaluate(element => element.scrollTop)).toBe(0)
    for (const query of ['火箭', 'rocket', '🚀']) {
      await picker.getByRole('searchbox').fill(query)
      await expect(picker.getByRole('button', { name: '🚀 火箭', exact: true })).toBeVisible()
    }
    await picker.getByRole('searchbox').press('Enter')
    await expect(dialog).toBeVisible()
    await picker.getByRole('button', { name: '🚀 火箭', exact: true }).click()
    await expect(trigger).toHaveText('🚀')
    await picker.getByRole('button', { name: '完成', exact: true }).click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    assert.equal((await readProject()).iconEmoji, '🚀')
    await expect(group.locator('.project-emoji')).toHaveText('🚀')
    await page.reload()
    await expect(group.locator('.project-emoji')).toHaveText('🚀')

    await openEditor()
    await expect(picker.getByRole('radio', { name: '表情符号', exact: true })).toBeChecked()
    await picker.getByText('图标', { exact: true }).click()
    await expect(picker.getByRole('searchbox')).toHaveCount(0)
    await picker.getByRole('button', { name: '选择代码', exact: true }).click()
    await picker.getByRole('button', { name: '选择蓝色', exact: true }).click()
    await expect(trigger.locator('svg')).toHaveAttribute('data-project-icon-color', 'blue')
    await picker.getByRole('button', { name: '完成', exact: true }).click()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal((await readProject()).iconEmoji, '🚀')

    // A direct file drop must replace the emoji through the existing image importer.
    await openEditor()
    await picker.getByRole('button', { name: '完成', exact: true }).click()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="orange"/></svg>'
    const transfer = await page.evaluateHandle(svg => {
      const transfer = new globalThis.DataTransfer()
      transfer.items.add(new File([svg], 'project.svg', { type: 'image/svg+xml' }))
      return transfer
    }, svg)
    await trigger.dispatchEvent('dragover', { dataTransfer: transfer })
    await trigger.dispatchEvent('drop', { dataTransfer: transfer })
    await transfer.dispose()
    await expect(trigger.locator('img')).toHaveAttribute('src', `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    assert.equal((await readProject()).iconEmoji, undefined)
    await openEditor()
    await picker.getByText('表情符号', { exact: true }).click()
    await picker.getByRole('searchbox').fill('👩‍💻')
    await picker.getByRole('button', { name: /^👩‍💻 / }).click()
    await picker.getByRole('button', { name: '完成', exact: true }).click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    assert.equal((await readProject()).iconData, undefined)
    assert.equal((await readProject()).iconEmoji, '👩‍💻')

    for (const [language, theme, fontSize, width, height] of [['zh-CN', 'light', 14, 1000, 740], ['en', 'dark', 18, 720, 520]]) {
      await page.evaluate(settings => globalThis.gale.config.updateSettings(settings), { language, theme, fontSize })
      await page.reload()
      await application.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [width, height])
      await openEditor(language === 'en' ? 'Edit' : '编辑项目')
      await expect(picker.locator('.project-emoji-categories')).toBeVisible()
      await insideWindow()
      await screenshot(`emoji-${language}-${theme}-${fontSize}`)
      await picker.getByRole('button', { name: /^(完成|Done)$/ }).click()
      await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
    }
    assert.deepEqual(errors, [])
    console.log('Project appearance passed: bilingual search, emoji/icon/image switching, persistence, cancel, themes and small-window layout.')
  } finally {
    if (application) await closeElectronTestApplication(application)
    await rm(home, { recursive: true, force: true })
  }
}

module.exports = { verifyProjectAppearance }
