import { updateMemoryToolSpec } from '../../runtime/preferenceMemoryTool'
import { defineContentTool } from '../../runtime/toolDefinition'
import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AgentThread } from '@shared/agentTypes'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import { type AppConfigSnapshot, type AppSettings, type Project, type ResolvedModelConfig } from '@shared/types'
import { assertResolvedCapabilities, capabilityFeatures, defaultCapabilities, intersectCapabilities, mcpToolAllowed, resolvePluginCapabilities, resolveSkillSelection, toolAllowed, type AgentCapabilities, type ResolvedAgentCapabilities, type RunConfiguration } from '@shared/agentCapabilities'
import { builtinToolCatalog, enabledBuiltinFileToolNames, sortToolDefinitions } from '@shared/toolRegistry'
import { customToolCapabilityIssue } from '@shared/customTools'
import { resolveToolSelection } from '@shared/toolPackages'
import { defaultSubagentSelection, selectedSubagents } from '@shared/subagentSelection'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import { ModelSelectionError } from '../../runtime/errors'
import { processEnvironment } from '../config/apiKeys'
import { resolvePluginTools, buildPluginPrompts, pluginRuntime } from '../plugins/pluginRuntime'
import { listToolSnapshot, listSubagentTools } from '../toolsStore'
import { bundledSearchEnvironment } from '../bundledRipgrep'
import { createShellCommandAuthorization } from '../shellCommandAuthorization'
import { fileToolDefinitions } from '../llm/fileTools'
import { runtimeToolDefinitions } from '../llm/runtimeTools'
import { getCachedMcpRuntime, getLoadedMcpRuntime } from '../mcpRuntimeService'
import { resolveConfiguredLanguage } from '../languageStore'
import { getProject } from '../projectStore'
import { resolveProjectSourceFolders } from '../projectWorkspace'
import { describeCommandShell, getCommandShell, prepareShellCommand, resultText, runShellCommand, type ShellRunResult } from '../shellRuntime'
import { buildSkillsPrompt, listSkillSnapshot, listSubagentSkills, type SkillAgentScope } from '../skillsStore'
import type { AgentSubagentCallRecord } from './subagentTaskStore'
import type { ConversationResourceAccess } from './conversationResourceReader'
import { currentToolExecution } from './toolExecutionContext'
import { verifyCurrentShellAuthorization } from './toolAuthorizationRuntime'
import { createAgentModelResolver, resolveModelSelection, resolveThreadModelSelection } from './modelSelection'
import { pluginToolDefinitions } from './pluginToolRuntime'
import { customToolDefinitions } from './customToolRuntime'
import { subagentToolDefinitions, type SubagentToolOptions, type SubagentToolRuntime } from './subagentTools'
import { buildAgentSystemPrompt, type AgentSystemPrompt } from './systemPrompt'
import { modelSystemGuidance } from './modelGuidance'
import { configuredServerTools } from './serverTools'
import { buildSubagentSystemPrompt } from './subagentPrompt'
import { isDeveloperHttpTraceEnabled } from './developerHttpTraceState'
import { buildMemoryRulesPrompt } from './conversationMemory'
import type { ManagedCallService } from './managedCallService'
import { applicationApprovalDirectories, safeApprovalFolders } from './approvalDirectories'
import { smartApprovalPrompt, supportsApprovalParameter } from '../../runtime/smartApproval'

export interface AgentResourceContext {
  writeMemory?(scope: 'global' | 'project', content: string, signal?: AbortSignal): Promise<void>
  requestId?: string
  configuration?: RunConfiguration
  parentConfiguration?: RunConfiguration
  onConfigurationResolved?(value: RunConfiguration): void
  signal?: AbortSignal
  managedCalls?: Pick<ManagedCallService, 'read' | 'readOutput' | 'readResult' | 'wait' | 'cancel' | 'start' | 'cancelRun' | 'unresolvedForThread' | 'resolveObservedCall'>
  subagents?: SubagentToolRuntime
  subagentCall?: AgentSubagentCallRecord
}

export interface AgentResourceOptions {
  project?: Project
  persistent: boolean
  prepareWorkspace: boolean
  contextPreview?: boolean
  review?: CodeReviewSnapshot
  requestSubagentApproval: SubagentToolOptions['requestApproval']
}

export interface WorkspaceContext {
  trustedFolders: string[]
  primaryFolder: string
  description: string
}

export function createAgentAccessModeResolver(
  database: Pick<ConversationResourceAccess, 'getThread'>,
  threadId: string,
  subagentCall?: Pick<AgentSubagentCallRecord, 'ownerThreadId'>
): () => AgentThread['accessMode'] {
  const accessModeOwnerId = subagentCall?.ownerThreadId ?? threadId
  return () => database.getThread(accessModeOwnerId)?.accessMode ?? 'smart_approval'
}

export function shouldIncludeCommandShell(
  platform: NodeJS.Platform,
  settings: AppSettings,
  features: ReturnType<typeof capabilityFeatures> = capabilityFeatures(defaultCapabilities)
): boolean {
  return platform !== 'win32' && features.environment && features.commandExecution && settings.environmentContext.operatingSystem
}

function workspaceContext(project: Project, workspaceFolders: string[]): WorkspaceContext {
  const description = [
    '<workspace_context>',
    `The active project is "${project.name}".`,
    '',
    'Project folders (absolute host paths):',
    ...workspaceFolders.map((folder, index) =>
      `- ${index === 0 ? 'Primary/default' : 'Additional'} folder "${basename(folder)}": \`${folder}\``
    ),
    '',
    'Path rules:',
    '1. Built-in tool file paths accept absolute paths and paths relative to the primary/default folder.',
    '2. Resolve every relative path from the primary/default folder shown above.',
    '3. In a multi-folder project, relative paths refer only to the primary/default folder; use an absolute path for an additional folder.',
    '4. Listed project folders can be read and written directly. Other host paths, including the app data directory, may require user approval.',
    '5. Shell commands run in the primary/default folder unless working_dir is supplied; a relative working_dir also resolves from that folder.',
    '</workspace_context>'
  ].join('\n')
  return {
    trustedFolders: workspaceFolders,
    primaryFolder: workspaceFolders[0],
    description
  }
}

const foregroundRules = '<memory>Use update_memory for durable user preferences, corrections and requests to forget. Preserve unrelated entries and scope. Do not use configuration or general file tools. Confirm a change only after the tool succeeds.</memory>'
const readOnlyRules = '<memory>Apply saved preferences. Memory writing is unavailable in this request. Do not use configuration or file tools to persist preferences.</memory>'

async function memoryPrompt(enabled: boolean, foreground: boolean): Promise<string> {
  if (!enabled) return ''
  if (foreground) return foregroundRules
  const rules = await buildMemoryRulesPrompt()
  return [
    '<memory>',
    rules,
    '</memory>'
  ].join('\n')
}

export async function prepareAgentSystemPrompt(
  thread: AgentThread,
  config: AppConfigSnapshot,
  capabilities?: AgentCapabilities,
  codingMode?: boolean,
  toolsEnabled = true,
  projectDraft?: Project,
  agent: SkillAgentScope = { kind: 'main' }
): Promise<{
  workspace: WorkspaceContext
  systemPrompt: ReturnType<typeof buildAgentSystemPrompt>
}> {
  const project = projectDraft ?? await getProject(thread.projectId)
  const effective = capabilities ?? resolvePluginCapabilities(project.capabilities, await pluginRuntime().store.list(), agent.kind === 'subagent')
  const features = capabilityFeatures(effective)
  const workspace = workspaceContext(project, await resolveProjectSourceFolders(project, config.settings))
  const [memory, skills, commandShell, pluginPrompts] = await Promise.all([
    memoryPrompt(features.memory, config.settings.memoryMode === 'foreground'),
    features.skills ? buildSkillsPrompt({ agent, projectId: project.id, selection: effective.skills,
      pluginTools: effective.pluginTools, skillDirectories: project.skillDirectories ?? [] }) : Promise.resolve(''),
    shouldIncludeCommandShell(process.platform, config.settings, features)
      ? getCommandShell().then(describeCommandShell)
      : Promise.resolve(undefined),
    toolsEnabled ? buildPluginPrompts(effective.pluginPrompts, effective.pluginTools, agent.kind) : Promise.resolve('')
  ])
  return {
    workspace,
    systemPrompt: buildAgentSystemPrompt(config, {
      workspace: features.workspaceContext ? workspace.description : '',
      memory,
      skills,
      pluginPrompts,
      projectPrompt: project.prompt,
      codingMode: codingMode ?? project.codingMode,
      toolsEnabled,
      commandShell
    }, features)
  }
}

async function loadMcpTools(config: AppConfigSnapshot, capabilities: AgentCapabilities, preview = false): Promise<ToolDefinition[]> {
  if (
    !capabilityFeatures(capabilities).mcp
    || !config.mcpServers.some((server) => server.enabled)
  ) return []
  const runtime = preview ? getLoadedMcpRuntime() : await getCachedMcpRuntime()
  const names = config.mcpServers.filter((server) => server.enabled).flatMap((server) =>
    runtime.loaded.filter((loaded) => loaded.id === server.id).flatMap((loaded) =>
      loaded.toolNames.filter((name) => mcpToolAllowed(capabilities, server.id, name))))
  const selected = new Set(names)
  return sortToolDefinitions(runtime.tools.filter((tool) => selected.has(tool.name)), tool => tool.name, names)
}

/** Resolve the existing product configuration and native capabilities once.
 * Execution/approval protocols and message persistence belong to the caller. */
export async function prepareAgentRuntimeResources(thread: AgentThread, database: ConversationResourceAccess, config: AppConfigSnapshot,
  context: AgentResourceContext, options: AgentResourceOptions) {
  const boundSelection = options.persistent || options.contextPreview
  const memoryModes = new WeakMap<ResolvedModelConfig, AppSettings['memoryMode']>()
  const foregroundFor = (model: ResolvedModelConfig) => (memoryModes.get(model) ?? config.settings.memoryMode) === 'foreground'
  const resolveModel = boundSelection
    ? createAgentModelResolver(thread.id, database, { onResolved: (model, snapshot) => memoryModes.set(model, snapshot.settings?.memoryMode ?? 'background') })
    : async () => resolveModelSelection(thread, config, { allowDefault: true })
  const initialModel = resolveModelSelection(
    boundSelection ? resolveThreadModelSelection(thread.id, database) : thread,
    config, { allowDefault: !boundSelection }
  )
  const developerHttpTrace = isDeveloperHttpTraceEnabled()

  const activeSubagent = context.subagentCall?.config
  let runConfiguration = context.configuration
  if (!runConfiguration) {
    const project = options.project ?? await getProject(thread.projectId)
    const ownCapabilities = resolvePluginCapabilities(activeSubagent ? activeSubagent.capabilities : project.capabilities, await pluginRuntime().store.list(), Boolean(activeSubagent))
    const parentLimit = activeSubagent ? context.parentConfiguration?.subagentLimit : undefined
    const skillsEnabled = capabilityFeatures(ownCapabilities).skills && (!parentLimit || capabilityFeatures(parentLimit).skills)
    const globalCatalog = skillsEnabled
      ? await listSkillSnapshot(thread.projectId, project.skillDirectories ?? [])
      : { skills: [] }
    const globalToolCatalog = await listToolSnapshot(project.toolDirectories ?? [])
    const packageIds = activeSubagent?.id ? [activeSubagent.id] : []
    const ownedSkills = skillsEnabled ? await listSubagentSkills(packageIds) : { skills: [] }
    const ownedTools = ownCapabilities.customTools.mode !== 'off' && (!parentLimit || parentLimit.customTools.entries.length)
      ? await listSubagentTools(packageIds) : []
    const catalog = { skills: [...ownedSkills.skills, ...globalCatalog.skills] }
    const toolCatalog = { tools: [...ownedTools, ...globalToolCatalog.tools] }
    const resolve = (value: AgentCapabilities, skills = catalog.skills, tools = toolCatalog.tools, child = Boolean(activeSubagent), unique = false): ResolvedAgentCapabilities => ({ ...value, pluginMode: 'custom',
      subagents: { mode: value.subagents.mode === 'off' ? 'off' : 'custom', names: selectedSubagents(config.subagents, value.subagents).map((subagent) => subagent.name) },
      customTools: resolveToolSelection(value.customTools, tools.filter(tool => !customToolCapabilityIssue(tool.definition, value.backgroundTools)), child, false),
      skills: resolveSkillSelection(value.skills, skills, unique, child, value.pluginTools) })
    let capabilities = resolve(ownCapabilities)
    if (activeSubagent && parentLimit) {
      assertResolvedCapabilities(parentLimit)
      capabilities = intersectCapabilities(capabilities, parentLimit)
    }
    // Apply the root ceiling before resolving duplicate names, so an excluded
    // project override cannot hide an allowed tool from another source.
    capabilities = { ...capabilities, skills: resolveSkillSelection(capabilities.skills, catalog.skills, true, false, capabilities.pluginTools), customTools: resolveToolSelection(capabilities.customTools,
      toolCatalog.tools.filter(tool => !customToolCapabilityIssue(tool.definition, capabilities.backgroundTools))) }
    const rootSelection = activeSubagent
      ? context.parentConfiguration?.subagentSelectionLimit ?? context.parentConfiguration?.capabilities.subagents ?? defaultSubagentSelection
      : capabilities.subagents
    const rootSubagents = selectedSubagents(config.subagents, rootSelection)
    capabilities = { ...capabilities, subagents: { ...capabilities.subagents,
      names: selectedSubagents(rootSubagents, capabilities.subagents).map((subagent) => subagent.name) } }
    let subagentLimit = activeSubagent ? parentLimit : project.restrictSubagents ? capabilities : undefined
    if (!activeSubagent && subagentLimit) {
      const ids = rootSubagents.flatMap(a => a.id ? [a.id] : [])
      const resources = skillsEnabled ? await listSubagentSkills(ids) : { skills: [] }
      const tools = ownCapabilities.customTools.mode !== 'off' ? await listSubagentTools(ids) : []
      // These are grants to descendants only, never tools or Skills exposed to the main agent.
      subagentLimit = resolve(ownCapabilities, [...catalog.skills, ...resources.skills], [...toolCatalog.tools, ...tools], false, false)
    }
    runConfiguration = {
      customTools: structuredClone(toolCatalog.tools.filter(tool => capabilities.customTools.entries.includes(tool.id)).map(tool => tool.definition!)),
      ...(activeSubagent ? { subagentSelectionLimit: structuredClone(rootSelection) } : {}),
      ...(!activeSubagent && project.compressionPrompt
        ? { compressionPrompt: project.compressionPrompt } : {}),
      codingMode: activeSubagent
        ? context.parentConfiguration?.codingMode === true
        : project.codingMode,
      capabilities,
      ...(subagentLimit ? { subagentLimit } : {})
    }
    context.onConfigurationResolved?.(runConfiguration)
  }
  const capabilities = runConfiguration.capabilities
  const features = capabilityFeatures(capabilities)
  const skillAgent: SkillAgentScope = activeSubagent ? { kind: 'subagent', id: activeSubagent.id } : { kind: 'main' }
  const { workspace, systemPrompt: rootSystemPrompt } = await prepareAgentSystemPrompt(
    thread, config, capabilities, !activeSubagent && runConfiguration.codingMode, true, options.project, skillAgent
  )
  const review = options.review
  if (review && !initialModel.capabilities.toolUse) throw new ModelSelectionError('Code review requires an agent project and a model with tool use enabled.')
  const hasUnresolvedManagedCalls = (options.persistent || options.contextPreview)
    && database.hasUnresolvedManagedCallsForThread(thread.id)
  if (hasUnresolvedManagedCalls && !initialModel.capabilities.toolUse) {
    throw new ModelSelectionError(
      'This conversation has unresolved background calls. Continue it in an agent project with a model that supports tool use so those calls can be supervised.'
    )
  }
  if (hasUnresolvedManagedCalls && options.persistent && !context.managedCalls) {
    throw new Error('Background call supervision is unavailable for this conversation.')
  }
  const hasUnresolvedSubagents = Boolean(
    context.requestId
    && database.listUnresolvedSubagentCallsForRun(context.requestId, 1).length > 0
  )
  if (hasUnresolvedSubagents && (!initialModel.capabilities.toolUse || !features.subagents)) {
    throw new ModelSelectionError(
      'This conversation has unresolved background subagents. Re-enable subagents and continue it with a model that supports tool use so they can be supervised.'
    )
  }
  const availableSubagents = features.subagents
    ? selectedSubagents(config.subagents, capabilities.subagents)
    : []
  // Resolved selections apply only to new launches. A running child owns the
  // immutable definition captured when it was created, so config edits cannot
  // change or strand a recoverable execution.
  const [mcpTools, outputLanguage] = await Promise.all([
    loadMcpTools(config, capabilities, options.contextPreview),
    resolveConfiguredLanguage(config.settings.language)
  ])
  const commandShell = features.commandExecution
    ? await getCommandShell()
    : undefined
  const baseEnvironment = processEnvironment(capabilities.applicationEnvironment)
  const shellEnvironment = commandShell && !options.contextPreview
    ? await bundledSearchEnvironment(baseEnvironment)
    : undefined
  const shellCommandAuthorization = commandShell && shellEnvironment ? createShellCommandAuthorization({
    shell: commandShell, env: shellEnvironment.env, rgExecutable: shellEnvironment.executable,
    primaryFolder: workspace.primaryFolder, trustedFolders: workspace.trustedFolders,
    accessMode: createAgentAccessModeResolver(database, thread.id, context.subagentCall), signal: context.signal
  }) : undefined
  const approvalDirectories = applicationApprovalDirectories()
  const accessMode = () => database.getThread(context.subagentCall?.ownerThreadId ?? thread.id)?.accessMode ?? thread.accessMode
  const activeToolNames = capabilities.toolMode !== 'all'
    ? [...builtinToolCatalog.filter((tool) => toolAllowed(capabilities, tool.id)).map((tool) => tool.id), ...mcpTools.map((tool) => tool.name)]
    : undefined
  const activeMcpTools = mcpTools
  const canWriteMemory = features.memory && !activeSubagent && !review
  const offersMemoryWrite = (model: ResolvedModelConfig) => canWriteMemory && model.capabilities.toolUse && foregroundFor(model)
  const backgroundRules = features.memory
    ? (config.settings.memoryMode === 'foreground' ? await memoryPrompt(true, false) : rootSystemPrompt.sections.find(section => section.kind === 'memory')?.content)
    : undefined
  const systemPrompt = activeSubagent
    ? {
        ...rootSystemPrompt,
        text: buildSubagentSystemPrompt(activeSubagent, rootSystemPrompt)
      }
    : rootSystemPrompt
  if (options.prepareWorkspace) {
    await Promise.all([...new Set([workspace.primaryFolder, ...workspace.trustedFolders])]
      .map((folder) => mkdir(folder, { recursive: true })))
  }
  const shellRunner = async (input: {
    command: string
    summary?: string
    timeoutSec?: number
    workingDir?: string
    pty?: import('@shared/terminal').TerminalSize
  }): Promise<string> => {
    const prepared = await prepareShellCommand(input, workspace.primaryFolder)
    if ('ok' in prepared) return resultText(prepared)
    prepared.env = shellEnvironment?.env
    prepared.pathPrepend = shellEnvironment?.directory
    if (!commandShell) return resultText({
      ok: false,
      command: prepared.command,
      workingDir: prepared.workingDir,
      timeoutSec: prepared.timeoutSec,
      stdout: '',
      stderr: '',
      error: 'Command shell is unavailable.'
    })
    const control = currentToolExecution()
    await verifyCurrentShellAuthorization()
    let completed: ShellRunResult | undefined
    const result = await runShellCommand(prepared, commandShell, control?.signal ?? context.signal, {
      onDispatched: control?.markRunning,
      onOutcomeUncertain: control?.markUncertain,
      onOutput: control?.output,
      onTerminal: control?.setTerminal,
      onProcesses: snapshot => control?.setOutcome({ process_snapshot: snapshot, command: prepared.command }),
      onResult: (result) => {
        completed = result
        control?.setOutcome({
          ok: result.ok,
          ...(result.process_snapshot ? { process_snapshot: result.process_snapshot } : {}),
          ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
          ...(result.signal === undefined ? {} : { signal: result.signal }),
          ...(result.timedOut === undefined ? {} : { timed_out: result.timedOut }),
          ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
          ...(result.error === undefined ? {} : { error: result.error })
        })
      }
    })
    return completed ? resultText(completed, control?.callId) : result
  }
  const runtimeTools = await runtimeToolDefinitions({
    enabled: true,
    primaryFolder: workspace.primaryFolder,
    configuration: features.configuration,

    projectId: thread.projectId,
    threadId: thread.id,
    runId: context.requestId,
    userInputSource: async () => {
      const ownerThreadId = context.subagentCall?.ownerThreadId ?? thread.id
      const owner = database.getThread(ownerThreadId)
      if (!owner) throw new Error(`User input conversation ${ownerThreadId} was not found.`)
      const project = await getProject(owner.projectId)
      return { projectName: project.name, threadTitle: owner.title,
        ...(context.subagentCall ? { agentName: context.subagentCall.agentName } : {}) }
    },
    network: features.networkAccess,
    shell: features.commandExecution,
    commandShell,
    mcp: features.mcp && activeMcpTools.length > 0,
    signal: context.signal,
    mcpTools: activeMcpTools,
    toolNames: activeToolNames,
    shellRunner,
    managedCalls: context.managedCalls,
    backgroundTools: capabilities.backgroundTools,
    interactiveCustomTools: runConfiguration.customTools.some((tool) => tool.interactive),
    managedCallSupervision: hasUnresolvedManagedCalls
  })
  const fileTools = fileToolDefinitions({
    maxReadBytes: async () => (await resolveModel()).maxContextTokens,
    toolNames: enabledBuiltinFileToolNames(features, activeToolNames),
    signal: context.signal,
    fileChanges: database.fileChanges,
    fileEditStore: database.fileEditStore,
    requestId: context.requestId,
    primaryFolder: workspace.primaryFolder
  })
  const subagentTools = features.subagents
    ? subagentToolDefinitions({
        requestApproval: options.requestSubagentApproval,
        runtime: context.subagents,
        subagents: availableSubagents,
        signal: context.signal,
        includeStartForRecovery: Boolean(
          context.requestId
          && database.listSubagentCallsForParentRun(context.requestId).length > 0
        )
      })
    : []
  const customTools = customToolDefinitions(runConfiguration.customTools, {
    env: baseEnvironment,
    backgroundTools: capabilities.backgroundTools,
    signal: context.signal, preview: !options.persistent
  })
  if (canWriteMemory) {
    runtimeTools.push(defineContentTool({
      ...updateMemoryToolSpec,
      async execute({ scope, content }, { signal }) {
        if (!context.writeMemory) throw new Error('Memory updates require an active conversation.')
        await context.writeMemory(scope, content, signal)
        return 'Memory saved.'
      }
    }))
  }
  const pluginDefinitions = await resolvePluginTools(capabilities.pluginTools)
  const pluginTools = pluginToolDefinitions(pluginDefinitions, {
    preview: !options.persistent
  })
  const requestSystemPrompt = (model: ResolvedModelConfig): AgentSystemPrompt => {
    const rules = foregroundFor(model) ? (offersMemoryWrite(model) ? foregroundRules : readOnlyRules) : backgroundRules
    let prompt = systemPrompt
    if (rules && rootSystemPrompt.sections.some(section => section.kind === 'memory' && section.content !== rules)) {
      const sections = rootSystemPrompt.sections.map(section => section.kind === 'memory' ? { ...section, content: rules } : section)
      prompt = { sections, text: sections.map(section => section.content).join('\n\n') }
      if (activeSubagent) prompt.text = buildSubagentSystemPrompt(activeSubagent, prompt)
    }
    const provider = model.protocol === 'anthropic_messages' ? 'anthropic' : 'openai'
    const suffix = [modelSystemGuidance(provider, model.model),
      model.capabilities.toolUse && accessMode() === 'smart_approval'
        ? smartApprovalPrompt(safeApprovalFolders(workspace.trustedFolders, accessMode(), approvalDirectories)) : ''
    ].filter(Boolean).join('\n\n')
    return suffix ? {
      text: [prompt.text, suffix].filter(Boolean).join('\n\n'),
      sections: [...prompt.sections, { kind: 'system_instruction', content: suffix }]
    } : prompt
  }
  function selectModelTools<T extends { name: string }>(model: ResolvedModelConfig, tools: readonly T[]): Array<T | Record<string, unknown>> {
    try {
      const serverTools = configuredServerTools(model)
      if (!model.capabilities.toolUse) return []
      return [...tools.filter(tool => tool.name !== 'update_memory' || offersMemoryWrite(model)).filter(tool => model.capabilities.vision || !['view_image', 'view_multiple_images'].includes(tool.name))
        .map(tool => accessMode() === 'smart_approval' && supportsApprovalParameter(tool)
          ? { ...tool, metadata: { ...('metadata' in tool ? tool.metadata as Record<string, unknown> : {}), smartApproval: true } } : tool), ...serverTools]
    } catch (cause) {
      throw new ModelSelectionError(`The selected model has invalid tool parameters: ${cause instanceof Error ? cause.message : String(cause)}. Correct its settings and send again.`, { cause })
    }
  }
  async function refreshMcpTools(): Promise<void> {
    const previous = new Set(activeMcpTools.map(tool => tool.name))
    const current = await loadMcpTools(config, capabilities, true)
    runtimeTools.splice(0, runtimeTools.length, ...runtimeTools.filter(tool => !previous.has(tool.name)), ...current)
    activeMcpTools.splice(0, activeMcpTools.length, ...current)
  }

  return { refreshMcpTools, resolveModel, initialModel, offersMemoryWrite, developerHttpTrace, activeSubagent, runConfiguration, capabilities, features, requestSystemPrompt, selectModelTools,
    workspace, approvalDirectories, systemPrompt, review, hasUnresolvedManagedCalls,
    commandShell, shellCommandAuthorization, activeMcpTools, runtimeTools, fileTools, subagentTools, customTools, pluginTools, outputLanguage }
}
