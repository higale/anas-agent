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

async function verifyResourceDirectory(application, trigger, directory) {
  await application.evaluate(({ shell }) => {
    globalThis.capabilityDirectoryCheck = { opened: [], original: shell.openPath }
    shell.openPath = async path => { globalThis.capabilityDirectoryCheck.opened.push(path); return '' }
  })
  try {
    await trigger.click()
    await expect.poll(() => application.evaluate(() => globalThis.capabilityDirectoryCheck.opened)).toEqual([directory])
  } finally {
    await application.evaluate(({ shell }) => {
      shell.openPath = globalThis.capabilityDirectoryCheck.original
      delete globalThis.capabilityDirectoryCheck
    })
  }
}

async function verifyDisclosureHitArea(page, trigger) {
  await trigger.scrollIntoViewIfNeeded()
  const state = () => trigger.evaluate(element => element.tagName === 'SUMMARY'
    ? String(element.parentElement.open) : element.getAttribute('aria-expanded'))
  const before = await state()
  const point = await trigger.evaluate(element => {
    const box = element.getBoundingClientRect(), row = element.parentElement.getBoundingClientRect()
    const next = element.nextElementSibling?.getBoundingClientRect()
    const end = next?.height && next.top < box.bottom && next.bottom > box.top ? next.left : row.right
    return { x: (box.right + end) / 2, y: box.top + box.height / 2, gap: end - box.right }
  })
  assert.ok(point.gap > 20, `Disclosure should leave a non-clickable gap after its title: ${JSON.stringify(point)}`)
  await page.mouse.click(point.x, point.y)
  await expect.poll(state).toBe(before)
  await trigger.press('Enter')
  await expect.poll(state).not.toBe(before)
  await trigger.press('Space')
  await expect.poll(state).toBe(before)
}

async function verifySkillDivider(group, fullWidth) {
  const geometry = await group.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const line = globalThis.getComputedStyle(element, '::before')
    const list = element.closest('.ui-capability-list')
    return {
      left: rect.left + parseFloat(line.left), width: parseFloat(line.width), thickness: parseFloat(line.borderTopWidth),
      groupLeft: rect.left, groupWidth: rect.width,
      listLeft: list.getBoundingClientRect().left + list.clientLeft, listWidth: list.clientWidth,
      horizontalOverflow: list.scrollWidth - list.clientWidth,
      devicePixelRatio: globalThis.devicePixelRatio
    }
  })
  const expectedLeft = fullWidth ? geometry.listLeft : geometry.groupLeft
  const expectedWidth = fullWidth ? geometry.listWidth : geometry.groupWidth
  // Chromium snaps a 1 CSS px border to whole physical pixels.
  assert.ok(Math.abs(geometry.thickness - 1) < 1 / geometry.devicePixelRatio && geometry.thickness > 0)
  assert.ok(Math.abs(geometry.left - expectedLeft) < 1, `Divider start: ${JSON.stringify(geometry)}`)
  assert.ok(Math.abs(geometry.width - expectedWidth) < 1, `Divider width: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.horizontalOverflow <= 1, `Dividers must not cause horizontal scrolling: ${JSON.stringify(geometry)}`)
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
    let dialog = await openCapabilityProject(page, 'Capability fixture')
    const projectSkillSection = dialog.getByRole('region', { name: 'Skills', exact: true })
    const skillDisclosure = projectSkillSection.getByRole('button', { name: 'Skills', exact: true })
    await expect(projectSkillSection.getByRole('radio', { name: 'All', exact: true })).toBeChecked()
    await verifyDisclosureHitArea(page, skillDisclosure)
    await skillDisclosure.click()
    const projectGroup = projectSkillSection.getByRole('region', { name: 'Project skills', exact: true })
    const projectDisclosure = projectGroup.getByRole('button', { name: 'Project', exact: true })
    await expect(projectDisclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(projectSkillSection.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await expect(projectGroup.getByRole('checkbox')).toHaveCount(0)
    await expect(projectGroup.getByRole('button', { name: 'Add skill directories', exact: true })).toBeVisible()
    await verifyDisclosureHitArea(page, projectDisclosure)
    await verifyDisclosureHitArea(page, projectSkillSection.getByRole('button', { name: 'System', exact: true }))
    await verifySkillDivider(projectGroup, true)
    await verifySkillDivider(projectSkillSection.getByRole('region', { name: 'User', exact: true }), false)
    await mkdir(join(__dirname, '../tmp'), { recursive: true })
    await projectSkillSection.screenshot({ path: join(__dirname, '../tmp/skill-groups-collapsed.png') })
    await projectDisclosure.click()
    await expect(dialog.getByText('local-guide', { exact: true })).toHaveCount(1)
    await expect(projectGroup.getByRole('button', { name: 'Add skill directories', exact: true })).toBeVisible()
    const projectApproval = projectGroup.getByRole('checkbox', { name: 'local-guide Auto-approve', exact: true })
    await verifyResourceDirectory(application, projectGroup.getByRole('button', { name: 'local-guide', exact: true }), local)
    await expect(projectDisclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(projectApproval).not.toBeChecked()
    await expect(projectGroup.getByRole('checkbox', { name: 'local-guide Shortcut', exact: true })).toBeDisabled()
    await expect(projectGroup.getByRole('checkbox', { name: 'local-guide Model', exact: true })).toBeDisabled()
    await expect(projectApproval).toBeEnabled()
    const skillName = projectGroup.getByRole('button', { name: 'local-guide', exact: true }).locator('code')
    await projectApproval.locator('..').click()
    await expect(projectApproval).toBeChecked()
    const approvedNameColor = await skillName.evaluate(element => globalThis.getComputedStyle(element).color)
    const approvalMarkColor = await projectApproval.evaluate(element => globalThis.getComputedStyle(element).color)
    assert.equal(approvedNameColor, approvalMarkColor)
    assert.notEqual(approvedNameColor, await skillName.evaluate(element => globalThis.getComputedStyle(element.parentElement).color))
    await projectApproval.locator('..').click()
    await expect.poll(() => skillName.evaluate(element => globalThis.getComputedStyle(element).color === globalThis.getComputedStyle(element.parentElement).color)).toBe(true)
    await projectApproval.locator('..').click()
    await expect(projectSkillSection.getByRole('radio', { name: 'All', exact: true })).toBeChecked()
    const sourceOrder = await projectSkillSection.locator('.ui-capability-resource').allTextContents()
    assert.match(sourceOrder.at(-1), /local-guide/, 'Project skills must follow other skill sources.')
    await mkdir(join(__dirname, '../tmp'), { recursive: true })
    await projectGroup.screenshot({ path: join(__dirname, '../tmp/project-skills-merged.png') })
    await skillDisclosure.click()
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
      await verifyDisclosureHitArea(page, disclosure)
      await disclosure.click()
      if (name === 'Skills') await section.getByRole('button', { name: 'System', exact: true }).click()
      if (name === 'Custom tools') {
        const source = section.getByRole('button', { name: 'User', exact: true })
        await verifyDisclosureHitArea(page, source)
        await source.click()
      }
      if (name !== 'Skills') {
        const resource = await page.evaluate(async name => {
          const config = await globalThis.gale.config.get()
          return name === 'Subagents' ? config.subagents[0] : config.customTools[0]
        }, name)
        await verifyResourceDirectory(application, section.getByRole('button', { name: resource.name, exact: true }), resource.directory)
      }
      const first = name === 'Skills' ? section.getByRole('checkbox').first() : section.getByRole('radio', { name: 'On', exact: true }).first()
      await first.locator('..').click()
      await expect(first).toBeChecked()
      if (name === 'Skills') await expect(section.getByRole('searchbox')).toHaveCount(0)
      for (const mode of ['All', 'Off']) {
        await picker.getByText(mode, { exact: true }).click()
        if (name === 'Skills') {
          await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
          if (mode === 'All') await expect(first).toBeChecked()
          else await expect(first).not.toBeChecked()
          await expect(first).toBeDisabled()
          await expect(projectGroup.getByRole('checkbox', { name: 'local-guide Model', exact: true })).toBeDisabled()
          await expect(projectApproval).toBeChecked()
          await expect(projectApproval).toBeEnabled()
          await projectApproval.locator('..').click()
          await expect(projectApproval).not.toBeChecked()
          await projectApproval.locator('..').click()
          await expect(projectApproval).toBeChecked()
          await expect(projectGroup.getByRole('button', { name: 'Add skill directories', exact: true })).toBeVisible()
        } else {
          await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
          if (mode === 'All') await expect(first).toBeChecked()
          else await expect(first).not.toBeChecked()
          await expect(first).toBeDisabled()
        }
      }
      await picker.getByText('Custom', { exact: true }).click()
      await expect(first).toBeChecked()
      await expect(first).toBeEnabled()
    }
    await projectDisclosure.click()
    await expect(projectApproval).toHaveCount(0)
    await expect(projectSkillSection.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await projectDisclosure.click()
    await expect(projectApproval).toBeChecked()
    await dialog.getByRole('checkbox', { name: 'Profile', exact: true }).uncheck()
    await dialog.screenshot({ path: join(tmpdir(), 'anas-capabilities-project.png') })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const previews = await page.evaluate(async projectId => {
      const api = globalThis.gale, config = await api.config.get()
      const project = (await api.projects.list()).find(item => item.id === projectId)
      const custom = await api.agent.context.preview({ projectId, project, settings: config.settings })
      const defaults = (await api.projects.list()).find(item => item.id === 'default-workspace')
      const all = await api.agent.context.preview({ projectId, project: { ...project, capabilities: defaults.capabilities }, settings: config.settings })
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
    await expect(skills.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await skills.getByRole('button', { name: 'System', exact: true }).click()
    await skills.getByRole('button', { name: 'Project', exact: true }).click()
    await expect(skills.getByRole('checkbox').first()).toBeChecked()
    const savedApproval = skills.getByRole('checkbox', { name: 'local-guide Auto-approve', exact: true })
    await expect(savedApproval).toBeChecked()
    await savedApproval.locator('..').click()
    await expect(savedApproval).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    dialog = await openCapabilityProject(page, 'Capability fixture')
    await dialog.getByRole('button', { name: 'Skills', exact: true }).click()
    await dialog.getByRole('button', { name: 'Project', exact: true }).click()
    await expect(dialog.getByRole('checkbox', { name: 'local-guide Auto-approve', exact: true })).toBeChecked()
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
    await disabledSkills.getByRole('button', { name: 'System', exact: true }).click()
    const shortcut = disabledSkills.getByRole('checkbox', { name: `${globalSkill.name} Shortcut`, exact: true })
    const skillRow = disabledSkills.locator('.ui-capability-resource').filter({ has: page.getByRole('checkbox', { name: `${globalSkill.name} Shortcut`, exact: true }) })
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
    const secondWorkspace = join(home, 'workspace-two')
    const secondSkill = join(secondWorkspace, '.agents/skills/team-guide')
    await mkdir(secondSkill, { recursive: true })
    await writeFile(join(secondSkill, 'SKILL.md'), '---\nname: team-guide\ndescription: Team instructions.\n---\nUse team rules.\n')
    await cp(join(__dirname, '../data/examples/tools/json_format'), join(secondWorkspace, '.agents/tools/json_format'), { recursive: true })
    const projectRoots = await page.evaluate(async ({ projectId, secondWorkspace }) => {
      const api = globalThis.gale
      const project = (await api.projects.list()).find(item => item.id === projectId)
      const updated = await api.projects.update(projectId, { ...project, sourceFolders: [...project.sourceFolders, secondWorkspace] })
      if (updated.status !== 'ok') throw new Error(JSON.stringify(updated))
      return (await api.skills.get(projectId)).roots.filter(root => root.kind === 'project')
    }, { projectId, secondWorkspace })
    await page.reload()
    dialog = await openCapabilityProject(page, 'Capability fixture')
    const multiSkills = dialog.getByRole('region', { name: 'Skills', exact: true })
    await multiSkills.getByRole('button', { name: 'Skills', exact: true }).click()
    const multiProject = multiSkills.getByRole('region', { name: 'Project skills', exact: true })
    await multiProject.getByRole('button', { name: 'Project', exact: true }).click()
    assert.equal(projectRoots.length, 2)
    const secondGroup = multiProject.getByRole('region', { name: projectRoots[1].path, exact: true })
    await verifyDisclosureHitArea(page, secondGroup.getByRole('button', { name: projectRoots[1].name, exact: true }))
    await verifySkillDivider(multiProject, true)
    await verifySkillDivider(secondGroup, false)
    await multiSkills.screenshot({ path: join(__dirname, '../tmp/skill-group-dividers.png') })
    for (const root of projectRoots) await multiProject.getByRole('region', { name: root.path, exact: true }).getByRole('button', { name: root.name, exact: true }).click()
    await verifySkillDivider(multiProject, true)
    await verifySkillDivider(secondGroup, false)
    const multiTools = dialog.getByRole('region', { name: 'Custom tools', exact: true })
    await multiTools.getByRole('button', { name: 'Custom tools', exact: true }).click()
    const localTools = multiTools.getByRole('region', { name: 'Project tools', exact: true })
    const localToolsTitle = localTools.getByRole('button', { name: 'Project', exact: true })
    await verifyDisclosureHitArea(page, localToolsTitle)
    await localToolsTitle.click()
    await verifySkillDivider(localTools, true)
    await expect(dialog.getByRole('region', { name: 'Project tools', exact: true })).toHaveCount(1)
    await verifyResourceDirectory(application, localTools.getByRole('button', { name: 'json_format', exact: true }), join(secondWorkspace, '.agents/tools/json_format'))
    await page.mouse.move(0, 0)
    await multiTools.screenshot({ path: join(__dirname, '../tmp/capability-tool-controls.png') })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    const disabledTool = await page.evaluate(async () => {
      const api = globalThis.gale, config = await api.config.get(), tool = config.customTools[0]
      await api.tools.setEnabled(tool.id, false)
      return { id: tool.id, name: tool.name }
    })
    await page.reload()
    dialog = await openCapabilityProject(page, 'Capability fixture')
    const disabledTools = dialog.getByRole('region', { name: 'Custom tools', exact: true })
    const toolModes = disabledTools.getByRole('radiogroup', { name: 'Custom tools', exact: true })
    await toolModes.getByRole('radio', { name: 'All', exact: true }).locator('..').click()
    await disabledTools.getByRole('button', { name: 'Custom tools', exact: true }).click()
    await disabledTools.getByRole('button', { name: 'User', exact: true }).click()
    const disabledRow = disabledTools.locator('.ui-capability-resource').filter({ has: page.getByRole('button', { name: disabledTool.name, exact: true }) })
    await expect(disabledRow.getByRole('radio', { name: 'On', exact: true })).toBeChecked()
    await expect(disabledRow.getByRole('radio', { name: 'On', exact: true })).toBeDisabled()
    await expect(disabledRow.getByText('Inactive', { exact: true })).toBeVisible()
    await toolModes.getByRole('radio', { name: 'Off', exact: true }).locator('..').click()
    await expect(disabledRow.getByRole('radio', { name: 'Off', exact: true })).toBeChecked()
    await toolModes.getByRole('radio', { name: 'Custom', exact: true }).locator('..').click()
    await expect(disabledRow.getByRole('radio', { name: 'On', exact: true })).toBeChecked()
    assert.equal(await page.evaluate(async id => (await globalThis.gale.tools.get()).tools.find(tool => tool.id === id).enabled, disabledTool.id), false)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    // A disabled source exercises retained selections without starting an MCP process.
    const retainedMcp = { defaultMode: 'selected', servers: [{ id: 'mcp-fixture', mode: 'selected', tools: ['saved_search'] }] }
    await page.evaluate(async ({ projectId, mcp }) => {
      const api = globalThis.gale
      await api.config.saveMcpServer({ id: 'mcp-fixture', name: 'Fixture MCP', enabled: false, type: 'stdio', command: 'unused-mcp-fixture', args: [], env: {}, timeoutMs: 30000 })
      const project = (await api.projects.list()).find(item => item.id === projectId)
      const result = await api.projects.update(projectId, { ...project, capabilities: { ...project.capabilities, mcp } })
      if (result.status !== 'ok') throw new Error(JSON.stringify(result))
    }, { projectId, mcp: retainedMcp })
    await page.reload()
    dialog = await openCapabilityProject(page, 'Capability fixture')
    const mcpGroup = dialog.getByRole('region', { name: 'MCP', exact: true })
    const mcpTitle = mcpGroup.getByRole('button', { name: 'MCP', exact: true })
    const mcpModes = mcpGroup.getByRole('radiogroup', { name: 'MCP', exact: true })
    await expect(mcpTitle).toHaveAttribute('aria-expanded', 'false')
    await verifyDisclosureHitArea(page, mcpTitle)
    await mcpTitle.click()
    const mcpSource = mcpGroup.getByRole('region', { name: 'Fixture MCP', exact: true })
    await mcpSource.getByRole('button', { name: 'Fixture MCP', exact: true }).click()
    const savedTool = mcpSource.getByRole('checkbox', { name: 'Fixture MCP saved_search', exact: true })
    await expect(savedTool).toBeChecked()
    await expect(savedTool).toBeEnabled()
    for (const mode of ['All', 'Off']) {
      await mcpModes.getByText(mode, { exact: true }).click()
      await expect(savedTool).toBeChecked({ checked: mode === 'All' })
      await expect(savedTool).toBeDisabled()
      await expect(mcpSource.getByRole('radio', { name: 'Custom', exact: true })).toBeDisabled()
    }
    await mcpModes.getByText('Custom', { exact: true }).click()
    await expect(savedTool).toBeChecked()
    await expect(savedTool).toBeEnabled()
    await mcpTitle.click()
    await expect(savedTool).not.toBeVisible()
    await mcpTitle.click()
    await expect(savedTool).toBeChecked()
    await mcpGroup.screenshot({ path: join(tmpdir(), 'anas-mcp-group-capabilities.png') })
    await mcpModes.getByText('Off', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    assert.deepEqual(await page.evaluate(async id => (await globalThis.gale.projects.list()).find(project => project.id === id).capabilities.mcp, projectId), { ...retainedMcp, mode: 'off' })
    dialog = await openCapabilityProject(page, 'Capability fixture')
    await dialog.getByRole('button', { name: 'MCP', exact: true }).click()
    await expect(dialog.getByRole('radiogroup', { name: 'MCP', exact: true }).getByRole('radio', { name: 'Off', exact: true })).toBeChecked()
    await dialog.getByRole('radiogroup', { name: 'MCP', exact: true }).getByText('Custom', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Fixture MCP', exact: true }).click()
    await expect(dialog.getByRole('checkbox', { name: 'Fixture MCP saved_search', exact: true })).toBeChecked()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await assert.rejects(access(join(home, 'config/capabilities.json')), { code: 'ENOENT' })
    console.log('Capabilities E2E passed: resource On/Off controls; skill/tool/Agent directory targets; merged project tools; compact title hit areas; blank row clicks preserve disclosure state; Enter/Space toggle; directory actions; dividers; independent disclosures; mode switches; project approval save/cancel; retained choices; global restrictions; prompt projection.')
  } finally {
    await application?.close()
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyCapabilities, openCapabilityProject }
