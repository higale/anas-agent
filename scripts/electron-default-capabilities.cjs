const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function verifySelectionModes(page, scope, finishOff = false) {
  for (const [name, search, label] of [['Subagent selection', 'Search subagents', 'Subagents'], ['Skill selection', 'Search skills', 'Skills']]) {
    const picker = scope.getByRole('combobox', { name, exact: true })
    const section = scope.locator('.ui-form-section-divided').filter({ has: page.getByRole('combobox', { name, exact: true }) })
    await expect(scope.getByRole('checkbox', { name: label, exact: true })).toHaveCount(0)
    const choose = async mode => {
      await picker.click()
      await page.getByRole('option', { name: mode, exact: true }).click()
      await expect(picker).toHaveValue(mode)
    }
    await choose('Custom')
    await expect(section.getByRole('searchbox', { name: search })).toBeVisible()
    const selected = section.locator('input[type="checkbox"]:checked')
    const index = await selected.count() ? await section.getByRole('checkbox').evaluateAll(inputs => inputs.findIndex(input => input.checked)) : 0
    const first = section.getByRole('checkbox').nth(index)
    await first.check()
    for (const mode of ['Off', 'Use defaults']) {
      await choose(mode)
      await expect(section.getByRole('searchbox')).toHaveCount(0)
      await expect(section.getByRole('checkbox')).toHaveCount(0)
      await choose('Custom')
      await expect(first).toBeChecked()
    }
    if (finishOff) await choose('Off')
  }
}

async function verifyMissingProjectSkills(page) {
  const result = await page.evaluate(async () => {
    const project = (await globalThis.gale.projects.list()).find(item => item.id === 'default-workspace')
    return globalThis.gale.projects.update(project.id, { ...project, advancedSettings: true,
      capabilities: { ...project.capabilities, skills: { mode: 'custom', project: false, entries: [
        { id: 'project-deleted:unchecked-skill', shortcut: false, model: false },
        { id: 'project-deleted:selected-skill', shortcut: true, model: true }
      ] } } })
  })
  assert.equal(result.status, 'ok')
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await page.reload()
  const dialog = page.locator('.project-dialog')
  const openProject = async () => {
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    await expect(dialog).toBeVisible()
  }
  const savedEntries = () => page.evaluate(async () =>
    (await globalThis.gale.projects.list()).find(item => item.id === 'default-workspace').capabilities.skills.entries)
  await openProject()
  await verifySelectionModes(page, dialog)
  const removeUnchecked = dialog.getByRole('button', { name: 'Remove missing skill: project-deleted:unchecked-skill', exact: true })
  await removeUnchecked.scrollIntoViewIfNeeded()
  if (process.env.ANAS_E2E_MISSING_SKILLS_SCREENSHOT) await dialog.screenshot({ path: process.env.ANAS_E2E_MISSING_SKILLS_SCREENSHOT })
  await removeUnchecked.click()
  await expect(dialog.getByText('project-deleted:unchecked-skill', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const retained = [{ id: 'project-deleted:selected-skill', shortcut: true, model: true }]
  await expect.poll(savedEntries).toEqual(retained)
  await openProject()
  const removeSelected = dialog.getByRole('button', { name: 'Remove missing skill: project-deleted:selected-skill', exact: true })
  await removeSelected.click()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  assert.deepEqual(await savedEntries(), retained)
  await openProject()
  await removeSelected.click()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(savedEntries).toEqual([])
}

async function verifyDefaultCapabilities(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-default-capabilities-'))
  let application
  try {
    application = await launchApplication(home)
    let page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.locator('[data-agent-composer-input]').waitFor()
    const original = await page.evaluate(async () => {
      const api = globalThis.gale
      await api.config.updateSettings({ language: 'en' })
      await api.config.updateProfile({ assistant: { instructions: 'CAPABILITY_PROFILE_MARKER' } })
      const providerConfig = await api.config.saveModelProvider({ name: 'Preview', protocol: 'openai_chat_completions',
        baseUrl: 'https://preview.invalid/v1', apiKey: '', parameters: {}, modelListAuth: 'bearer' })
      const provider = providerConfig.providers.find(item => item.name === 'Preview')
      const configured = await api.config.saveProviderModel({ providerId: provider.id, displayName: 'Preview', model: 'preview', parameters: {},
        parameterPresetMode: 'custom', parameterPresets: [{ id: 'careful', name: 'Careful', parameters: { temperature: 0.1 } }],
        defaultParameterPresetId: 'careful', capabilities: { vision: true, toolUse: true }, stream: true,
        maxContextTokens: 128000, maxOutputTokens: 16000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
      await api.config.selectDefaultModel(configured.providers[0].models[0].id)
      return { project: (await api.projects.list()).find(item => item.id === 'default-workspace'),
        subagents: configured.subagents }
    })
    await page.reload()
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="capabilities"]').click()
    const section = page.locator('.settings-section')
    await section.getByRole('checkbox', { name: 'Profile', exact: true }).uncheck()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).defaultCapabilities.capabilities.profile)).toBe(false)
    await section.getByRole('checkbox', { name: 'Limit subagent capabilities', exact: true }).check()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).defaultCapabilities.restrictSubagents)).toBe(true)
    assert.equal(JSON.parse(await readFile(join(home, 'config', 'capabilities.json'), 'utf8')).profile, false)
    const previews = await page.evaluate(async () => {
      const api = globalThis.gale
      const config = await api.config.get()
      const project = (await api.projects.list()).find(item => item.id === 'default-workspace')
      const inherited = await api.agent.context.preview({ projectId: project.id, project: { ...project, advancedSettings: false }, settings: config.settings })
      const custom = await api.agent.context.preview({ projectId: project.id,
        project: { ...project, advancedSettings: true, capabilities: { ...project.capabilities, profile: true } }, settings: config.settings })
      return { inherited: inherited.content.includes('CAPABILITY_PROFILE_MARKER'), custom: custom.content.includes('CAPABILITY_PROFILE_MARKER'),
        project: (await api.projects.list()).find(item => item.id === project.id), subagents: config.subagents }
    })
    assert.equal(previews.inherited, false)
    assert.equal(previews.custom, true)
    assert.deepEqual(previews.project, original.project)
    assert.deepEqual(previews.subagents, original.subagents)
    await verifySelectionModes(page, section, true)
    const off = await page.evaluate(async () => (await globalThis.gale.config.get()).defaultCapabilities.capabilities)
    assert.equal(off.subagents.mode, 'off')
    assert.equal(off.skills.mode, 'off')
    const raw = JSON.parse(await readFile(join(home, 'config', 'capabilities.json'), 'utf8'))
    assert.deepEqual(raw.subagents, off.subagents)
    assert.deepEqual(raw.skills, off.skills)
    assert.equal('enabled' in raw.skills, false)
    assert.equal('subagent_selection' in raw, false)
    await page.locator('[data-settings-tab="subagents"]').click()
    const subagentEditor = page.locator('.settings-subagent-editor')
    const modelPicker = subagentEditor.getByRole('button', { name: 'Select model', exact: true })
    await expect(modelPicker).toHaveText('Follow parent Agent')
    await expect(subagentEditor.getByRole('button', { name: 'Reasoning options', exact: true })).toHaveCount(0)
    await modelPicker.click()
    await page.getByRole('menuitemradio', { name: /Preview/ }).click()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).subagents[0].modelParameterPresetId)).toBe('careful')
    await expect(modelPicker).toHaveText('Preview')
    const presetPicker = subagentEditor.getByRole('button', { name: 'Reasoning options', exact: true })
    await expect(presetPicker).toHaveText('Careful')
    await presetPicker.click()
    await page.getByRole('menuitem', { name: 'Not selected', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).subagents[0].modelParameterPresetId)).toBe(null)
    await modelPicker.click()
    await page.getByRole('menuitemradio', { name: 'Follow parent Agent', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).subagents[0].modelConfigId)).toBe(undefined)
    await modelPicker.click()
    await page.getByRole('menuitemradio', { name: /Preview/ }).click()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).subagents[0].modelParameterPresetId)).toBe('careful')
    const savedSubagent = JSON.parse(await readFile(join(home, 'config/subagents.json'), 'utf8')).subagents[0]
    assert.ok(savedSubagent.model_config_id)
    assert.equal(savedSubagent.model_parameter_preset_id, 'careful')
    for (const width of [900, 1180]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 780), width)
      await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(width)
      await modelPicker.scrollIntoViewIfNeeded()
      const controls = await Promise.all([subagentEditor.getByText('Identifier', { exact: true }).boundingBox(), modelPicker.boundingBox(), presetPicker.boundingBox()])
      for (const [index, bounds] of controls.entries()) {
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width)
        for (const other of controls.slice(index + 1)) assert.ok(other && (bounds.x + bounds.width <= other.x + 1 || other.x + other.width <= bounds.x + 1
          || bounds.y + bounds.height <= other.y + 1 || other.y + other.height <= bounds.y + 1), 'Identifier label and model controls must not overlap.')
      }
      if (process.env.ANAS_E2E_SUBAGENT_MODEL_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_SUBAGENT_MODEL_SCREENSHOT.replace('.png', `-${width}.png`) })
    }
    await verifySelectionModes(page, page.locator('.settings-subagent-editor'), true)
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).subagents[0].capabilities.skills.mode)).toBe('off')
    await page.locator('[data-settings-tab="capabilities"]').click()
    if (process.env.ANAS_E2E_CAPABILITIES_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CAPABILITIES_SCREENSHOT })
    await verifyMissingProjectSkills(page)
    await application.close()
    application = await launchApplication(home)
    page = await application.firstWindow()
    await page.locator('[data-agent-composer-input]').waitFor()
    assert.deepEqual(await page.evaluate(async () =>
      (await globalThis.gale.projects.list()).find(item => item.id === 'default-workspace').capabilities.skills.entries), [])
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="capabilities"]').click()
    for (const name of ['Subagent selection', 'Skill selection']) {
      await expect(page.getByRole('combobox', { name, exact: true })).toHaveValue('Off')
    }
    const saved = await page.evaluate(() => globalThis.gale.config.get())
    assert.equal(saved.subagents[0].modelConfigId, savedSubagent.model_config_id)
    assert.equal(saved.subagents[0].modelParameterPresetId, 'careful')
    assert.equal(saved.subagents[0].capabilities.subagents.mode, 'off')
    assert.equal(saved.subagents[0].capabilities.skills.mode, 'off')
    await expect(page.getByRole('checkbox', { name: 'Profile', exact: true })).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Limit subagent capabilities', exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'Enable all', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Profile', exact: true })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Limit subagent capabilities', exact: true })).not.toBeChecked()
    // Hold one IPC response to exercise leaving and remounting the page mid-save.
    const snapshot = await page.evaluate(() => globalThis.gale.config.get())
    await application.evaluate(({ ipcMain }, snapshot) => {
      ipcMain.removeHandler('config:saveDefaultCapabilities')
      ipcMain.handle('config:saveDefaultCapabilities', async (_event, value) => {
        await new Promise(resolve => { globalThis.__finishCapabilitySave = resolve })
        return { ...snapshot, defaultCapabilities: value }
      })
    }, snapshot)
    await page.getByRole('checkbox', { name: 'Profile', exact: true }).uncheck()
    await expect(page.getByRole('checkbox', { name: 'Profile', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="capabilities"]').click()
    const pendingProfile = page.getByRole('checkbox', { name: 'Profile', exact: true })
    await expect(pendingProfile).not.toBeChecked()
    await expect(pendingProfile).toBeDisabled()
    await application.evaluate(() => { globalThis.__finishCapabilitySave(); delete globalThis.__finishCapabilitySave })
    await expect(pendingProfile).toBeEnabled()
    await expect(pendingProfile).not.toBeChecked()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ fontSize: 18, sidebarWidth: 420 }))
    await page.reload()
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="capabilities"]').click()
    for (const width of [900, 1180]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 780), width)
      await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(width)
      const controls = await Promise.all([
        page.getByRole('button', { name: 'Enable all', exact: true }).boundingBox(),
        page.getByRole('button', { name: 'Disable all', exact: true }).boundingBox(),
        page.getByRole('checkbox', { name: 'Limit subagent capabilities', exact: true }).locator('..').boundingBox()
      ])
      for (const [index, bounds] of controls.entries()) {
        assert.ok(bounds && bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Capability toolbar controls must fit the window.')
        for (const other of controls.slice(index + 1)) {
          assert.ok(other && (bounds.x + bounds.width <= other.x || other.x + other.width <= bounds.x
            || bounds.y + bounds.height <= other.y || other.y + other.height <= bounds.y),
          `Capability toolbar controls must not overlap at width ${width}: ${JSON.stringify(controls)}`)
        }
      }
      if (width === 900 && process.env.ANAS_E2E_CAPABILITIES_NARROW_SCREENSHOT) {
        await page.screenshot({ path: process.env.ANAS_E2E_CAPABILITIES_NARROW_SCREENSHOT })
      }
    }
    console.log('Default capabilities E2E passed: default/custom/off modes; subagent model and preset selection, clearing, persistence and restart; identifier toolbar layout; project overrides, prompt previews and pending saves.')
  } finally {
    await application?.close()
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyDefaultCapabilities }
