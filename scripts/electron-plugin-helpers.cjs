const { expect } = require('playwright/test')

async function pluginPage(application, pluginId, instanceId = 'main', location = 'sidebar') {
  let found
  await expect.poll(async () => {
    for (const page of application.context().pages()) {
      if (!page.url().startsWith(`anas-plugin://${pluginId}/`)) continue
      const info = await page.evaluate(async () => globalThis.anas?.getInfo()).catch(() => null)
      if (info?.view?.instanceId === instanceId && info.view.location === location
        && await page.evaluate(() => globalThis.innerWidth > 0 && globalThis.innerHeight > 0)) { found = page; return true }
    }
    return false
  }, { timeout: 20000 }).toBe(true)
  await expect.poll(async () => (await pluginGeometry(application, found))?.visible, { timeout: 20000 }).toBe(true)
  return found
}

const windowCount = application => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
  .filter(window => !window.webContents.getURL().endsWith('#anas-native-tooltip')).length)

async function pluginGeometry(application, page) {
  const url = page.url()
  const info = await page.evaluate(() => globalThis.anas.getInfo())
  return application.evaluate(({ BrowserWindow }, { url, location }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const shell = window.webContents.getURL().includes('panel-window.html')
      if (shell !== (location === 'window')) continue
      for (const child of window.contentView.children) {
        if (child.webContents?.getURL() === url) return { ...child.getBounds(), visible: child.getVisible(), contentsId: child.webContents.id }
      }
    }
    return null
  }, { url, location: info.view.location })
}

async function pluginWindow(application, plugin) {
  const info = await plugin.evaluate(() => globalThis.anas.getInfo())
  let found
  await expect.poll(async () => {
    for (const page of application.context().pages()) {
      if (!page.url().includes('panel-window.html')) continue
      const state = await page.evaluate(() => globalThis.panelWindow.getState()).catch(() => null)
      if (state?.view.content.pluginId === info.pluginId && state.view.content.instanceId === info.view.instanceId) { found = page; return true }
    }
    return false
  }).toBe(true)
  return found
}

async function pluginByTitle(application, host, pluginId, title, location) {
  let view
  await expect.poll(async () => {
    view = (await host.evaluate(() => globalThis.gale.panels.list()))
      .find(view => view.content.pluginId === pluginId && view.name === title && view.location === location)
    return !!view
  }).toBe(true)
  return pluginPage(application, pluginId, view.content.instanceId, location)
}

async function tooltipPage(application, label) {
  let found
  await expect.poll(async () => {
    for (const page of application.context().pages()) {
      if (!page.url().endsWith('#anas-native-tooltip')) continue
      if (await page.getByRole('tooltip').textContent().catch(() => null) === label) { found = page; return true }
    }
    return false
  }).toBe(true)
  await expect.poll(() => application.evaluate(({ BrowserWindow }, url) => {
    return BrowserWindow.getAllWindows().some(window => window.webContents.getURL() === url && window.isVisible())
  }, found.url())).toBe(true)
  return found
}

module.exports = { pluginPage, windowCount, pluginGeometry, pluginWindow, pluginByTitle, tooltipPage }
