import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AgentThread } from '@shared/agentTypes'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import { DEFAULT_WORKSPACE_PROJECT_ID, type AppConfigSnapshot, type AppSettings, type Project, type WorkspaceProject, type ResolvedModelConfig } from '@shared/types'
import { assertResolvedCapabilities, capabilityFeatures, defaultCapabilities, effectiveProjectCapabilities, effectiveProjectCapabilitySettings, intersectCapabilities, mcpToolAllowed, resolvePluginCapabilities, resolveSkillSelection, toolAllowed, type AgentCapabilities, type ResolvedAgentCapabilities, type RunConfiguration } from '@shared/agentCapabilities'
import { builtinToolCatalog, enabledBuiltinFileToolNames, sortToolDefinitions } from '@shared/toolRegistry'
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
import { describeCommandShell, getCommandShell, prepareShellCommand, resultText, runShellCommand } from '../shellRuntime'
import { buildSkillsPrompt, listSkillSnapshot, listSubagentSkills } from '../skillsStore'
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

export interface AgentResourceContext {
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
  return () => database.getThread(accessModeOwnerId)?.accessMode ?? 'read_only_allowed'
}

export function shouldIncludeCommandShell(
  platform: NodeJS.Platform,
  settings: AppSettings,
  features: ReturnType<typeof capabilityFeatures> = capabilityFeatures(defaultCapabilities)
): boolean {
  if (!features.environment) return false
  return platform === 'win32'
    ? settings.environmentContext.powerShell
    : features.commandExecution && settings.environmentContext.operatingSystem
}

function workspaceContext(project: WorkspaceProject): WorkspaceContext {
  const workspaceFolders = project.sourceFolders
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

async function memoryPrompt(enabled: boolean): Promise<string> {
  if (!enabled) return ''
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
  agent: 'main' | 'subagent' = 'main'
): Promise<{
  workspace: WorkspaceContext
  systemPrompt: ReturnType<typeof buildAgentSystemPrompt>
  simpleChatPrompt?: string
}> {
  const project = projectDraft ?? await getProject(thread.projectId)
  const effective = capabilities ?? resolvePluginCapabilities(project.kind === 'workspace' ? effectiveProjectCapabilities(project) : defaultCapabilities, await pluginRuntime().store.list(), agent === 'subagent')
  const features = capabilityFeatures(effective)
  if (project.kind === 'simple_chat') {
    const defaultWorkspace = await getProject(DEFAULT_WORKSPACE_PROJECT_ID)
    if (defaultWorkspace.kind !== 'workspace') throw new Error('The default workspace project is invalid.')
    const workspace = workspaceContext(defaultWorkspace)
    return {
      workspace,
      systemPrompt: buildAgentSystemPrompt(config, {
        workspace: '',
        memory: '',
        skills: '',
        simpleChatPrompt: project.prompt
      }, features),
      simpleChatPrompt: project.prompt
    }
  }
  if (project.sourceFolders.length === 0) throw new Error(`Project ${project.id} has no source folders.`)
  const workspace = workspaceContext(project)
  const [memory, skills, commandShell, pluginPrompts] = await Promise.all([
    memoryPrompt(features.memory),
    features.skills ? buildSkillsPrompt(project.id, effective.skills, project.sourceFolders, effective.pluginTools) : Promise.resolve(''),
    shouldIncludeCommandShell(process.platform, config.settings, features)
      ? getCommandShell().then(describeCommandShell)
      : Promise.resolve(undefined),
    toolsEnabled ? buildPluginPrompts(effective.pluginPrompts, effective.pluginTools, agent) : Promise.resolve('')
  ])
  return {
    workspace,
    systemPrompt: buildAgentSystemPrompt(config, {
      workspace: features.workspaceContext ? workspace.description : '',
      memory,
      skills,
      pluginPrompts,
      projectPrompt: project.advancedSettings ? project.prompt : '',
      codingMode: codingMode ?? project.codingMode,
      toolsEnabled,
      commandShell
    }, features)
  }
}

async function loadMcpTools(config: AppConfigSnapshot, simpleChat: boolean, capabilities: AgentCapabilities, preview = false): Promise<ToolDefinition[]> {
  if (
    simpleChat
    || !capabilityFeatures(capabilities).mcp
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
  const resolveModel = boundSelection
    ? createAgentModelResolver(thread.id, database)
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
    const projectPolicy = project.kind === 'workspace' ? effectiveProjectCapabilitySettings(project) : undefined
    const ownCapabilities = resolvePluginCapabilities(activeSubagent ? activeSubagent.capabilities : projectPolicy?.capabilities ?? defaultCapabilities, await pluginRuntime().store.list(), Boolean(activeSubagent))
    const parentLimit = activeSubagent ? context.parentConfiguration?.subagentLimit : undefined
    const skillsEnabled = project.kind === 'workspace' && capabilityFeatures(ownCapabilities).skills && (!parentLimit || capabilityFeatures(parentLimit).skills)
    const globalCatalog = skillsEnabled
      ? await listSkillSnapshot(thread.projectId, project.sourceFolders)
      : { skills: [] }
    const globalToolCatalog = project.kind === 'workspace' ? await listToolSnapshot(project.sourceFolders) : { tools: [] }
    const packageIds = activeSubagent?.id ? [activeSubagent.id] : []
    const ownedSkills = skillsEnabled ? await listSubagentSkills(packageIds) : { skills: [] }
    const ownedTools = project.kind === 'workspace' && ownCapabilities.customTools.mode !== 'off' && (!parentLimit || parentLimit.customTools.entries.length)
      ? await listSubagentTools(packageIds) : []
    const catalog = { skills: [...ownedSkills.skills, ...globalCatalog.skills] }
    const toolCatalog = { tools: [...ownedTools, ...globalToolCatalog.tools] }
    const resolve = (value: AgentCapabilities, skills = catalog.skills, tools = toolCatalog.tools, child = Boolean(activeSubagent), unique = false): ResolvedAgentCapabilities => ({ ...value, pluginMode: 'custom',
      subagents: { mode: value.subagents.mode === 'off' ? 'off' : 'custom', names: selectedSubagents(config.subagents, value.subagents).map((subagent) => subagent.name) },
      customTools: resolveToolSelection(value.customTools, tools.filter(tool => !tool.definition?.interactive || value.backgroundTools), child, false),
      skills: resolveSkillSelection(value.skills, skills, unique, child, value.pluginTools) })
    let capabilities = resolve(ownCapabilities)
    if (activeSubagent && parentLimit) {
      assertResolvedCapabilities(parentLimit)
      capabilities = intersectCapabilities(capabilities, parentLimit)
    }
    // Apply the root ceiling before resolving duplicate names, so an excluded
    // project override cannot hide an allowed tool from another source.
    capabilities = { ...capabilities, skills: resolveSkillSelection(capabilities.skills, catalog.skills, true, false, capabilities.pluginTools), customTools: resolveToolSelection(capabilities.customTools,
      toolCatalog.tools.filter(tool => !tool.definition?.interactive || capabilities.backgroundTools)) }
    const rootSelection = activeSubagent
      ? context.parentConfiguration?.subagentSelectionLimit ?? context.parentConfiguration?.capabilities.subagents ?? defaultSubagentSelection
      : capabilities.subagents
    const rootSubagents = selectedSubagents(config.subagents, rootSelection)
    capabilities = { ...capabilities, subagents: { ...capabilities.subagents,
      names: selectedSubagents(rootSubagents, capabilities.subagents).map((subagent) => subagent.name) } }
    let subagentLimit = activeSubagent ? parentLimit : projectPolicy?.restrictSubagents ? capabilities : undefined
    if (!activeSubagent && subagentLimit) {
      const ids = rootSubagents.flatMap(a => a.id ? [a.id] : [])
      const resources = skillsEnabled ? await listSubagentSkills(ids) : { skills: [] }
      const tools = ownCapabilities.customTools.mode !== 'off' ? await listSubagentTools(ids) : []
      // These are grants to descendants only, never tools or Skills exposed to the main agent.
      subagentLimit = resolve(ownCapabilities, [...catalog.skills, ...resources.skills], [...toolCatalog.tools, ...tools], false, false)
    }
    runConfiguration = {
      customTools: structuredClone(project.kind === 'workspace'
        ? toolCatalog.tools.filter(tool => capabilities.customTools.entries.includes(tool.id)).map(tool => tool.definition!) : []),
      ...(activeSubagent ? { subagentSelectionLimit: structuredClone(rootSelection) } : {}),
      ...(project.kind === 'workspace' && project.advancedSettings && !activeSubagent && project.compressionPrompt
        ? { compressionPrompt: project.compressionPrompt } : {}),
      codingMode: activeSubagent
        ? context.parentConfiguration?.codingMode === true
        : project.kind === 'workspace' && project.codingMode,
      capabilities,
      ...(subagentLimit ? { subagentLimit } : {})
    }
    context.onConfigurationResolved?.(runConfiguration)
  }
  const capabilities = runConfiguration.capabilities
  const features = capabilityFeatures(capabilities)
  const { workspace, systemPrompt: rootSystemPrompt, simpleChatPrompt } = await prepareAgentSystemPrompt(
    thread, config, capabilities, !activeSubagent && runConfiguration.codingMode, true, options.project, activeSubagent ? 'subagent' : 'main'
  )
  const simpleChat = simpleChatPrompt !== undefined
  const toolsEnabled = !simpleChat
  const review = options.review
  if (review && (!toolsEnabled || !initialModel.capabilities.toolUse)) throw new ModelSelectionError('Code review requires an agent project and a model with tool use enabled.')
  const hasUnresolvedManagedCalls = (options.persistent || options.contextPreview)
    && database.hasUnresolvedManagedCallsForThread(thread.id)
  if (hasUnresolvedManagedCalls && (!toolsEnabled || !initialModel.capabilities.toolUse)) {
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
  if (hasUnresolvedSubagents && (!toolsEnabled || !initialModel.capabilities.toolUse || !features.subagents)) {
    throw new ModelSelectionError(
      'This conversation has unresolved background subagents. Re-enable subagents and continue it with a model that supports tool use so they can be supervised.'
    )
  }
  const availableSubagents = toolsEnabled && features.subagents
    ? selectedSubagents(config.subagents, capabilities.subagents)
    : []
  // Resolved selections apply only to new launches. A running child owns the
  // immutable definition captured when it was created, so config edits cannot
  // change or strand a recoverable execution.
  const [mcpTools, outputLanguage] = await Promise.all([
    loadMcpTools(config, simpleChat, capabilities, options.contextPreview),
    resolveConfiguredLanguage(config.settings.language)
  ])
  const commandShell = toolsEnabled && features.commandExecution
    ? await getCommandShell()
    : undefined
  const shellEnvironment = commandShell && !options.contextPreview
    ? await bundledSearchEnvironment(processEnvironment(capabilities.applicationEnvironment))
    : undefined
  const shellCommandAuthorization = commandShell && shellEnvironment ? createShellCommandAuthorization({
    shell: commandShell, env: shellEnvironment.env, rgExecutable: shellEnvironment.executable,
    primaryFolder: workspace.primaryFolder, trustedFolders: workspace.trustedFolders,
    skills: { projectId: thread.projectId, sourceFolders: options.project?.kind === 'workspace' ? options.project.sourceFolders : undefined,
      selection: capabilities.skills, allowUserInvocation: !activeSubagent, pluginTools: capabilities.pluginTools },
    accessMode: createAgentAccessModeResolver(database, thread.id, context.subagentCall), signal: context.signal
  }) : undefined
  const activeToolNames = capabilities.toolMode !== 'all'
    ? [...builtinToolCatalog.filter((tool) => toolAllowed(capabilities, tool.id)).map((tool) => tool.id), ...mcpTools.map((tool) => tool.name)]
    : undefined
  const activeMcpTools = mcpTools
  const systemPrompt = activeSubagent
    ? {
        ...rootSystemPrompt,
        text: buildSubagentSystemPrompt(activeSubagent, rootSystemPrompt)
      }
    : rootSystemPrompt
  if (options.prepareWorkspace && !simpleChat) {
    await Promise.all([...new Set([workspace.primaryFolder, ...workspace.trustedFolders])]
      .map((folder) => mkdir(folder, { recursive: true })))
  }
  const shellRunner = async (input: {
    command: string
    summary?: string
    timeoutSec?: number
    workingDir?: string
    keepProcesses?: boolean
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
    return runShellCommand(prepared, commandShell, control?.signal ?? context.signal, {
      onDispatched: control?.markRunning,
      onOutcomeUncertain: control?.markUncertain,
      onOutput: control?.output,
      onTerminal: control?.setTerminal,
      onResult: (result) => control?.setOutcome({
        ok: result.ok,
        ...(result.detached ? { local_commit_completed: true, detached: result.detached } : {}),
        ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        ...(result.timedOut === undefined ? {} : { timed_out: result.timedOut }),
        ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
        ...(result.error === undefined ? {} : { error: result.error })
      })
    })
  }
  const runtimeTools = await runtimeToolDefinitions({
    enabled: toolsEnabled,
    primaryFolder: workspace.primaryFolder,
    configuration: toolsEnabled && features.configuration,
    memory: toolsEnabled && ['read_memory', 'save_to_memory', 'forget_memory'].some((id) => toolAllowed(capabilities, id)),
    memoryStore: database.memoryStore,
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
    network: toolsEnabled && features.networkAccess,
    shell: toolsEnabled && features.commandExecution,
    commandShell,
    mcp: toolsEnabled && features.mcp && activeMcpTools.length > 0,
    signal: context.signal,
    mcpTools: activeMcpTools,
    toolNames: activeToolNames,
    shellRunner,
    managedCalls: context.managedCalls,
    backgroundTools: capabilities.backgroundTools,
    interactiveCustomTools: runConfiguration.customTools.some((tool) => tool.interactive),
    managedCallSupervision: hasUnresolvedManagedCalls
  })
  const fileTools = toolsEnabled
    ? fileToolDefinitions({
        maxReadBytes: async () => (await resolveModel()).maxContextTokens,
        toolNames: enabledBuiltinFileToolNames(features, activeToolNames),
        signal: context.signal,
        fileChanges: database.fileChanges,
        fileEditStore: database.fileEditStore,
        requestId: context.requestId,
        primaryFolder: workspace.primaryFolder
      })
    : []
  const subagentTools = toolsEnabled && features.subagents
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
  const customTools = toolsEnabled ? customToolDefinitions(runConfiguration.customTools, {
    env: processEnvironment(capabilities.applicationEnvironment),
    backgroundTools: capabilities.backgroundTools,
    signal: context.signal, preview: !options.persistent
  }) : []
  const pluginDefinitions = toolsEnabled ? await resolvePluginTools(capabilities.pluginTools) : []
  const pluginTools = toolsEnabled ? pluginToolDefinitions(pluginDefinitions, {
    preview: !options.persistent
  }) : []
  const requestSystemPrompt = (model: ResolvedModelConfig): AgentSystemPrompt => {
    const provider = model.protocol === 'anthropic_messages' ? 'anthropic' : 'openai'
    const suffix = simpleChat ? undefined : modelSystemGuidance(provider, model.model)
    return suffix ? {
      text: [systemPrompt.text, suffix].filter(Boolean).join('\n\n'),
      sections: [...systemPrompt.sections, { kind: 'system_instruction', content: suffix }]
    } : systemPrompt
  }
  function selectModelTools<T extends { name: string }>(model: ResolvedModelConfig, tools: readonly T[]): Array<T | Record<string, unknown>> {
    try {
      const serverTools = configuredServerTools(model)
      if (!toolsEnabled || !model.capabilities.toolUse) return []
      return [...tools.filter(tool => model.capabilities.vision || !['view_image', 'view_multiple_images'].includes(tool.name)), ...serverTools]
    } catch (cause) {
      throw new ModelSelectionError(`The selected model has invalid tool parameters: ${cause instanceof Error ? cause.message : String(cause)}. Correct its settings and send again.`, { cause })
    }
  }
  return { resolveModel, initialModel, developerHttpTrace, activeSubagent, runConfiguration, capabilities, features, requestSystemPrompt, selectModelTools,
    workspace, systemPrompt, simpleChatPrompt, simpleChat, toolsEnabled, review, hasUnresolvedManagedCalls,
    commandShell, shellCommandAuthorization, activeMcpTools, runtimeTools, fileTools, subagentTools, customTools, pluginTools, outputLanguage }
}
