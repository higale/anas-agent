const { expect } = require('playwright/test')
async function panelPage(application, kind, location = 'sidebar') {
  let found
  await expect.poll(async () => {
    for (const page of application.context().pages()) {
      if (page.url().includes('panel-window.html') !== (location === 'window')) continue
      if (await page.locator(`[data-panel-kind="${kind}"].panel-page:visible`).count()) { found = page; return true }
    }
    return false
  }, { timeout: 20000 }).toBe(true)
  return found
}
async function panelGeometry(_application, page) {
  const panel = page.locator('.panel-page:visible').first()
  return { ...await panel.boundingBox(), visible: await panel.isVisible() }
}
module.exports = { panelPage, panelGeometry }
