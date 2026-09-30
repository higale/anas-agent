const assert = require('node:assert/strict')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')
const settingsDefaults = require('../data/config/settings.json')

async function expectHeight(locator, height) {
  await expect(locator.first()).toBeVisible()
  const sizes = await locator.evaluateAll(elements => elements.map(element => ({
    label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80),
    height: element.getBoundingClientRect().height
  })))
  assert.ok(sizes.length > 0)
  for (const size of sizes) assert.ok(Math.abs(size.height - height) < 0.5,
    `${size.label}: expected ${height}px, received ${size.height}px`)
}

async function expectChildrenInside(locator) {
  const overflow = await locator.evaluateAll(parents => parents.flatMap(parent => {
    const bounds = parent.getBoundingClientRect()
    return [...parent.children].filter(child => {
      const rect = child.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1
        || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)
    }).map(child => child.getAttribute('aria-label') || child.className)
  }))
  assert.deepEqual(overflow, [], 'Controls must fit inside their container.')
}

async function expectAppearanceWidths(appearance) {
  const bounds = await appearance.locator('.searchable-option-picker, .ui-segmented-control').evaluateAll(elements => elements.map(element => {
    const { right, width } = element.getBoundingClientRect()
    return { right, width }
  }))
  assert.equal(bounds.length, 3)
  assert.ok(Math.abs(bounds[0].width - 240) < 0.5, 'The language picker must retain its original width regardless of segment labels or font size.')
  for (const boundsOfControl of bounds.slice(1)) {
    assert.ok(boundsOfControl.width >= bounds[0].width - 0.5, 'Segments must use the language picker width as their minimum and may grow independently.')
    assert.ok(Math.abs(boundsOfControl.right - bounds[0].right) < 0.5, 'Appearance controls must share the same trailing edge.')
  }
  const fontRail = await appearance.locator('.ui-slider-rail').boundingBox()
  assert.ok(fontRail)
  assert.ok(Math.abs(fontRail.width - bounds[0].width) < 0.5, 'The visible font slider rail must match the language picker width.')
  assert.ok(Math.abs(fontRail.x + fontRail.width - bounds[0].right) < 0.5, 'The visible font slider rail must align with the language picker.')
}

async function verifySegmentMinimumWidth(locator) {
  const measurements = await locator.evaluate(element => {
    // Measure the shared component independently of the settings form.
    const control = element.cloneNode(true)
    Object.assign(control.style, { position: 'fixed', visibility: 'hidden', minWidth: '' })
    element.ownerDocument.body.append(control)
    const measure = () => ({
      width: control.getBoundingClientRect().width,
      items: [...control.querySelectorAll('label')].map(item => item.getBoundingClientRect().width)
    })
    try {
      return ['equal', 'content'].map(mode => {
        control.dataset.itemWidth = mode
        control.style.minWidth = ''
        const natural = measure()
        control.style.minWidth = '1px'
        const smaller = measure()
        control.style.minWidth = '500px'
        const larger = measure()
        control.style.minWidth = '40em'
        const relative = measure()
        return { mode, natural, smaller, larger, relative, relativeMinimum: 40 * parseFloat(globalThis.getComputedStyle(control).fontSize) }
      })
    } finally {
      control.remove()
    }
  })
  for (const { mode, natural, smaller, larger, relative, relativeMinimum } of measurements) {
    assert.equal(smaller.width, natural.width, `${mode}: a smaller minimum must not shrink content.`)
    assert.ok(Math.abs(larger.width - 500) < 0.5, `${mode}: minimum width applies to the whole control.`)
    assert.ok(Math.abs(relative.width - relativeMinimum) < 0.5, `${mode}: relative units must follow the font size.`)
    const growth = larger.items.map((width, index) => width - natural.items[index])
    assert.ok(Math.max(...growth) - Math.min(...growth) < 0.5, `${mode}: extra space must be distributed evenly.`)
    assert.ok(Math.abs(larger.items.reduce((sum, width) => sum + width, 0) - (larger.width - 2)) < 0.5,
      `${mode}: items must fill the control inside its border.`)
  }
  const [equal, content] = measurements
  assert.ok(Math.abs(equal.natural.items[0] - Math.max(...content.natural.items)) < 0.5,
    'Without a minimum, equal width must follow the longest label.')
  assert.ok(Math.max(...content.larger.items) - Math.min(...content.larger.items) > 1,
    'Content mode must preserve individual label width differences when widened.')
}

async function verifyControlLayout(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-control-layout-'))
  let application
  try {
    await mkdir(join(root, 'config'))
    await writeFile(join(root, 'config/settings.json'), JSON.stringify({ ...settingsDefaults, language: 'en' }))
    application = await launchApplication(root)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.locator('[data-agent-composer-input]').waitFor()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 820))

    async function openGeneral() {
      await page.locator('.sidebar-settings').click()
      await page.locator('.app-menu-item').first().click()
      await page.locator('[data-settings-tab="general"]').click()
    }
    await openGeneral()
    const appearance = page.locator('.settings-group').filter({ has: page.getByRole('heading', { name: 'Appearance', exact: true }) })
    const fontHandle = appearance.getByRole('slider', { name: 'Font size', exact: true })
    const fontSlider = appearance.locator('.ui-slider')
    const theme = appearance.getByRole('radiogroup', { name: 'Theme', exact: true })

    await fontSlider.scrollIntoViewIfNeeded()
    const slider = await fontSlider.boundingBox()
    assert.ok(slider)
    await page.mouse.click(slider.x + slider.width / 2, slider.y + slider.height / 2)
    await expect(fontHandle).toHaveAttribute('aria-valuenow', '14')
    await page.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2)
    await page.mouse.down()
    await page.mouse.move(slider.x + slider.width, slider.y + slider.height / 2, { steps: 12 })
    await page.mouse.up()
    await expect(fontHandle).toHaveAttribute('aria-valuenow', '18')
    assert.equal(await fontHandle.evaluate(element => globalThis.getComputedStyle(element).boxShadow), 'none', 'Mouse dragging must not add a focus ring.')
    await appearance.locator('.ui-slider-mark-text').filter({ hasText: /^14$/ }).click()
    await expect(fontHandle).toHaveAttribute('aria-valuenow', '14')
    const rail = appearance.locator('.ui-slider-rail')
    await rail.click({ position: { x: 1, y: 2 } })
    await expect(fontHandle).toHaveAttribute('aria-valuenow', '10')
    const railBounds = await rail.boundingBox()
    assert.ok(railBounds)
    await rail.click({ position: { x: railBounds.width - 1, y: 2 } })
    await expect(fontHandle).toHaveAttribute('aria-valuenow', '18')

    // Change the actual saved setting so live CSS updates, minimum size, and all supported sizes are exercised.
    for (const fontSize of [10, 11, 12, 13, 14, 15, 16, 17, 18]) {
      const height = Math.max(30, fontSize + 18)
      await fontHandle.press(fontSize === 10 ? 'Home' : 'ArrowRight')
      await expect(fontHandle).toHaveAttribute('aria-valuenow', String(fontSize))
      await expect(fontHandle).toHaveAttribute('aria-valuetext', `${fontSize} px`)
      await expect(fontHandle).toHaveText(`${fontSize} px`)
      await expectChildrenInside(fontHandle)
      await expect.poll(() => fontSlider.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
      await expectChildrenInside(appearance.locator('.ui-range-control'))
      const marks = await appearance.locator('.ui-slider-mark-text').evaluateAll(elements => elements
        .filter(element => element.textContent)
        .map(element => ({ text: element.textContent, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })))
      assert.deepEqual(marks.map(mark => mark.text), ['10', '12', '14', '16', '18'])
      assert.ok(marks.every((mark, index) => index === 0 || marks[index - 1].right < mark.left), 'Scale labels must not overlap.')
      await theme.getByText(fontSize % 2 ? 'Light' : 'Dark', { exact: true }).click()
      await expectHeight(theme, height)
      const widths = await theme.locator('label').evaluateAll(items => items.map(item => item.getBoundingClientRect().width))
      assert.ok(Math.max(...widths) - Math.min(...widths) < 0.5, 'Default segment widths must match.')
      if (fontSize === 14) await verifySegmentMinimumWidth(theme)
      await expectAppearanceWidths(appearance)
      await expectChildrenInside(appearance.locator('.ui-form-row'))
      await expectHeight(appearance.locator('.searchable-option-picker'), height)
      await expectChildrenInside(appearance.locator('.searchable-option-picker, .ui-segmented-control'))
      await expectHeight(page.getByRole('button', { name: 'Clean up...', exact: true }), height)
      const openData = page.getByRole('button', { name: 'Open', exact: true })
      await expectHeight(openData, height)
      assert.equal(await openData.evaluate(element => element.getBoundingClientRect().width),
        await page.getByRole('button', { name: 'Backup', exact: true }).evaluate(element => element.getBoundingClientRect().width),
        'Data directory and backup actions must use the same column width.')
      const actions = await page.locator('.ui-action-column .ui-button').evaluateAll(buttons => buttons.map(button => ({
        right: button.getBoundingClientRect().right,
        clipped: [...button.querySelectorAll('span')].some(label => label.scrollWidth > label.clientWidth)
      })))
      assert.ok(actions.every(action => !action.clipped), 'Action labels must remain readable at every font size.')
      assert.ok(Math.max(...actions.map(action => action.right)) - Math.min(...actions.map(action => action.right)) < 0.5,
        'Data actions must share the same trailing edge.')
      await appearance.getByRole('combobox', { name: 'Language', exact: true }).click()
      await expectHeight(page.getByRole('option'), height)
      await page.keyboard.press('Escape')
      if ([10, 14, 18].includes(fontSize) && process.env.ANAS_E2E_CONTROL_LAYOUT_SCREENSHOT) {
        await appearance.screenshot({ path: `${process.env.ANAS_E2E_CONTROL_LAYOUT_SCREENSHOT}.${fontSize}.png` })
      }

      for (const tab of ['tools', 'skills']) {
        await page.locator(`[data-settings-tab="${tab}"]`).click()
        await expectHeight(page.locator('.settings-skill-tree-row:visible'), height)
        await expectHeight(page.getByRole('button', { name: 'Refresh', exact: true }), height)
      }
      await page.locator('.app-sidebar .ui-sidebar-action').click()
      await page.locator('[data-agent-composer-input]').waitFor()
      await expectHeight(page.locator('.composer-attachment-button, .composer-send-button, .composer-model-selection-group'), height)
      await expectChildrenInside(page.locator('.composer-toolbar, .topbar, .project-thread-heading'))
      await page.locator('.sidebar-settings').click()
      await expectHeight(page.locator('.app-menu-item'), height)
      await page.locator('.app-menu-item').first().click()
      await page.locator('[data-settings-tab="general"]').click()
    }
    assert.equal(JSON.parse(await readFile(join(root, 'config/settings.json'), 'utf8')).font_size, 18)

    await page.locator('[data-settings-tab="chatMode"]').click()
    const speedHandle = page.getByRole('slider', { name: 'Speed', exact: true })
    const speedRow = page.locator('.ui-range-row').filter({ has: speedHandle })
    await speedRow.scrollIntoViewIfNeeded()
    await speedRow.locator('.ui-slider-mark-text').filter({ hasText: /^1$/ }).click()
    await expect(speedHandle).toHaveAttribute('aria-valuenow', '1')
    await speedHandle.press('ArrowRight')
    await expect(speedHandle).toHaveAttribute('aria-valuenow', '1.05')
    await expect(speedHandle).toHaveText('1.05x')
    await expectChildrenInside(speedHandle)
    await speedHandle.press('Home')
    await expect(speedHandle).toHaveAttribute('aria-valuenow', '0.25')
    await speedHandle.press('End')
    await expect(speedHandle).toHaveAttribute('aria-valuenow', '4')
    await speedRow.locator('.ui-slider-mark-text').filter({ hasText: /^1$/ }).click()
    await expect(speedHandle).toHaveAttribute('aria-valuenow', '1')
    await speedHandle.press('ArrowRight')
    await expect(speedHandle).toHaveAttribute('aria-valuenow', '1.05')
    await expect.poll(async () => JSON.parse(await readFile(join(root, 'config/settings.json'), 'utf8')).speech_reply.speed).toBe(1.05)
    await page.locator('[data-settings-tab="general"]').click()
    await page.locator('[data-settings-tab="chatMode"]').click()
    await expect(speedHandle).toHaveAttribute('aria-valuenow', '1.05')
    await page.locator('[data-settings-tab="general"]').click()

    // A narrow window and maximum font must retain usable fields, tree controls, and toolbars.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 700))
    await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(900)
    await expectAppearanceWidths(appearance)
    await expectChildrenInside(appearance.locator('.ui-form-row'))
    await expectChildrenInside(appearance.locator('.ui-range-control'))
    if (process.env.ANAS_E2E_CONTROL_LAYOUT_SCREENSHOT) {
      await page.locator('.settings-group').filter({ has: page.getByRole('heading', { name: 'Data management', exact: true }) })
        .screenshot({ path: `${process.env.ANAS_E2E_CONTROL_LAYOUT_SCREENSHOT}.data.png` })
    }
    await page.locator('[data-settings-tab="dev"]').click()
    const openFolders = page.getByRole('button', { name: 'Open folder', exact: true })
    await expect(openFolders).toHaveCount(2)
    await expectHeight(openFolders, 36)
    await expect(page.getByRole('button', { name: 'Log files', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'HTTP trace files', exact: true })).toHaveCount(0)
    await page.locator('[data-settings-tab="tools"]').click()
    await page.getByRole('button', { name: /^System\s*2$/ }).click()
    await page.locator('.settings-skill-viewer').getByRole('list').getByRole('button', { name: /json_format/ }).click()
    await page.getByRole('button', { name: 'Expand tool “json_format”', exact: true }).click()
    await page.getByRole('button', { name: 'README.md', exact: true }).click()
    await expectHeight(page.locator('.settings-skill-viewer .ui-segmented-control'), 36)
    await expectChildrenInside(page.locator('.settings-skill-viewer-heading'))
    if (process.env.ANAS_E2E_CONTROL_LAYOUT_SCREENSHOT) {
      await page.screenshot({ path: `${process.env.ANAS_E2E_CONTROL_LAYOUT_SCREENSHOT}.narrow.png` })
    }
    await page.locator('.app-sidebar .ui-sidebar-action').click()
    await expectChildrenInside(page.locator('.composer-toolbar, .topbar, .project-thread-heading'))
    await openGeneral()
    await appearance.getByRole('combobox', { name: 'Language', exact: true }).click()
    await page.getByRole('option', { name: '简体中文 (zh-CN)', exact: true }).click()
    const chineseAppearance = page.locator('.settings-group').filter({ has: page.getByRole('heading', { name: '外观', exact: true }) })
    const chineseFont = chineseAppearance.getByRole('slider', { name: '字体大小', exact: true })
    for (const windowWidth of [1180, 900]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 820), windowWidth)
      await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(windowWidth)
      for (const fontSize of [10, 14, 18]) {
        if (fontSize === 14) await chineseAppearance.locator('.ui-slider-mark-text').filter({ hasText: /^14$/ }).click()
        else await chineseFont.press(fontSize === 10 ? 'Home' : 'End')
        await expect(chineseFont).toHaveAttribute('aria-valuenow', String(fontSize))
        await expectAppearanceWidths(chineseAppearance)
        await expectChildrenInside(chineseAppearance.locator('.ui-form-row, .ui-segmented-control'))
        if (fontSize === 14 && process.env.ANAS_E2E_CONTROL_LAYOUT_SCREENSHOT) {
          await chineseAppearance.screenshot({ path: `${process.env.ANAS_E2E_CONTROL_LAYOUT_SCREENSHOT}.zh.${windowWidth}.png` })
        }
      }
    }
    assert.deepEqual(errors, [])
    console.log('Control layout passed: live font sizes 10–18, slider marks/drag/keyboard, fractional speech speed persistence, light/dark themes, fields, segment minimum widths, independent appearance control sizing, menu/options, trees and narrow-window containment.')
  } finally {
    if (application) await application.close()
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyControlLayout }
