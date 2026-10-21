import capabilities from '../../../data/config/capabilities.json'
import { allCapabilities, capabilityFeatures, defaultCapabilities, serializeCapabilities, parseCapabilities } from '@shared/agentCapabilities'
import settings from '../../../data/config/settings.json'
import mcpServers from '../../../data/config/mcp_servers.json'
import models from '../../../data/config/models.json'
import subagents from '../../../data/config/subagents.json'
import { beforeAll, describe, expect, it } from 'vitest'
import { defaultModelConfig, defaultModelProviderConfig } from '@shared/modelConfig'
import { modelTemplates, modelTemplateTree } from '@shared/modelTemplates'
import { defaultSubagentConfig } from '@shared/subagentConfig'
import { normalizeAppConfigSnapshot } from './appConfig'
import type { RawAppConfig, RawSubagentConfig } from './rawAppConfig'
import { readSubagentPackage, readSubagentPackages } from '../subagentPackages'
import { join } from 'node:path'
let bundledAgents: RawSubagentConfig[]
beforeAll(async () => { bundledAgents = await readSubagentPackages(join(process.cwd(), 'data')) })

describe('bundled configuration contract', () => {
  it('strictly maps every bundled model, subagent, setting, and enum', () => {
    const snapshot = normalizeAppConfigSnapshot({
      settings,
      capabilities,
      providers: models.providers,
      subagents: bundledAgents,
      mcp_servers: mcpServers.mcp_servers
    } as RawAppConfig)

    expect(snapshot.providers).toHaveLength(models.providers.length)
    expect(snapshot.subagents).toHaveLength(bundledAgents.length)
    expect(snapshot.defaultModel).toBeUndefined()
    expect(snapshot.settings.sidebarCollapsedSections).toEqual({
      projects: false,
      simpleChats: false
    })
    expect(snapshot.settings.sidebarWidth).toBe(260)
    expect(snapshot.settings.environmentContext.customInformationEnabled).toBe(settings.environment_context.custom_information_enabled)
  })

  it('keeps the new-model defaults separate from every concrete model entry', () => {
    expect(defaultModelProviderConfig).toMatchObject({
      parameters: models.provider_defaults.parameters
    })
    expect(defaultModelConfig).toMatchObject({
      maxContextTokens: models.model_defaults.max_context_tokens,
      maxOutputTokens: models.model_defaults.max_output_tokens
    })
    expect(models.providers).toEqual([])
    expect(modelTemplateTree.map((node) => node.label)).toEqual([
      'Local',
      'China',
      'United States',
      'France'
    ])
    expect(modelTemplates.every((provider) => (
      provider.protocol !== undefined
      && provider.baseUrl.length > 0
      && provider.modelListUrl.length > 0
    ))).toBe(true)
  })

  it('ships only general-purpose as a built-in with every capability and the parent model', () => {
    expect(bundledAgents.map(agent => agent.id)).toEqual(['general-purpose'])
    const general = bundledAgents.find((subagent) => subagent.preset === 'general-purpose')
    expect(parseCapabilities(general?.capabilities)).toEqual(allCapabilities)
    expect(general?.model_config_id).toBeUndefined()
    expect(general?.model_parameter_preset_id).toBeUndefined()
  })

  it('gives the example web researcher shell, file reading, and network tools without delegation or planning', async () => {
    const researcher = await readSubagentPackage(join(process.cwd(), 'data/examples/subagents/web-researcher'))
    expect(researcher.preset).toBeUndefined()
    expect(parseCapabilities(researcher?.capabilities)).toMatchObject({
      workspace: false,
      memory: false,
      subagents: { mode: 'off' as const, names: [] },
      planning: false,
      toolMode: 'selected',
      tools: ['run_shell', 'read_file', 'http_request']
    })
  })

  it('adds shell and network tools alongside the example project analyst file tools', async () => {
    const analyst = await readSubagentPackage(join(process.cwd(), 'data/examples/subagents/project-analyst'))
    expect(analyst.preset).toBeUndefined()
    expect(analyst).toMatchObject({
 capabilities: serializeCapabilities({ ...structuredClone(defaultCapabilities), profile: false, toolMode: 'selected', tools: [
        'read_file',
        'read_multiple_files',
        'list_directory',
        'directory_tree',
        'get_file_info',
        'run_shell',
        'http_request'
      ], mcp: { defaultMode: 'selected', servers: [] }, skills: { mode: 'custom', project: false, entries: [] } }),
    })
  })

  it('starts custom subagents disabled with every capability off', () => {
    expect(defaultSubagentConfig.enabled).toBe(false)
    expect(Object.values(capabilityFeatures(defaultSubagentConfig.capabilities)).every(enabled => !enabled)).toBe(true)
    expect(defaultSubagentConfig.capabilities).toMatchObject({
      subagents: { mode: 'off' }, skills: { mode: 'off' }, customTools: { mode: 'off' }, pluginMode: 'off'
    })
    expect(defaultSubagentConfig).toEqual({
 capabilities: parseCapabilities(subagents.subagent_defaults.capabilities),
      enabled: subagents.subagent_defaults.enabled,
    })
  })
})
