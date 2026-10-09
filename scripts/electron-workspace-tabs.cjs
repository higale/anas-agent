const assert = require('node:assert/strict')
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')
const { pluginPage, pluginGeometry, pluginWindow, tooltipPage } = require('./electron-plugin-helpers.cjs')

async function verifyWorkspaceTabs(launchApplication) {
  const directory = await mkdtemp(join(tmpdir(), 'anas-workspace-tabs-'))
  let application
  const nativeErrors = []
  try {
    const source = join(directory, 'fixture')
    await mkdir(source)
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'tabs-test', name: 'Tabs fixture', plugin_version: '1.0.0', api_version: 2, ui: 'index.html' }))
    await writeFile(join(source, 'index.html'), '<script src="/_anas/sdk.js"></script><p>Tab content</p><script src="app.js"></script>')
    await writeFile(join(source, 'app.js'), `(async () => { const context = await anas.getContext(); globalThis.unsavedTabDragState = context.restoreState; anas.registerLifecycle({prepare: async () => globalThis.unsavedTabDragState ?? null}); await anas.ready(); })();`)
    application = await launchApplication(directory)
    application.on('console', message => {
      if (message.type() === 'error') nativeErrors.push(message.text())
    })
    await application.evaluate(({ dialog }) => {
      dialog.showErrorBox = (title, message) => console.error(`${title}: ${message}`)
    })
    const page = await application.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en', theme: 'dark', fontSize: 14, workspacePanelWidth: 480 }))
    await application.evaluate(({ BrowserWindow, dialog }, path) => {
      BrowserWindow.getAllWindows()[0].setSize(1440, 800)
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, join(source, 'PLUGIN.json'))
    await page.reload()
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.evaluate(() => globalThis.gale.plugins.install())
    const label = i => `Remote desktop ${i} — a deliberately long title for adaptive tab layout`
    const open = async i => page.evaluate(({ instanceId, title }) => globalThis.gale.plugins.invoke('tabs-test', 'host.openView', { instanceId, title, location: 'sidebar' }), { instanceId: `tab-${i}`, title: label(i) })
    const list = page.getByRole('tablist', { name: 'Right workspace', exact: true })
    const setFont = async fontSize => {
      await page.locator('.sidebar-settings').click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      await page.locator('[data-settings-tab="general"]').click()
      const appearance = page.locator('.settings-group').filter({ has: page.getByRole('heading', { name: 'Appearance', exact: true }) })
      if (fontSize === 14) await appearance.locator('.ui-slider-mark-text').filter({ hasText: /^14$/ }).click()
      else await appearance.getByRole('slider', { name: 'Font size', exact: true }).press(fontSize === 10 ? 'Home' : 'End')
      await expect.poll(() => page.evaluate(() => globalThis.getComputedStyle(globalThis.document.documentElement).getPropertyValue('--font-size-base').trim())).toBe(`${fontSize}px`)
      await page.getByRole('button', { name: 'Back to app', exact: true }).click()
      await expect(list).toBeVisible()
    }
    const resizePanel = async width => {
      const panel = page.locator('.workspace-panels')
      const bounds = await panel.boundingBox()
      const handle = await page.getByRole('separator', { name: 'Resize right workspace', exact: true }).boundingBox()
      const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2
      await page.mouse.move(x, y); await page.mouse.down()
      await page.mouse.move(x + bounds.width - width, y, { steps: 8 }); await page.mouse.up()
      await expect.poll(() => panel.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(width)
    }
    const layout = () => list.evaluate(element => {
      const box = element.getBoundingClientRect()
      return { width: element.clientWidth, contentWidth: element.scrollWidth, left: element.scrollLeft,
        tabs: [...element.querySelectorAll('.ui-tab-item')].map(tab => {
          const bounds = tab.getBoundingClientRect(), title = tab.querySelector('.ui-tab-title')
          const titleBounds = title.getBoundingClientRect(), close = tab.querySelector('.ui-tab-close')
          const trigger = tab.querySelector('[role="tab"]'), icon = trigger.querySelector('svg').getBoundingClientRect()
          return { left: bounds.left - box.left, right: bounds.right - box.left, width: bounds.width,
            titleVisible: title.checkVisibility(), titleClipped: title.scrollWidth > title.clientWidth,
            titleLeft: titleBounds.left - box.left, titleWidth: titleBounds.width,
            titleUnderClose: titleBounds.right > close.getBoundingClientRect().left,
            closeVisible: close.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
            named: !!trigger.getAttribute('aria-label') && !!trigger.getAttribute('data-tooltip') && !trigger.hasAttribute('title'),
            iconInside: icon.left >= bounds.left && icon.right <= bounds.right }
        }) }
    })
    const verifyDragSpace = async () => {
      const space = await page.locator('.workspace-panels-titlebar').evaluate(header => {
        const strip = header.querySelector('.ui-tab-workspace-tabs').getBoundingClientRect()
        const list = header.querySelector('[role="tablist"]').getBoundingClientRect()
        const last = header.querySelector('.ui-tab-item:last-child').getBoundingClientRect()
        const x = (last.right + strip.right) / 2, y = (list.top + list.bottom) / 2
        const target = globalThis.document.elementFromPoint(x, y)
        const blockers = []
        for (let element = target; element; element = element.parentElement) {
          if (globalThis.getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'no-drag') blockers.push(element.className)
        }
        return { gap: strip.right - last.right, scrollAreaEnd: list.right, lastTabEnd: last.right,
          inHeader: header.contains(target), blockers,
          headerRegion: globalThis.getComputedStyle(header).getPropertyValue('-webkit-app-region') }
      })
      assert.ok(space.gap > 100, 'The expanded panel must leave space after the two tabs.')
      assert.ok(space.scrollAreaEnd <= space.lastTabEnd + 1, 'The interactive scroll area must end at the last tab.')
      assert.ok(space.inHeader)
      assert.equal(space.headerRegion, 'drag')
      assert.deepEqual(space.blockers, [], 'Unused titlebar space must not be covered by a no-drag region.')
    }
    await open(0); await open(1)
    await expect.poll(async () => (await layout()).tabs.length).toBe(2)
    let state = await layout()
    assert.ok(state.contentWidth <= state.width + 1, 'Long titles must shrink before adding a scrollbar.')
    assert.ok(state.tabs.every(tab => tab.titleVisible && tab.titleClipped && tab.left >= -1 && tab.right <= state.width + 1), JSON.stringify(state))
    const firstTab = page.getByRole('tab', { name: label(0), exact: true })
    const secondTab = page.getByRole('tab', { name: label(1), exact: true })
    const secondClose = page.getByRole('button', { name: `Close ${label(1)}`, exact: true })
    const visibleCloses = async () => (await layout()).tabs.map(tab => tab.closeVisible)
    const titleGeometry = async () => (await layout()).tabs.map(({ left, right, width, titleLeft, titleWidth }) => ({ left, right, width, titleLeft, titleWidth }))
    await page.mouse.move(0, 500)
    await page.locator('[data-agent-composer-input]').focus()
    await expect.poll(visibleCloses).toEqual([false, true])
    const originalGeometry = await titleGeometry()
    assert.ok((await layout()).tabs.every(tab => tab.titleUnderClose), 'Titles must use the space beneath floating close buttons.')
    await page.locator('.workspace-panels-titlebar').screenshot({ path: join(tmpdir(), 'anas-tabs-titles.png') })
    await firstTab.hover()
    await expect.poll(visibleCloses).toEqual([true, true])
    assert.deepEqual(await titleGeometry(), originalGeometry, 'Hovering must not change tab positions or title widths.')
    await page.locator('.workspace-panels-titlebar').screenshot({ path: join(tmpdir(), 'anas-tabs-hover-close.png') })
    await firstTab.click()
    await page.mouse.move(0, 500)
    await page.locator('[data-agent-composer-input]').focus()
    await expect.poll(visibleCloses).toEqual([true, false])
    assert.deepEqual(await titleGeometry(), originalGeometry, 'Switching tabs must not change text truncation or tab positions.')
    await secondClose.focus()
    await expect(secondClose).toBeFocused()
    await expect.poll(visibleCloses).toEqual([true, true])
    await expect(firstTab).toHaveAttribute('aria-selected', 'true')
    await expect(secondTab).toHaveAttribute('aria-selected', 'false')
    assert.deepEqual(await titleGeometry(), originalGeometry, 'Keyboard focus must reveal close buttons without changing layout.')
    await page.locator('[data-agent-composer-input]').focus()
    await expect.poll(visibleCloses).toEqual([true, false])
    await secondTab.hover()
    await secondClose.click()
    await expect(secondTab).toHaveCount(0)
    await expect(firstTab).toHaveAttribute('aria-selected', 'true')
    await open(1)
    await expect(secondTab).toHaveAttribute('aria-selected', 'true')

    const order = () => list.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))
    const startDrag = async (tab, x, y) => {
      const bounds = await tab.boundingBox()
      await page.mouse.move(bounds.x + 16, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.move(x, y, { steps: 8 })
    }
    const secondBounds = await secondTab.boundingBox()
    await startDrag(firstTab, secondBounds.x + secondBounds.width - 8, secondBounds.y + secondBounds.height / 2)
    await expect(page.locator('.ui-tab-insertion-marker')).toBeVisible()
    await page.mouse.up()
    await expect.poll(order).toEqual([label(1), label(0)])
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'light' }))
    await expect.poll(order).toEqual([label(1), label(0)])
    await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'dark' }))
    const draggedContent = await pluginPage(application, 'tabs-test', 'tab-0')
    await draggedContent.evaluate(() => { globalThis.unsavedTabDragState = 'Live page after drag' })
    const beforePageId = (await draggedContent.evaluate(() => globalThis.anas.getContext())).pageId
    const beforeDetach = await pluginGeometry(application, draggedContent)
    const headerBounds = await page.locator('.workspace-panels-titlebar').boundingBox()
    const outside = { x: headerBounds.x + 80, y: headerBounds.y + headerBounds.height + 100 }
    await startDrag(firstTab, outside.x, outside.y)
    await expect(page.getByRole('status')).toHaveText('Release to open in a window')
    assert.deepEqual(await pluginGeometry(application, draggedContent), beforeDetach,
      'Dragging over iframe content must not hide or resize it.')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.equal((await draggedContent.evaluate(() => globalThis.anas.getInfo())).view.location, 'sidebar')
    assert.deepEqual(await order(), [label(1), label(0)])
    await startDrag(firstTab, outside.x, outside.y)
    await expect(page.getByRole('status')).toHaveText('Release to open in a window')
    await page.mouse.up()
    const detached = await pluginPage(application, 'tabs-test', 'tab-0', 'window')
    assert.notEqual((await detached.evaluate(() => globalThis.anas.getContext())).pageId, beforePageId)
    assert.equal(await detached.evaluate(() => globalThis.unsavedTabDragState), 'Live page after drag')
    await expect.poll(order).toEqual([label(1)])
    const shell = await pluginWindow(application, detached)
    await shell.getByRole('button', { name: 'Move to side panel', exact: true }).click()
    await expect.poll(order).toEqual([label(1), label(0)])
    const returned = await pluginPage(application, 'tabs-test', 'tab-0')
    assert.notEqual((await returned.evaluate(() => globalThis.anas.getContext())).pageId, beforePageId)
    assert.equal(await returned.evaluate(() => globalThis.unsavedTabDragState), 'Live page after drag')
    const beforeFirst = await secondTab.boundingBox()
    await startDrag(firstTab, beforeFirst.x + 8, beforeFirst.y + beforeFirst.height / 2)
    await page.mouse.up()
    await expect.poll(order).toEqual([label(0), label(1)])

    await page.getByRole('button', { name: 'Expand right workspace to fill conversation area', exact: true }).click()
    await verifyDragSpace()
    await page.getByRole('tab', { name: label(0), exact: true }).click()
    await expect(page.getByRole('tab', { name: label(0), exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.locator('.workspace-panels-titlebar').screenshot({ path: join(tmpdir(), 'anas-tabs-drag-space.png') })
    await page.getByRole('button', { name: 'Restore right workspace width', exact: true }).click()

    await resizePanel(process.platform === 'win32' ? 470 : 320)
    // Constrain titles even at the smallest supported font while all icons still fit.
    await open(2); await open(3); await open(4)
    for (const fontSize of [10, 14, 18]) {
      await setFont(fontSize)
      await expect.poll(async () => (await layout()).tabs.every(tab => !tab.titleVisible && !tab.closeVisible)).toBe(true)
      state = await layout()
      assert.ok(state.contentWidth <= state.width + 1, 'Icon-only tabs must remain fully visible while they fit.')
      assert.ok(state.tabs.every(tab => tab.named && tab.iconInside && tab.left >= -1 && tab.right <= state.width + 1))
    }
    await page.getByRole('tab', { name: label(0), exact: true }).click()
    await expect(page.getByRole('tab', { name: label(0), exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.locator('.workspace-panels-titlebar').screenshot({ path: join(tmpdir(), 'anas-tabs-icons.png') })
    if (process.platform !== 'win32') {
      // Exercise the Windows CSS fallback separately from native Windows validation.
      const platform = await page.evaluate(() => globalThis.document.documentElement.dataset.platform)
      await page.evaluate(() => { globalThis.document.documentElement.dataset.platform = 'win32' })
      await resizePanel(470)
      const reserved = await page.locator('.workspace-panels-titlebar').evaluate(element => {
        const tabs = element.querySelector('[role="tablist"]').getBoundingClientRect()
        const actions = element.querySelector('.ui-tab-workspace-actions').getBoundingClientRect()
        return { tabsRight: tabs.right, tabsBottom: tabs.bottom, actionsLeft: actions.left, actionsBottom: actions.bottom,
          safeWidth: globalThis.innerWidth - actions.right }
      })
      assert.ok(reserved.tabsRight <= reserved.actionsLeft && reserved.tabsBottom <= reserved.actionsBottom)
      assert.ok(reserved.safeWidth >= 138, 'The fallback must reserve native Windows caption buttons.')
      state = await layout()
      assert.ok(state.contentWidth <= state.width + 1 && state.tabs.every(tab => !tab.titleVisible))
      await page.evaluate(platform => { globalThis.document.documentElement.dataset.platform = platform }, platform)
      await page.getByRole('separator', { name: 'Resize right workspace', exact: true }).press('Home')
    }
    const content = await pluginPage(application, 'tabs-test', 'tab-0')
    const geometry = await pluginGeometry(application, content)
    await page.getByRole('tab', { name: label(0), exact: true }).hover()
    const tooltip = await tooltipPage(application, label(0))
    await tooltip.screenshot({ path: join(tmpdir(), 'anas-tabs-tooltip.png') })
    assert.deepEqual(await pluginGeometry(application, content), geometry, 'The shared tooltip must preserve the iframe content view.')

    const otherTab = page.getByRole('tab', { name: label(1), exact: true })
    await otherTab.click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    assert.deepEqual(await pluginGeometry(application, content), geometry, 'Right-clicking a background tab must leave the active content visible.')
    await page.keyboard.press('Escape')
    await expect(otherTab).toHaveCount(1)
    await otherTab.focus()
    const otherContent = await pluginPage(application, 'tabs-test', 'tab-1')
    await otherTab.press('Shift+F10')
    await expect(page.getByRole('menu')).toBeVisible()
    assert.equal((await pluginGeometry(application, otherContent)).visible, true)
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
    await expect(otherTab).toHaveCount(0)
    await open(1)

    for (let i = 5; i < 10; i++) await open(i)
    await expect.poll(async () => (await layout()).contentWidth > (await layout()).width).toBe(true)
    assert.ok((await layout()).tabs.every(tab => !tab.titleVisible && tab.iconInside))
    await list.evaluate(element => { element.scrollLeft = 0 })
    const scrollbar = await list.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.bottom - (element.offsetHeight - element.clientHeight) / 2,
        thickness: element.offsetHeight - element.clientHeight,
        thumb: element.clientWidth * element.clientWidth / element.scrollWidth,
        width: element.clientWidth, region: globalThis.getComputedStyle(element).getPropertyValue('-webkit-app-region') }
    })
    assert.ok(scrollbar.thickness > 0)
    assert.equal(scrollbar.region, 'no-drag')
    const windowBefore = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    const x = scrollbar.x + scrollbar.thumb / 2
    await page.mouse.move(x, scrollbar.y)
    await page.mouse.down()
    await page.mouse.move(x + (scrollbar.width - scrollbar.thumb) * 0.7, scrollbar.y, { steps: 12 })
    await page.mouse.up()
    await expect.poll(async () => (await layout()).left).toBeGreaterThan(10)
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), windowBefore,
      'Dragging the scrollbar must not move the application window.')
    await page.locator('.workspace-panels-titlebar').screenshot({ path: join(tmpdir(), 'anas-tabs-scroll.png') })
    const orderBeforeEdgeDrag = await order()
    await list.evaluate(element => { element.scrollLeft = 0 })
    const edge = await list.boundingBox()
    await startDrag(firstTab, edge.x + edge.width - 3, edge.y + edge.height / 2)
    await expect.poll(async () => (await layout()).left).toBeGreaterThan(10)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.deepEqual(await order(), orderBeforeEdgeDrag, 'Cancelling an auto-scrolling drag must keep the committed order.')
    await page.getByRole('tab', { name: label(9), exact: true }).focus()
    await page.keyboard.press('Home')
    await expect(page.getByRole('tab', { name: label(0), exact: true })).toBeFocused()
    await expect.poll(async () => (await layout()).left).toBeLessThan(1)
    await page.keyboard.press('Delete')
    await expect(page.getByRole('tab', { name: label(0), exact: true })).toHaveCount(0)

    // Growing the panel restores the labels instead of leaving stale icon mode.
    await setFont(14)
    await page.getByRole('button', { name: 'Expand right workspace to fill conversation area', exact: true }).click()
    await expect.poll(async () => (await layout()).tabs.every(tab => tab.titleVisible)).toBe(true)
    const area = await page.locator('.workspace-panels-titlebar').evaluate(element => {
      const bounds = element.getBoundingClientRect(), overlay = navigator.windowControlsOverlay
      const native = overlay?.visible ? overlay.getTitlebarAreaRect() : null
      const actions = element.querySelector('.ui-tab-workspace-actions').getBoundingClientRect()
      const tabs = element.querySelector('[role="tablist"]').getBoundingClientRect()
      return { x: bounds.x, tabsLeft: tabs.left, tabsRight: tabs.right, tabsTop: tabs.top,
        actionsLeft: actions.left, actionsRight: actions.right, actionsBottom: actions.bottom,
        nativeRight: native?.right, nativeBottom: native?.bottom }
    })
    if (process.platform === 'win32') {
      assert.ok(area.nativeRight > 0)
      assert.ok(area.actionsRight <= area.nativeRight)
      assert.ok(area.tabsRight <= area.actionsLeft || area.tabsTop >= area.actionsBottom)
    }
    assert.deepEqual(errors, [])
    console.log('Workspace tabs passed: reorder retention, edge scrolling and drag cancellation, detach/return rebuilding presentation and order, floating close buttons without title reflow, background-tab closing, title truncation, icon-only fit at 10/14/18px, shared tooltips, DOM menus preserving content, keyboard closing, draggable scrollbar, resizing and titlebar boundaries.')
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
    assert.deepEqual(nativeErrors, [], 'The main process must not raise native error dialogs, including during shutdown.')
  }
}

module.exports = { verifyWorkspaceTabs }
