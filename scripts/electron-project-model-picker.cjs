const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')
const { panelPage } = require('./electron-panel-helpers.cjs')

async function expectInsideWindow(menu) {
  await expect.poll(() => menu.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const viewport = element.ownerDocument.defaultView
    return bounds.width > 0 && bounds.height > 0
      && bounds.top >= 0 && bounds.left >= 0
      && bounds.bottom <= viewport.innerHeight && bounds.right <= viewport.innerWidth
  }), { message: 'The complete menu must remain inside the application window' }).toBe(true)
}

async function verifyApprovalButtonLayout(page, language, full, tooltip) {
  await page.evaluate(language => globalThis.gale.config.updateSettings({ language }), language)
  await page.reload()
  const toolbar = page.locator('.composer-toolbar')
  const button = toolbar.locator('.composer-access-trigger')
  await expect(button).toHaveText(full, { useInnerText: true })
  const narrowWidth = await button.evaluate(element => {
    const slot = element.parentElement
    return slot.parentElement.getBoundingClientRect().width - slot.getBoundingClientRect().width
      + element.getBoundingClientRect().width - 1
  })
  await toolbar.evaluate((element, width) => { element.style.maxWidth = width + 'px' }, narrowWidth)
  await expect(button).toHaveText('', { useInnerText: true })
  await expect(button.locator('svg.lucide-shield-check')).toBeVisible()
  await expect(button.locator('svg.lucide-chevron-down')).toBeVisible()
  await expect(button).toHaveAccessibleDescription(full)
  await page.locator('[data-agent-composer-input]').focus()
  await page.keyboard.press('Tab')
  await expect(button).toBeFocused()
  await expect(page.getByRole('tooltip')).toHaveText(tooltip)
  await button.press('Enter')
  await expect(page.getByRole('menuitem').filter({ hasText: full }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(button).toBeFocused()
  await toolbar.evaluate(element => element.style.removeProperty('max-width'))
  await expect(button).toHaveText(full, { useInnerText: true })
}

async function verifyPermissionHelp(application, page, language) {
  const documentId = `USER_GUIDE.${language}.md`
  const anchor = language === 'zh-CN' ? '工具与授权' : 'tools-and-approval'
  const trigger = page.locator('.composer .composer-access-trigger')
  let viewId
  for (let attempt = 0; attempt < 2; attempt++) {
    await trigger.click()
    const menu = page.locator('.composer-access-menu')
    const help = menu.getByRole('menuitem', { name: language === 'zh-CN' ? '详细说明' : 'Learn more', exact: true })
    const label = await menu.locator('.composer-access-menu-label').boundingBox()
    const link = await help.boundingBox()
    expect(link.x).toBeGreaterThan(label.x + label.width)
    expect(Math.abs(link.y + link.height / 2 - label.y - label.height / 2)).toBeLessThan(2)
    if (!attempt && process.env.ANAS_E2E_PERMISSION_SCREENSHOT) {
      await menu.screenshot({ path: `${process.env.ANAS_E2E_PERMISSION_SCREENSHOT}-${language}.png` })
    }
    await help.focus()
    await help.press('Enter')
    await expect(menu).not.toBeVisible()
    const reader = await panelPage(application, 'document')
    const panel = reader.locator(`.panel-page:visible [id="document-${anchor}"]`)
    await expect(panel).toBeInViewport()
    const views = await page.evaluate(() => globalThis.gale.panels.list())
    const documents = views.filter(view => view.content.kind === 'document' && view.content.documentId === documentId)
    expect(documents).toHaveLength(1)
    expect(documents[0].location).toBe('sidebar')
    viewId = documents[0].viewId
    await expect(trigger).toHaveAccessibleDescription(language === 'zh-CN' ? '完全访问' : 'Full access')
    if (!attempt) {
      await reader.locator('.panel-page:visible .ui-document-panel').evaluate(element => { element.scrollTop = 0 })
      if (language === 'en') {
        await page.evaluate(id => globalThis.gale.panels.move(id, 'window'), viewId)
        await page.bringToFront()
      }
    }
  }
  await page.evaluate(id => globalThis.gale.panels.close(id), viewId)
}

async function verifyProjectModelPicker(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-project-model-picker-'))
  let application
  try {
    application = await launchApplication(home)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.evaluate(async () => {
      const api = globalThis.gale.config
      await api.updateSettings({ language: 'en' })
      const config = await api.saveModelProvider({ name: 'Scroll test', protocol: 'openai_chat_completions',
        baseUrl: 'https://model-test.invalid/v1', apiKey: '', parameters: {} })
      const providerId = config.providers.find((provider) => provider.name === 'Scroll test').id
      for (let index = 0; index < 40; index++) {
        await api.saveProviderModel({ providerId, displayName: `Model ${index}`, model: `model-${index}`, parameters: {},
          parameterPresetMode: 'custom', parameterPresets: Array.from({ length: 40 }, (_, i) => ({ id: `preset-${i}`, name: `Preset ${i}`, parameters: { temperature: 1 } })),
          capabilities: { vision: true, toolUse: true }, stream: true, maxContextTokens: 128000, maxOutputTokens: 16000,
          contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
      }
      for (let index = 0; index < 9; index++) {
        const name = `Provider ${index}`
        const saved = await api.saveModelProvider({ name, protocol: 'openai_chat_completions',
          baseUrl: 'https://model-test.invalid/v1', apiKey: '', parameters: {} })
        const providerId = saved.providers.find((provider) => provider.name === name).id
        await api.saveProviderModel({ providerId, displayName: name, model: `provider-model-${index}`, parameters: {},
          parameterPresetMode: 'none', parameterPresets: [], capabilities: { vision: true, toolUse: true },
          stream: true, maxContextTokens: 128000, maxOutputTokens: 16000,
          contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
      }
      const configured = await api.get()
      await api.selectDefaultModel(configured.providers.find((provider) => provider.id === providerId).models[0].id)
    })
    await page.reload()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 620))
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    const dialog = page.locator('.project-dialog')
    const access = dialog.getByRole('button', { name: 'Permission mode', exact: true })
    await expect(access).toHaveText('Smart approval')
    await access.click()
    await expectInsideWindow(page.locator('.composer-access-menu'))
    await page.getByRole('menuitem', { name: /^Full access/ }).click()
    await expect(access).toHaveText('Full access')
    await expect(access).toBeFocused()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    const composerAccess = page.locator('.composer .composer-access-trigger')
    await expect(composerAccess).toHaveAccessibleDescription('Full access')
    await verifyApprovalButtonLayout(page, 'zh-CN', '完全访问', '权限模式：完全访问')
    await verifyPermissionHelp(application, page, 'zh-CN')
    await verifyApprovalButtonLayout(page, 'en', 'Full access', 'Permission mode: Full access')
    await verifyPermissionHelp(application, page, 'en')
    await composerAccess.click()
    await page.getByRole('menuitem', { name: /^Smart approval/ }).click()
    await expect(composerAccess).toHaveAccessibleDescription('Smart approval')
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    await expect(access).toHaveText('Full access')
    await access.click()
    await page.getByRole('menuitem', { name: /^Strict approval/ }).click()
    await expect(access).toHaveText('Strict approval')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(composerAccess).toHaveAccessibleDescription('Smart approval')
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.projects.list()).find(p => p.id === 'default-workspace').accessMode)).toBe('full_access')
    await page.reload()
    await expect(composerAccess).toHaveAccessibleDescription('Full access')
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    await dialog.getByRole('button', { name: 'Select model', exact: true }).click()
    const list = page.locator('.composer-model-models')
    const providers = page.locator('.composer-model-providers')
    await expect(list).toBeVisible()
    const menu = page.locator('.composer-model-menu')
    await expectInsideWindow(menu)
    async function expectProviderLayout() {
      await expect.poll(() => providers.evaluate((element) => Array.from(element.children).every((item) => {
        const row = item.getBoundingClientRect()
        const content = item.querySelector('.model-list-item-main').getBoundingClientRect()
        return content.top >= row.top && content.bottom <= row.bottom
      })), { message: 'Two-line provider content must fit inside each row instead of being compressed' }).toBe(true)
      await expect.poll(() => providers.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    }
    await expectProviderLayout()
    const modelsScroll = await list.evaluate((element) => element.scrollTop)
    await providers.hover()
    await page.mouse.wheel(0, 400)
    await expect.poll(() => providers.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect(list).toHaveJSProperty('scrollTop', modelsScroll)
    const body = dialog.locator('.ui-dialog-body')
    const bodyScroll = await body.evaluate((element) => element.scrollTop)
    await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await list.hover()
    const before = await list.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, 600)
    await expect.poll(() => list.evaluate((element) => element.scrollTop), { message: 'Mouse wheel must scroll models inside the project dialog' }).toBeGreaterThan(before)
    await expect(body).toHaveJSProperty('scrollTop', bodyScroll)
    const scrolled = await list.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, -300)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeLessThan(scrolled)
    if (process.env.ANAS_E2E_MODEL_PICKER_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_MODEL_PICKER_SCREENSHOT })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Select model', exact: true })).toBeFocused()
    await dialog.getByRole('button', { name: 'Select model', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^Model 0(?: |$)/ }).click()
    await expect.poll(() => dialog.evaluate((element) => {
      const folders = element.querySelector('.project-folder-list').getBoundingClientRect()
      const permissions = element.querySelector('.composer-access-trigger').getBoundingClientRect()
      const modelGroup = element.querySelector('.composer-model-selection-group')
      const models = modelGroup.getBoundingClientRect()
      return permissions.y >= folders.bottom && models.x >= permissions.right
        && Math.abs(permissions.y + permissions.height / 2 - models.y - models.height / 2) < 1
        && Math.abs(models.right - modelGroup.parentElement.getBoundingClientRect().right) < 1
    }), { message: 'Tool permissions and models must fit in one row below folders' }).toBe(true)
    if (process.env.ANAS_E2E_PROJECT_MODEL_POSITION_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_PROJECT_MODEL_POSITION_SCREENSHOT })
    await dialog.getByRole('button', { name: 'Reasoning options', exact: true }).click()
    const presets = page.locator('.composer-model-parameter-preset-menu')
    await expect(presets).toBeVisible()
    await expectInsideWindow(presets)
    await presets.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => presets.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    // The shared picker must still scroll outside a modal dialog.
    await page.getByRole('button', { name: 'Select model', exact: true }).click()
    await expectInsideWindow(menu)
    await list.hover()
    const composerBefore = await list.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, 500)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(composerBefore)
    await page.keyboard.press('Escape')
    // Font changes and viewport resizing must use the current anchor space.
    await page.evaluate(() => globalThis.gale.config.updateSettings({ fontSize: 18 }))
    await page.reload()
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    await dialog.getByRole('button', { name: 'Select model', exact: true }).click()
    await expectInsideWindow(menu)
    await expectProviderLayout()
    await page.getByRole('menuitem', { name: 'Scroll test', exact: true }).click()
    await expectInsideWindow(menu)
    await page.getByRole('menuitem', { name: 'Scroll test', exact: true }).click()
    await expectInsideWindow(menu)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 780))
    await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(1180)
    await expectInsideWindow(menu)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 620))
    await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(900)
    await expectInsideWindow(menu)
    await list.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    if (process.env.ANAS_E2E_MODEL_PICKER_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_MODEL_PICKER_SCREENSHOT })
    await page.mouse.wheel(0, 5000)
    await page.getByRole('menuitemradio', { name: /^Model 39(?: |$)/ }).click()
    await expect(dialog.getByRole('button', { name: 'Select model', exact: true })).toHaveText('Model 39')
    await dialog.getByRole('button', { name: 'Reasoning options', exact: true }).click()
    await expectInsideWindow(presets)
    await presets.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => presets.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    // Default projects share the regular editor and persistence; only their name is read-only.
    await expect(dialog.getByRole('textbox', { name: 'Project name', exact: true })).toHaveAttribute('readonly', '')
    await expect(dialog.getByRole('button', { name: 'Add folders', exact: true })).toBeEnabled()
    await dialog.getByRole('checkbox', { name: 'Customize capabilities', exact: true }).check()
    await dialog.getByRole('checkbox', { name: 'Coding mode', exact: true }).check()
    await dialog.getByRole('textbox', { name: 'Project prompt', exact: true }).fill('Default workspace custom instructions')
    await dialog.getByRole('checkbox', { name: 'Profile', exact: true }).uncheck()
    await dialog.getByRole('tab', { name: 'Compression prompt', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Compression prompt', exact: true }).fill('Keep decisions: {conversation}')
    if (process.env.ANAS_E2E_DEFAULT_PROJECT_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_DEFAULT_PROJECT_SCREENSHOT })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.reload()
    const savedDefault = await page.evaluate(async () => (await globalThis.gale.projects.list()).find(project => project.id === 'default-workspace'))
    expect(savedDefault).toMatchObject({ advancedSettings: true, codingMode: true, prompt: 'Default workspace custom instructions',
      compressionPrompt: 'Keep decisions: {conversation}', capabilities: { profile: false } })
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    await expect(dialog.getByRole('checkbox', { name: 'Customize capabilities', exact: true })).toBeChecked()
    await expect(dialog.getByRole('checkbox', { name: 'Coding mode', exact: true })).toBeChecked()
    await expect(dialog.getByRole('textbox', { name: 'Project prompt', exact: true })).toHaveValue('Default workspace custom instructions')
    await expect(dialog.getByRole('checkbox', { name: 'Profile', exact: true })).not.toBeChecked()
    console.log('Project settings and model menus passed: default project customization, save/cancel, conversation override, persistence, layout, viewport containment, small windows, large fonts, scrolling and focus restoration.')
  } finally {
    if (application) await application.close()
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyProjectModelPicker }
