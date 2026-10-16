import { describe, expect, it } from 'vitest'
import { resolveModelListEndpoint } from './modelListEndpoint'
import { findModelTemplate, findModelTemplateIcon, getModelTemplate, modelTemplateTree, modelTemplates } from './modelTemplates'

describe('bundled model templates', () => {
  it('finds default artwork by API URL independent of the selected protocol', () => {
    const template = getModelTemplate('china/deepseek/anthropic')!
    expect(template).toBeDefined()
    expect(findModelTemplateIcon(` ${template.baseUrl}/// `)).toBe(template.iconData)
    expect(findModelTemplateIcon('https://unknown-provider.example/v1')).toBeUndefined()
    expect(findModelTemplateIcon('')).toBeUndefined()
    expect(findModelTemplateIcon('http://localhost:8080/v1')).toBe(getModelTemplate('local/llama-cpp/openai')?.iconData)
    expect(findModelTemplateIcon('http://localhost:8080')).toBe(getModelTemplate('local/llama-cpp/anthropic')?.iconData)
  })

  it('uses one brand icon across protocols and distinct artwork for each supported brand', () => {
    const icons = modelTemplates.map((template) => template.iconData).filter(Boolean)
    expect(new Set(icons).size).toBe(19)
    for (const country of modelTemplateTree) {
      if (country.type !== 'group') continue
      for (const brand of country.children) {
        if (brand.type !== 'group') continue
        const templates = modelTemplates.filter((template) => template.templateId.startsWith(`${country.id}/${brand.id}/`))
        expect(new Set(templates.map((template) => template.iconData)).size).toBe(1)
      }
    }
  })

  it('provides complete, uniquely identified connection presets', () => {
    expect(modelTemplateTree).toHaveLength(4)
    expect(modelTemplates).toHaveLength(33)
    expect(new Set(modelTemplates.map((template) => template.templateId)).size).toBe(33)
    expect(modelTemplates.every((template) => (
      template.name.trim().length > 0
      && template.label.trim().length > 0
      && template.baseUrl.trim().length > 0
      && template.modelListUrl.trim().length > 0
      && template.apiKey === ''
      && template.iconData?.startsWith('data:image/svg+xml;base64,')
      && typeof template.parameters === 'object'
    ))).toBe(true)
    expect(modelTemplates.some((template) => template.protocol === 'openai_responses')).toBe(false)
  })

  it('groups hosted services by country and keeps local servers separate', () => {
    expect(modelTemplateTree.map((node) => node.label)).toEqual([
      'Local',
      'China',
      'United States',
      'France'
    ])

    const unitedStates = modelTemplateTree.find((node) => node.id === 'united-states')
    expect(unitedStates).toMatchObject({ type: 'group', label: 'United States' })
    if (!unitedStates || unitedStates.type !== 'group') {
      throw new Error('Expected the United States template group.')
    }
    expect(unitedStates.children.map((node) => node.label)).toEqual([
      'OpenAI',
      'Anthropic',
      'Gemini',
      'xAI / Grok',
      'Groq',
      'OpenRouter',
      'Together AI'
    ])

    const france = modelTemplateTree.find((node) => node.id === 'france')
    expect(france).toMatchObject({ type: 'group', label: 'France' })
    if (!france || france.type !== 'group') throw new Error('Expected the France template group.')
    expect(france.children.map((node) => node.label)).toEqual(['Mistral'])

    const china = modelTemplateTree.find((node) => node.id === 'china')
    expect(china).toMatchObject({ type: 'group', label: 'China' })
    if (!china || china.type !== 'group') throw new Error('Expected the China template group.')
    expect(china.children.map((node) => node.label)).toEqual([
      'Qwen',
      'DeepSeek',
      'MiniMax',
      'VolcEngine',
      'Kimi',
      'GLM',
      'MIMO'
    ])
  })

  it.each([
    {
      templateId: 'united-states/openai',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.openai.com/v1',
      modelListUrl: 'https://api.openai.com/v1/models',
    },
    {
      templateId: 'united-states/anthropic/anthropic',
      protocol: 'anthropic_messages',
      baseUrl: 'https://api.anthropic.com',
      modelListUrl: 'https://api.anthropic.com/v1/models',
    },
    {
      templateId: 'united-states/anthropic/openai',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.anthropic.com/v1',
      modelListUrl: 'https://api.anthropic.com/v1/models',
    },
    {
      templateId: 'united-states/gemini',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      modelListUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    },
    {
      templateId: 'united-states/xai',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.x.ai/v1',
      modelListUrl: 'https://api.x.ai/v1/language-models',
    },
    {
      templateId: 'france/mistral',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.mistral.ai/v1',
      modelListUrl: 'https://api.mistral.ai/v1/models',
    },
    {
      templateId: 'united-states/groq',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelListUrl: 'https://api.groq.com/openai/v1/models',
    },
    {
      templateId: 'united-states/openrouter',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelListUrl: 'https://openrouter.ai/api/v1/models',
    },
    {
      templateId: 'united-states/together-ai',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.together.ai/v1',
      modelListUrl: 'https://api.together.ai/v1/models',
    }
  ])('provides the official $templateId connection endpoint', ({ templateId, ...expected }) => {
    expect(getModelTemplate(templateId)).toMatchObject(expected)
  })

  it('represents nested groups and templates with stable path IDs', () => {
    const china = modelTemplateTree.find((node) => node.id === 'china')
    if (!china || china.type !== 'group') throw new Error('Expected the China template group.')

    const qwen = china.children.find((node) => node.id === 'qwen')
    expect(qwen).toMatchObject({ type: 'group', label: 'Qwen' })
    if (!qwen || qwen.type !== 'group') throw new Error('Expected the Qwen template group.')

    const tokenPlan = qwen.children.find((node) => node.id === 'token-plan')
    expect(tokenPlan).toMatchObject({ type: 'group', label: 'TokenPlan' })
    if (!tokenPlan || tokenPlan.type !== 'group') throw new Error('Expected the TokenPlan template group.')

    expect(tokenPlan.children.map((node) => node.label)).toEqual([
      'OpenAI',
      'Anthropic Messages'
    ])
    expect(getModelTemplate('china/qwen/token-plan/openai')).toMatchObject({
      label: 'OpenAI',
      name: 'Qwen TokenPlan',
      protocol: 'openai_chat_completions'
    })
    expect(getModelTemplate('china/qwen/token-plan/anthropic')).toMatchObject({
      label: 'Anthropic Messages',
      name: 'Qwen TokenPlan',
      protocol: 'anthropic_messages'
    })
  })

  it('keeps menu labels separate from created model names', () => {
    expect(getModelTemplate('united-states/anthropic/anthropic')).toMatchObject({
      label: 'Anthropic Messages',
      name: 'Anthropic',
    })
    expect(getModelTemplate('china/qwen/openai')).toMatchObject({
      label: 'OpenAI',
      name: 'Qwen',
      protocol: 'openai_chat_completions'
    })
    expect(getModelTemplate('china/qwen/anthropic')).toMatchObject({
      label: 'Anthropic Messages',
      name: 'Qwen',
    })
  })

  it('configures provider-level parameters only for the MiniMax OpenAI protocol', () => {
    expect(modelTemplates.filter((template) => Object.keys(template.parameters).length > 0)
      .map((template) => template.templateId))
      .toEqual(['china/minimax/openai'])
    expect(getModelTemplate('china/minimax/openai')).toMatchObject({
      parameters: { reasoning_split: true }
    })
    expect(getModelTemplate('china/minimax/anthropic')).toMatchObject({
      parameters: {}
    })
  })

  it('groups local model servers under one nested menu', () => {
    const local = modelTemplateTree.find((node) => node.id === 'local')
    expect(local).toMatchObject({ type: 'group', label: 'Local' })
    if (!local || local.type !== 'group') throw new Error('Expected the Local template group.')

    expect(local.children.map((node) => node.label)).toEqual(['LM Studio', 'Ollama', 'LLaMA', 'vLLM'])
    expect(getModelTemplate('local/ollama/openai')).toMatchObject({
      name: 'Ollama',
      protocol: 'openai_chat_completions',
      baseUrl: 'http://localhost:11434/v1'
    })
    expect(getModelTemplate('local/llama-cpp/openai')).toMatchObject({
      name: 'LLaMA',
      protocol: 'openai_chat_completions',
      baseUrl: 'http://localhost:8080/v1'
    })
  })

  it('keeps local model list URLs dynamic while cloud templates stay explicit', () => {
    const localTemplates = modelTemplates.filter((template) => template.baseUrl.startsWith('http://localhost:'))
    const cloudTemplates = modelTemplates.filter((template) => !template.baseUrl.startsWith('http://localhost:'))

    expect(localTemplates).toHaveLength(8)
    expect(localTemplates.every((template) => template.modelListUrl === '{origin}/v1/models')).toBe(true)
    expect(localTemplates.every((template) => resolveModelListEndpoint(
      template.baseUrl.replace('localhost', '127.0.0.1'),
      template.modelListUrl
    ).startsWith('http://127.0.0.1:'))).toBe(true)
    expect(cloudTemplates.every((template) => template.modelListUrl.trim().length > 0)).toBe(true)
  })

  it('finds a template by protocol and normalized Base URL', () => {
    expect(findModelTemplate(
      'anthropic_messages',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/'
    )?.name).toBe('Qwen TokenPlan')
    expect(findModelTemplate('openai_chat_completions', 'https://custom.example.com/v1')).toBeUndefined()
  })
})
