const { expect } = require('playwright/test')

async function pluginPage(application, pluginId, instanceId = 'main', location = 'sidebar') {
  let found
  await expect.poll(async () => {
    for (const page of application.context().pages()) {
      if (page.url().includes('panel-window.html') !== (location === 'window')) continue
      for (const frame of page.frames()) {
        if (!frame.url().startsWith(`anas-plugin://${pluginId}/`)) continue
        const context = await frame.evaluate(() => globalThis.anas?.getContext()).catch(() => null)
        if (context?.view.content.instanceId !== instanceId || context.phase !== 'active') continue
        if (!(await (await frame.frameElement()).isVisible())) continue
        found = frame; return true
      }
    }
    return false
  }, { timeout: 20000 }).toBe(true)
  return found
}
const windowCount = application => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
async function pluginGeometry(_application, frame) {
  const element = await frame.frameElement()
  return { ...await element.boundingBox(), visible: await element.isVisible() }
}
async function pluginWindow(_application, frame) { return frame.page() }
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
      const tooltip = page.getByRole('tooltip')
      if (await tooltip.isVisible() && await tooltip.textContent() === label) { found = page; return true }
    }
    return false
  }).toBe(true)
  return found
}
module.exports = { pluginPage, windowCount, pluginGeometry, pluginWindow, pluginByTitle, tooltipPage }
