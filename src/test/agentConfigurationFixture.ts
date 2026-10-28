import type { AgentThread } from '../shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID, type AppConfigSnapshot, type ModelProviderConfigDetail, type Project } from '../shared/types'
import { resolveProviderModelConfig } from '../shared/modelConfig'
import { defaultCapabilities } from '../shared/agentCapabilities'
import { environmentContextFixture } from './environmentContextFixture'
import { diffViewSettingsFixture } from './diffViewSettingsFixture'

export function config(settings: Partial<AppConfigSnapshot['settings']> = {}): AppConfigSnapshot {
  return { customTools: [],
    providers: [],
    subagents: [{
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true,
        memory: true, toolMode: 'all', tools: [], skills: { mode: 'default', project: false, entries: [] } },
      index: 0,
      name: 'general-purpose',
      enabled: true,
      preset: 'general-purpose',
      builtIn: true,
      description: 'Handle complex delegated tasks.',
      systemPrompt: 'Complete the delegated task.',
    }],
    mcpServers: [],
    settings: {
      profile: {
        assistant: {
          name: 'Ananas',
          role: 'AI assistant',
          instructions: 'Be clear and useful.',
          newAvatarPath: ''
        },
        user: {
          preferredName: '',
          personalInfo: ''
        }
      },
      speechReply: {
        enabled: false,
        voice: '',
        speed: 1
      },
      language: 'en',
      theme: 'dark',
      fontSize: 14,
      chatContentWidth: 'narrow',
      attachmentTextMaxChars: 1000,
      attachmentTextOverflow: 'truncate',
      logLevel: 'info',
      logRetentionDays: 14,
      maxModelCallsPerRun: 0,
      environmentContext: environmentContextFixture(),
      sidebarVisible: true,
      sidebarWidth: 260,
      workspacePanelWidth: 480, ...diffViewSettingsFixture,
      sidebarCollapsedSections: {
        projects: false,
        simpleChats: false
      },
      backupDir: '',
      ...settings
    }
  }
}

export function thread(projectId = DEFAULT_WORKSPACE_PROJECT_ID): AgentThread {
  return {
    id: 'thread-1',
    title: 'Thread',
    projectId,
    pinned: false,
    accessMode: 'read_only_allowed',
    status: 'idle',
    userTurnCount: 0,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  }
}

export function defaultWorkspaceProject(): Project {
  return {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
    id: DEFAULT_WORKSPACE_PROJECT_ID,
    name: 'Default Workspace',
    kind: 'workspace',
    pinned: false,
    collapsed: false,
    sourceFolders: ['/workspace/default'],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  }
}

export function previewProvider(): ModelProviderConfigDetail {
  return {
    index: 0,
    id: 'preview-provider',
    name: 'Preview model',
    protocol: 'openai_chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    modelListUrl: '',
    apiKey: 'test',
    parameters: {},
    models: [{
      index: 0,
      id: 'preview-model',
      displayName: '',
      model: 'preview-model',
      parameters: {},
      parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true },
      stream: false,
      maxContextTokens: 100_000,
      maxOutputTokens: 4_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: false
    }]
  }
}

export function previewConfig(toolUse = true): AppConfigSnapshot {
  const base = previewProvider()
  const provider: ModelProviderConfigDetail = {
    ...base,
    models: [{
      ...base.models[0],
      capabilities: { ...base.models[0].capabilities, toolUse }
    }]
  }
  const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
  return {
    ...config(),
    providers: [provider],
    defaultModelId: defaultModel.id,
    defaultModel
  }
}
