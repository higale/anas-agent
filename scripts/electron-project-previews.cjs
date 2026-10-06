const { expect } = require('playwright/test')

async function verifyProjectPreviews(application) {
  const page = await application.firstWindow()
  await page.reload()
  const created = await page.evaluate(async () => {
    const defaults = (await globalThis.gale.projects.list()).find(project => project.id === 'default-workspace')
    const result = await globalThis.gale.projects.create({ ...defaults, name: 'E2E prompt tabs', advancedSettings: true })
    if (result.status !== 'ok') throw new Error(JSON.stringify(result.error))
    return result.value
  })
  await page.reload()
  await page.locator('.project-thread-group').filter({ hasText: created.name }).locator('.project-thread-more').click()
  await page.locator('.project-details-action').filter({ hasText: /Edit|编辑/ }).click()
  const project = page.locator('.project-dialog')
  const before = await page.evaluate(() => globalThis.gale.projects.list())
  await project.getByRole('checkbox', { name: /^(定制能力|Customize capabilities)$/ }).check()
  const marker = 'PROJECT_PREVIEW_UNSAVED_INSTRUCTIONS'
  const prompt = project.getByRole('textbox', { name: /^(项目提示词|Project prompt)$/ })
  await prompt.fill(marker)
  await project.getByRole('tab', { name: /^(压缩提示词|Compression prompt)$/ }).click()
  const compression = project.getByRole('textbox', { name: /^(压缩提示词|Compression prompt)$/ })
  await expect(compression).toHaveValue('')
  await project.getByRole('button', { name: /^(载入默认|Load default)$/ }).click()
  await expect(compression).toHaveValue(/\{conversation\}/)
  await compression.fill('Keep citations: {conversation}')
  await expect.poll(() => project.evaluate(element => {
    const active = element.querySelector('[role="tabpanel"][data-state="active"]')
    const inactive = element.querySelector('[role="tabpanel"][data-state="inactive"]')
    const folders = element.querySelector('.project-folders')
    return element.ownerDocument.defaultView.getComputedStyle(inactive).display === 'none'
      && active.getBoundingClientRect().bottom <= folders.getBoundingClientRect().top
  })).toBe(true)
  await project.getByRole('checkbox', { name: /^(定制能力|Customize capabilities)$/ }).uncheck()
  await expect(project.getByRole('tab', { name: /^(压缩提示词|Compression prompt)$/ })).toHaveCount(0)
  await expect(project.getByRole('button', { name: /^(载入默认|Load default)$/ })).toHaveCount(0)
  await project.getByRole('button', { name: /^(更多|More)$/ }).click()
  await page.getByRole('menuitem', { name: /^(压缩提示词|Compression prompt)$/ }).click()
  await expect(page.locator('.settings-code-preview-dialog pre')).toContainText('You are a conversation summarizer')
  await expect(page.locator('.settings-code-preview-dialog pre')).not.toContainText('Keep citations')
  await page.keyboard.press('Escape')
  await project.getByRole('checkbox', { name: /^(定制能力|Customize capabilities)$/ }).check()
  await project.getByRole('tab', { name: /^(压缩提示词|Compression prompt)$/ }).click()
  await expect(compression).toHaveValue('Keep citations: {conversation}')
  await project.getByRole('tab', { name: /^(项目提示词|Project prompt)$/ }).click()
  await expect(prompt).toHaveValue(marker)
  for (const [name, content] of [
    [/^(完整提示词|Full prompt)$/, marker],
    [/^(压缩提示词|Compression prompt)$/, 'Keep citations: {conversation}'],
    [/^(预览请求|Preview request)$/, marker]
  ]) {
    await project.getByRole('button', { name: /^(更多|More)$/ }).click()
    await page.getByRole('menuitem', { name }).click()
    const preview = page.locator('.settings-code-preview-dialog')
    await expect(preview.locator('pre')).not.toBeEmpty({ timeout: 30_000 })
    if (content) await expect(preview.locator('pre')).toContainText(content)
    // No delay: Escape during a freshly opened nested layer must preserve its owner.
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await expect(project).toBeVisible()
    await expect(prompt).toHaveValue(marker)
  }
  if (process.env.ANAS_E2E_PROJECT_PREVIEW_SCREENSHOT) {
    await project.screenshot({ path: process.env.ANAS_E2E_PROJECT_PREVIEW_SCREENSHOT })
  }
  await project.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
  await expect.poll(() => page.evaluate(() => globalThis.gale.projects.list())).toEqual(before)
  await page.evaluate(id => globalThis.gale.projects.delete(id), created.id)
}

module.exports = { verifyProjectPreviews }
