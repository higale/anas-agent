const assert = require('node:assert/strict')
const { mkdtemp, mkdir, writeFile, access, rm, cp } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function openCapabilityProject(page, name) {
  await page.locator('.project-thread-group').filter({ hasText: name }).locator('.project-thread-more').click()
  await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
  const dialog = page.locator('.project-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

async function verifyCapabilities(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-capabilities-'))
  let application
  try {
    const workspace = join(home, 'workspace')
    const local = join(workspace, '.agents/skills/local-guide')
    await mkdir(local, { recursive: true })
    await writeFile(join(local, 'SKILL.md'), '---\nname: local-guide\ndescription: Project-local instructions.\n---\nUse local project rules.\n')
    await cp(join(__dirname, '../data/examples/tools/json_format'), join(home, 'tools/json_format'), { recursive: true })
    application = await launchApplication(home)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    await page.locator('[data-agent-composer-input]').waitFor()
    const projectId = await page.evaluate(async workspace => {
      const api = globalThis.gale
      await api.config.updateSettings({ language: 'en' })
      await api.config.updateProfile({ assistant: { instructions: 'CAPABILITY_PROFILE_MARKER' } })
      const added = await api.config.saveModelProvider({ name: 'Preview', protocol: 'openai_chat_completions', baseUrl: 'https://preview.invalid/v1', apiKey: '', parameters: {} })
      const provider = added.providers.find(item => item.name === 'Preview')
      const models = await api.config.saveProviderModel({ providerId: provider.id, displayName: 'Preview', model: 'preview', parameters: {}, parameterPresetMode: 'none', capabilities: { vision: true, toolUse: true }, stream: true,
        maxContextTokens: 128000, maxOutputTokens: 16000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
      await api.config.selectDefaultModel(models.providers.find(item => item.id === provider.id).models[0].id)
      const base = (await api.projects.list()).find(item => item.id === 'default-workspace')
      const result = await api.projects.create({ ...base, name: 'Capability fixture', sourceFolders: [workspace], advancedSettings: true })
      assertResult(result)
      return result.value.id
      function assertResult(result) { if (result.status !== 'ok') throw new Error(JSON.stringify(result)) }
    }, workspace)
    await page.reload()
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await expect(page.locator('[data-settings-tab="capabilities"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    let dialog = await openCapabilityProject(page, 'Capability fixture')
    await expect(dialog.getByRole('checkbox', { name: 'Wait', exact: true })).toBeChecked()
    await dialog.getByRole('checkbox', { name: 'Wait', exact: true }).uncheck()
    await expect(dialog.getByRole('checkbox', { name: 'Background tools', exact: true })).toBeChecked()
    for (const name of ['Skills', 'Subagents', 'Custom tools']) {
      const section = dialog.getByRole('region', { name, exact: true })
      const picker = section.getByRole('radiogroup', { name, exact: true })
      await picker.getByText('Custom', { exact: true }).click()
      await expect(section.getByRole('checkbox')).toHaveCount(0)
      const disclosure = section.getByRole('button', { name, exact: true })
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
      await disclosure.click()
      const first = section.getByRole('checkbox').first()
      await first.locator('..').click()
      await expect(first).toBeChecked()
      if (name === 'Skills') await expect(section.getByRole('searchbox')).toHaveCount(0)
      for (const mode of ['All', 'Off']) {
        await picker.getByText(mode, { exact: true }).click()
        await expect(section.getByRole('checkbox')).toHaveCount(0)
      }
      await picker.getByText('Custom', { exact: true }).click()
      await expect(first).toBeChecked()
    }
    await dialog.getByRole('checkbox', { name: 'Profile', exact: true }).uncheck()
    await dialog.screenshot({ path: join(tmpdir(), 'anas-capabilities-project.png') })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const previews = await page.evaluate(async projectId => {
      const api = globalThis.gale, config = await api.config.get()
      const project = (await api.projects.list()).find(item => item.id === projectId)
      const custom = await api.agent.context.preview({ projectId, project, settings: config.settings })
      const all = await api.agent.context.preview({ projectId, project: { ...project, advancedSettings: false }, settings: config.settings })
      return { custom: custom.content.includes('CAPABILITY_PROFILE_MARKER'), all: all.content.includes('CAPABILITY_PROFILE_MARKER'), project }
    }, projectId)
    assert.equal(previews.custom, false)
    assert.equal(previews.all, true)
    assert.equal(previews.project.capabilities.skills.mode, 'custom')
    dialog = await openCapabilityProject(page, 'Capability fixture')
    await expect(dialog.getByRole('checkbox', { name: 'Wait', exact: true })).not.toBeChecked()
    const skills = dialog.getByRole('region', { name: 'Skills', exact: true })
    await expect(skills.getByRole('checkbox')).toHaveCount(0)
    await skills.getByRole('button', { name: 'Skills', exact: true }).click()
    await expect(skills.getByRole('checkbox').first()).toBeChecked()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    const globalSkill = await page.evaluate(async projectId => {
      const api = globalThis.gale
      const project = (await api.projects.list()).find(item => item.id === projectId)
      const catalog = await api.skills.get(projectId)
      const skill = catalog.skills.find(skill => skill.source !== 'project' && project.capabilities.skills.entries.some(entry => entry.id === skill.id && entry.shortcut))
      if (!skill) throw new Error('Expected a selected global skill.')
      await api.skills.updateAvailability(projectId, skill.id, { modelAvailable: false, userAvailable: false })
      return { id: skill.id, name: skill.name }
    }, projectId)
    dialog = await openCapabilityProject(page, 'Capability fixture')
    const disabledSkills = dialog.getByRole('region', { name: 'Skills', exact: true })
    await disabledSkills.getByRole('button', { name: 'Skills', exact: true }).click()
    const shortcut = disabledSkills.getByRole('checkbox', { name: `${globalSkill.name} Shortcut`, exact: true })
    const skillRow = disabledSkills.locator('.ui-capability-skill').filter({ has: page.getByRole('checkbox', { name: `${globalSkill.name} Shortcut`, exact: true }) })
    await expect(shortcut).toBeChecked()
    await expect(shortcut).toBeEnabled()
    const model = skillRow.getByRole('checkbox', { name: `${globalSkill.name} Model`, exact: true })
    await expect(model).not.toBeChecked()
    await expect(model).toBeDisabled()
    await expect(skillRow.getByText('Model use is disabled globally', { exact: false })).toHaveCount(0)
    await expect(skillRow.getByRole('alert')).toHaveText('Shortcut use is disabled globally')
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => globalThis.gale.config.updateSettings({ theme }), theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const warning = skillRow.getByRole('alert')
      const colors = await warning.evaluate(element => {
        const reference = globalThis.document.createElement('span')
        reference.style.color = 'var(--warning)'
        element.append(reference)
        const result = { actual: globalThis.getComputedStyle(element).color, expected: globalThis.getComputedStyle(reference).color }
        reference.remove()
        return result
      })
      assert.equal(colors.actual, colors.expected, `${theme} skill conflict should use the warning color`)
      await skillRow.screenshot({ path: join(tmpdir(), `anas-inactive-skill-selection-${theme}.png`) })
    }
    await shortcut.locator('..').click()
    await expect(shortcut).not.toBeChecked()
    await expect(shortcut).toBeDisabled()
    await expect(skillRow.getByRole('alert')).toHaveCount(0)
    await skillRow.screenshot({ path: join(tmpdir(), 'anas-inactive-skill-unselected.png') })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    const retained = await page.evaluate(async ({ projectId, id }) => {
      const project = (await globalThis.gale.projects.list()).find(item => item.id === projectId)
      return project.capabilities.skills.entries.find(entry => entry.id === id)
    }, { projectId, id: globalSkill.id })
    assert.equal(retained.shortcut, false)
    await assert.rejects(access(join(home, 'config/capabilities.json')), { code: 'ENOENT' })
    console.log('Capabilities E2E passed: no global page/file; collapsed All/Custom/Off groups; retained choices; global skill restrictions and warnings only for selected conflicts; project prompt projection.')
  } finally {
    await application?.close()
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyCapabilities, openCapabilityProject }
