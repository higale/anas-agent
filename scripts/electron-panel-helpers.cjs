const { expect } = require('playwright/test')

async function panelGeometry(application, page) {
  return application.evaluate(({ BrowserWindow }, url) => {
    for (const window of BrowserWindow.getAllWindows()) for (const child of window.contentView.children) {
      if (child.webContents?.getURL() === url) return { ...child.getBounds(), visible: child.getVisible(), contentsId: child.webContents.id, ownerId: window.id }
    }
    return null
  }, page.url())
}
async function panelPage(application, kind, location = 'sidebar') {
  let found
  await expect.poll(async () => {
    for (const page of application.context().pages()) {
      if (!page.url().includes('panel-content.html')) continue
      const state = await page.evaluate(() => globalThis.panelContent?.getState()).catch(() => null)
      if (state?.view.content.kind === kind && state.view.location === location && (await panelGeometry(application, page))?.visible) { found = page; return true }
    }
    return false
  }, { timeout: 20000 }).toBe(true)
  return found
}
async function panelWindow(application, contentPage) {
  const viewId = (await contentPage.evaluate(() => globalThis.panelContent.getState())).view.viewId
  let found
  await expect.poll(async () => {
    for (const page of application.context().pages()) {
      if (!page.url().includes('panel-window.html')) continue
      const state = await page.evaluate(() => globalThis.panelWindow.getState()).catch(() => null)
      if (state?.view.viewId === viewId) { found = page; return true }
    }
    return false
  }).toBe(true)
  return found
}
module.exports = { panelPage, panelGeometry, panelWindow }
