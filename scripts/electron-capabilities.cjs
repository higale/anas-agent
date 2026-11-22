const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, writeFile, access, rm, cp } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, dirname } = require('node:path')
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
    const userSkill = join(home, 'skills/user-guide')
    await mkdir(userSkill, { recursive: true })
    await writeFile(join(userSkill, 'SKILL.md'), '---\nname: user-guide\ndescription: User instructions.\n---\nUse user rules.\n')
    await cp(join(__dirname, '../data/examples/tools/json_format'), join(home, 'tools/json_format'), { recursive: true })
    const localToolRoot = join(workspace, '.agents/tools')
    const extraToolRoot = join(home, 'referenced-tools')
    await cp(join(__dirname, '../data/examples/tools/json_format'), join(localToolRoot, 'json_format'), { recursive: true })
    const localToolManifest = join(localToolRoot, 'json_format/TOOL.json')
    await writeFile(localToolManifest, JSON.stringify({ ...JSON.parse(await readFile(localToolManifest, 'utf8')), description: 'PROJECT_TOOL_DIRECTORY_MARKER' }))
    await mkdir(extraToolRoot, { recursive: true })
    application = await launchApplication(home)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15000)
    await page.locator('[data-agent-composer-input]').waitFor()
    const projectId = await page.evaluate(async workspace => {
      const api = globalThis.gale
      await api.config.updateSettings({ language: 'en' })
      await api.config.updateProfile({ assistant: { role: 'CAPABILITY_PROFILE_MARKER' } })
      const added = await api.config.saveModelProvider({ name: 'Preview', protocol: 'openai_chat_completions', baseUrl: 'https://preview.invalid/v1', apiKey: '', parameters: {} })
      const provider = added.providers.find(item => item.name === 'Preview')
      const models = await api.config.saveProviderModel({ providerId: provider.id, displayName: 'Preview', model: 'preview', parameters: {}, parameterPresetMode: 'none', capabilities: { vision: true, toolUse: true }, stream: true,
        maxContextTokens: 128000, maxOutputTokens: 16000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
      await api.config.selectDefaultModel(models.providers.find(item => item.id === provider.id).models[0].id)
      const base = (await api.projects.list()).find(item => item.id === 'default-workspace')
      const result = await api.projects.create({ ...base, name: 'Capability fixture', sourceFolders: [workspace] })
      assertResult(result)
      return result.value.id
      function assertResult(result) { if (result.status !== 'ok') throw new Error(JSON.stringify(result)) }
    }, workspace)
    await page.reload()
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await expect(page.locator('[data-settings-tab="capabilities"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    const initialCatalogs = await page.evaluate(async id => ({
      skills: await globalThis.gale.skills.get(id), tools: await globalThis.gale.tools.get(id)
    }), projectId)
    assert.equal(initialCatalogs.skills.skills.some(skill => skill.source === 'project'), false)
    assert.equal(initialCatalogs.tools.tools.some(tool => tool.source === 'project'), false)
    const savedDirectories = () => page.evaluate(async id => {
      const project = (await globalThis.gale.projects.list()).find(item => item.id === id)
      return { skills: project.skillDirectories, tools: project.toolDirectories }
    }, projectId)
    let dialog
    for (const action of ['Cancel', 'Save']) {
      dialog = await openCapabilityProject(page, 'Capability fixture')
      for (const [section, label, paths] of [
        ['Skills', 'Add skill directories', [dirname(local)]],
        ['Custom tools', 'Add tool directories', [localToolRoot, extraToolRoot]]
      ]) {
        const group = dialog.getByRole('region', { name: section, exact: true })
        const disclosure = group.getByRole('button', { name: section, exact: true })
        await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
        await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }) }, paths)
        await group.getByRole('button', { name: label, exact: true }).click()
        await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
        await disclosure.click()
        await expect(group.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0)
        if (section === 'Skills') {
          await expect(group.getByRole('checkbox', { name: 'local-guide', exact: true })).toBeVisible()
        }
        else {
          await expect(group.getByRole('region', { name: localToolRoot, exact: true }).getByRole('checkbox', { name: /json_format$/ })).toBeVisible()
          await expect(group.getByRole('region', { name: extraToolRoot, exact: true })).toBeVisible()
        }
      }
      assert.deepEqual(await savedDirectories(), { skills: [], tools: [] }, 'Draft references must not modify the saved project.')
      await dialog.getByRole('button', { name: action, exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    assert.deepEqual(await savedDirectories(), { skills: [dirname(local)], tools: [localToolRoot, extraToolRoot] })
    const resourcePreviews = await page.evaluate(async projectId => {
      const api = globalThis.gale, config = await api.config.get()
      const project = (await api.projects.list()).find(item => item.id === projectId)
      return {
        saved: (await api.agent.context.previewModelRequest({ projectId, project, settings: config.settings })).content,
        cleared: (await api.agent.context.previewModelRequest({ projectId, project: { ...project, skillDirectories: [], toolDirectories: [] }, settings: config.settings })).content
      }
    }, projectId)
    assert.ok(resourcePreviews.saved.includes('PROJECT_TOOL_DIRECTORY_MARKER'))
    assert.ok(resourcePreviews.saved.includes('Project-local instructions.'))
    assert.equal(resourcePreviews.cleared.includes('PROJECT_TOOL_DIRECTORY_MARKER'), false)
    assert.equal(resourcePreviews.cleared.includes('Project-local instructions.'), false)
    const isolated = await page.evaluate(async () => ({
      global: await globalThis.gale.tools.get(), other: await globalThis.gale.tools.get('default-workspace')
    }))
    assert.equal(isolated.global.tools.some(tool => tool.source === 'project'), false)
    assert.equal(isolated.other.tools.some(tool => tool.source === 'project'), false)
    for (const action of ['Cancel', 'Save']) {
      dialog = await openCapabilityProject(page, 'Capability fixture')
      const group = dialog.getByRole('region', { name: 'Custom tools', exact: true })
      await group.getByRole('button', { name: 'Custom tools', exact: true }).click()
      await group.getByRole('region', { name: extraToolRoot, exact: true }).getByRole('button', { name: 'Remove directory reference', exact: true }).click()
      await expect(group.getByRole('button', { name: 'Open tools folder', exact: true })).toHaveCount(1)
      await dialog.getByRole('button', { name: action, exact: true }).click()
      await expect(dialog).toHaveCount(0)
      assert.deepEqual((await savedDirectories()).tools, action === 'Cancel' ? [localToolRoot, extraToolRoot] : [localToolRoot])
      await access(extraToolRoot)
    }
    await page.evaluate(async projectId => {
      const api = globalThis.gale
      for (const id of ['alpha', 'beta']) await api.config.saveMcpServer({ id, name: id + ' MCP', enabled: false,
        type: 'stdio', command: 'unused-fixture', args: [], env: {}, timeoutMs: 30000 })
      const catalog = await api.skills.get(projectId)
      await api.skills.updateAvailability(projectId, catalog.skills.find(skill => skill.name === 'user-guide').id,
        { userAvailable: true, modelAvailable: false })
    }, projectId)
    await page.reload()
    dialog = await openCapabilityProject(page, 'Capability fixture')
    for (const name of ['File read', 'File write']) await dialog.locator('summary').filter({ hasText: name }).click()
    const lists = dialog.locator('.ui-capability-group .ui-capability-tools')
    for (const name of ['Custom tools', 'MCP', 'Subagents', 'Skills']) await dialog.getByRole('button', { name, exact: true }).click()
    const toolSection = dialog.getByRole('region', { name: 'Custom tools', exact: true })
    const skillsSection = dialog.getByRole('region', { name: 'Skills', exact: true })
    for (const section of [toolSection, skillsSection]) {
      await expect(section.locator('.ui-capability-resource-group [aria-expanded]')).toHaveCount(0)
    }
    await expect(dialog.getByRole('radiogroup', { name: 'MCP', exact: true })).toBeVisible()
    await expect(skillsSection.getByRole('radiogroup')).toHaveCount(1)
    const inactiveServer = dialog.getByRole('checkbox', { name: 'alpha MCP', exact: true })
    await expect(inactiveServer).toHaveAccessibleDescription('Disabled in global settings.')
    const serverLabel = dialog.getByRole('region', { name: 'MCP', exact: true }).locator('label').filter({ hasText: 'alpha MCP' })
    await expect(serverLabel.locator('.ui-checkbox-field-label')).toHaveText('alpha MCP')
    const colors = await serverLabel.locator('.ui-checkbox-field-label').evaluate(element => {
      const root = globalThis.document.documentElement, original = root.getAttribute('data-theme')
      const results = []
      const reference = globalThis.document.createElement('span')
      reference.style.color = 'var(--warning)'
      globalThis.document.body.append(reference)
      for (const theme of ['light', 'dark']) {
        root.setAttribute('data-theme', theme)
        const styles = globalThis.getComputedStyle(element)
        results.push({ color: styles.color, warning: globalThis.getComputedStyle(reference).color,
          font: styles.fontStyle, decoration: styles.textDecorationLine })
      }
      reference.remove()
      if (original === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', original)
      return results
    })
    assert.ok(colors.every(item => item.color === item.warning && item.font === 'normal' && item.decoration === 'none'))
    await serverLabel.scrollIntoViewIfNeeded()
    await serverLabel.locator('.ui-checkbox-field-label').hover()
    await expect(page.getByRole('tooltip')).toHaveText('Disabled in global settings.')
    await dialog.getByRole('button', { name: 'Save', exact: true }).hover()
    // The built-in disclosure panels share the resource list's left edge and padding.
    const resourceBox = await toolSection.locator('.ui-capability-list').boundingBox()
    for (const list of await lists.all()) {
      const box = await list.boundingBox()
      assert.ok(Math.abs(box.x - resourceBox.x) <= 1, 'Capability list left edges must align.')
    }
    const responsive = await lists.first().evaluate(element => {
      const original = element.getAttribute('style')
      const measurements = []
      for (const [width, font] of [[580, 14], [580, 20], [280, 20]]) {
        element.style.width = width + 'px'
        element.style.fontSize = font + 'px'
        const styles = globalThis.getComputedStyle(element)
        measurements.push({ width, font, actualWidth: element.clientWidth, minimum: styles.getPropertyValue('--ui-grid-min-width'), columns: new Set([...element.children].map(child => Math.round(child.getBoundingClientRect().left))).size,
          overflow: element.scrollWidth - element.clientWidth })
      }
      if (original === null) element.removeAttribute('style')
      else element.setAttribute('style', original)
      return measurements
    })
    console.log('Capability layout:', JSON.stringify(responsive))
    assert.ok(responsive[0].columns >= 3, 'A 580px list at 14px must fit at least three columns.')
    assert.equal(responsive[1].columns, 2, 'Larger fonts must retain a usable minimum column width.')
    assert.equal(responsive[2].columns, 1, 'Narrow lists must fall back to one column.')
    assert.ok(responsive.every(item => item.overflow <= 1), 'Responsive lists must not overflow horizontally.')
    const userSkillCheckbox = skillsSection.getByRole('checkbox', { name: 'user-guide', exact: true })
    const localSkillCheckbox = skillsSection.getByRole('checkbox', { name: 'local-guide', exact: true })
    await expect(userSkillCheckbox).toBeChecked()
    await expect(localSkillCheckbox).toBeChecked()
    await userSkillCheckbox.uncheck()
    await expect(localSkillCheckbox).toBeChecked()
    await userSkillCheckbox.check()
    await dialog.getByRole('checkbox', { name: 'alpha MCP', exact: true }).uncheck()
    await expect(dialog.getByRole('checkbox', { name: 'beta MCP', exact: true })).toBeChecked()
    const userTool = toolSection.getByRole('checkbox', { name: 'User json_format', exact: true })
    await userTool.uncheck()
    for (const name of ['Custom tools', 'MCP', 'Skills']) {
      const section = dialog.getByRole('region', { name, exact: true })
      const choices = await section.getByRole('checkbox').evaluateAll(items => items.map(item => item.checked))
      const modes = section.getByRole('radiogroup', { name, exact: true })
      for (const mode of ['All', 'Off', 'Custom']) {
        await modes.getByText(mode, { exact: true }).click()
        await expect(modes.getByRole('radio', { name: mode, exact: true })).toBeChecked()
      }
      assert.deepEqual(await section.getByRole('checkbox').evaluateAll(items => items.map(item => item.checked)), choices,
        name + ' must restore its custom choices after switching outer modes.')
      const mainAction = section.locator(':scope > .ui-form-row').getByRole('button', { name: /^(Select all|Deselect all)$/ })
      await expect(mainAction).toHaveCount(1)
      for (const checked of [!choices.every(Boolean), choices.every(Boolean)]) {
        await mainAction.click()
        assert.ok((await section.getByRole('checkbox').evaluateAll(items => items.map(item => item.checked))).every(value => value === checked))
        await expect(modes.getByRole('radio', { name: 'Custom', exact: true })).toBeChecked()
      }
      for (let index = 0; index < choices.length; index++) await section.getByRole('checkbox').nth(index).setChecked(choices[index])
    }
    const bulkActionHeights = await skillsSection.evaluate(section => {
      const root = globalThis.document.documentElement
      const original = root.style.getPropertyValue('--font-size-base')
      const results = []
      for (const fontSize of [10, 14, 18]) {
        root.style.setProperty('--font-size-base', fontSize + 'px')
        const actions = [...section.querySelectorAll('.ui-capability-group-actions')]
        const withActions = section.getBoundingClientRect().height
        const headingHeights = actions.map(action => action.parentElement.getBoundingClientRect().height)
        for (const action of actions) action.style.display = 'none'
        results.push({ fontSize, withActions, withoutActions: section.getBoundingClientRect().height,
          headingsStable: actions.every((action, index) => Math.abs(action.parentElement.getBoundingClientRect().height - headingHeights[index]) < 0.1) })
        for (const action of actions) action.style.removeProperty('display')
      }
      if (original) root.style.setProperty('--font-size-base', original)
      else root.style.removeProperty('--font-size-base')
      return results
    })
    assert.ok(bulkActionHeights.every(item => item.headingsStable && Math.abs(item.withActions - item.withoutActions) < 0.1),
      'Bulk action icons must not increase heading or section heights: ' + JSON.stringify(bulkActionHeights))
    const userSkills = skillsSection.getByRole('region', { name: 'User', exact: true })
    const groupActions = userSkills.locator('.ui-capability-group-actions')
    const selectGroup = userSkills.getByRole('button', { name: 'Select all', exact: true })
    const clearGroup = userSkills.getByRole('button', { name: 'Deselect all', exact: true })
    await dialog.getByRole('button', { name: 'Save', exact: true }).hover()
    await expect(groupActions).toHaveCSS('opacity', '1')
    await expect(clearGroup).toBeVisible()
    await clearGroup.click()
    await expect(userSkillCheckbox).not.toBeChecked()
    await expect(localSkillCheckbox).toBeChecked()
    await dialog.getByRole('button', { name: 'Save', exact: true }).hover()
    await expect(groupActions).toHaveCSS('opacity', '1')
    await userSkillCheckbox.focus()
    await page.keyboard.press('Shift+Tab')
    await expect(selectGroup).toBeFocused()
    await expect(groupActions).toHaveCSS('opacity', '1')
    await selectGroup.press('Enter')
    await expect(userSkillCheckbox).toBeChecked()
    await expect(groupActions.getByRole('button')).toHaveCount(1)
    assert.equal(await clearGroup.getAttribute('aria-pressed'), null)
    await userSkills.getByText('User', { exact: true }).click()
    await clearGroup.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Deselect all')
    await userSkills.getByText('User', { exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await dialog.screenshot({ path: join(__dirname, '../tmp/capability-group-actions.png') })
    await dialog.getByRole('checkbox', { name: 'Profile', exact: true }).uncheck()
    await dialog.screenshot({ path: join(__dirname, '../tmp/capability-checkboxes.png') })
    await toolSection.scrollIntoViewIfNeeded()
    await dialog.screenshot({ path: join(__dirname, '../tmp/capability-inner-groups.png') })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    const saved = await page.evaluate(async projectId => {
      const api = globalThis.gale, project = (await api.projects.list()).find(item => item.id === projectId)
      const settings = (await api.config.get()).settings
      const preview = await api.agent.context.previewModelRequest({ projectId, project, settings })
      const invoked = await api.skills.invoke(projectId, 'user-guide', 'user', 'Use this skill.')
      return { capabilities: project.capabilities, preview: preview.content, invoked: invoked.promptText }
    }, projectId)
    assert.equal(saved.capabilities.skills.entries.find(entry => entry.id.endsWith(':local-guide')).model, true)
    assert.equal(saved.capabilities.skills.entries.find(entry => entry.id.endsWith(':local-guide')).shortcut, true)
    assert.equal(saved.preview.includes('CAPABILITY_PROFILE_MARKER'), false)
    assert.equal(saved.preview.includes('User instructions.'), false)
    assert.ok(saved.preview.includes('Project-local instructions.'))
    assert.ok(saved.invoked.includes('User instructions.'))
    assert.deepEqual(saved.capabilities.mcp.servers.find(server => server.id === 'alpha'), { id: 'alpha', mode: 'off', tools: [] })
    dialog = await openCapabilityProject(page, 'Capability fixture')
    await dialog.getByRole('button', { name: 'MCP', exact: true }).click()
    await expect(dialog.getByRole('checkbox', { name: 'alpha MCP', exact: true })).not.toBeChecked()
    await dialog.getByRole('checkbox', { name: 'alpha MCP', exact: true }).check()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.deepEqual(await page.evaluate(async id => (await globalThis.gale.projects.list()).find(project => project.id === id).capabilities, projectId), saved.capabilities)
    // The subagent editor shares whole-item controls and the same checkbox layout.
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.locator('[data-settings-tab="subagents"]').click()
    await page.getByRole('button', { name: 'New subagent', exact: true }).click()
    const agentEditor = page.locator('.settings-subagent-editor')
    await agentEditor.getByRole('button', { name: 'Enable all', exact: true }).click()
    await agentEditor.getByRole('button', { name: 'MCP', exact: true }).click()
    await agentEditor.getByRole('checkbox', { name: 'alpha MCP', exact: true }).uncheck()
    await expect(agentEditor.getByRole('checkbox', { name: 'beta MCP', exact: true })).toBeChecked()
    await agentEditor.getByRole('button', { name: 'Skills', exact: true }).click()
    await expect(agentEditor.getByRole('checkbox', { name: 'user-guide', exact: true })).toBeChecked()
    await expect(agentEditor.getByRole('radiogroup', { name: 'Skills', exact: true })).toBeVisible()
    await agentEditor.screenshot({ path: join(__dirname, '../tmp/subagent-checkboxes.png') })
    await assert.rejects(access(join(home, 'config/capabilities.json')), { code: 'ENOENT' })
    console.log('Capabilities E2E passed: project-only references, save/cancel, checkboxes, aligned lists, global skill uses, whole MCP servers and subagent controls.')
  } finally {
    await application?.close()
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyCapabilities, openCapabilityProject }
