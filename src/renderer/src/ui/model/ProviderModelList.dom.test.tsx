import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ModelProviderConfigDetail } from '@shared/types'
import { ProviderModelList } from './ProviderModelList'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const modelDefaults = {
  displayName: '',
  parameters: {},
  parameterPresetMode: 'none',
  capabilities: { vision: false, toolUse: true },
  stream: true,
  maxContextTokens: 128_000,
  maxOutputTokens: 16_000,
  contextCompressionThreshold: 0.8,
  contextCompressionEnabled: true
}

const provider = {
  id: 'provider-1',
  index: 0,
  name: 'Provider',
  protocol: 'openai_chat_completions',
  baseUrl: 'https://example.com/v1',
  modelListUrl: '{base_url}/models',
  parameters: {},
  models: [
    {
      ...modelDefaults,
      id: 'model-1',
      index: 0,
      displayName: 'Friendly model',
      model: 'first-model',
      parameterPresetMode: 'custom',
      parameterPresets: [{ id: 'thinking', name: 'Thinking', parameters: {} }],
      capabilities: { vision: true, toolUse: true }
    },
    { ...modelDefaults, id: 'model-2', index: 1, model: 'second-model', parameterPresetMode: 'protocol_default' }
  ]
} satisfies ModelProviderConfigDetail

describe('provider model list selection', () => {
  it('renders an empty provider without creating a placeholder model', () => {
    render(
      <ProviderModelList
        provider={{ ...provider, models: [] }}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onMove={vi.fn()}
        onModelListSettingsChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByText('settings.no_models_configured')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.add_provider_model' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'settings.delete_model' })).toBeDisabled()
  })

  it('shows model limits and capability indicators alongside list actions', () => {
    render(
      <ProviderModelList
        provider={provider}
        selectedIndex={0}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onMove={vi.fn()}
        onModelListSettingsChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    const firstModel = screen.getByRole('option', { name: /^Friendly model/ })
    const secondModel = screen.getByRole('option', { name: /^second-model/ })
    expect(firstModel).toHaveAttribute('aria-selected', 'true')
    expect(secondModel).toHaveAttribute('aria-selected', 'false')
    expect(firstModel).toHaveTextContent('128K · 16K · 80%')
    expect(secondModel).toHaveTextContent('128K · 16K · 80%')
    expect(within(firstModel).getByLabelText('settings.model_capability_vision: common.on')).toBeVisible()
    expect(within(firstModel).getByLabelText('settings.model_capability_tool_use: common.on')).toBeVisible()
    expect(within(firstModel).getByLabelText('settings.model_parameter_presets: settings.enabled')).toBeVisible()
    expect(within(secondModel).queryByLabelText('settings.model_capability_vision: common.on')).not.toBeInTheDocument()
    expect(within(secondModel).getByLabelText('settings.model_parameter_presets: settings.enabled')).toBeVisible()
    expect(within(firstModel).queryByLabelText('chat.model_non_streaming')).not.toBeInTheDocument()
    const firstEdit = screen.getByRole('button', { name: 'settings.edit_model: Friendly model' })
    const secondEdit = screen.getByRole('button', { name: 'settings.edit_model: second-model' })
    expect(firstEdit).toHaveClass('ui-list-item-action', 'ui-tool-button')
    expect(firstEdit.parentElement).toHaveClass('ui-list-item-action-wrap')
    expect(firstEdit.closest('.provider-model-item')).toHaveClass('ui-list-item-action-host')
    expect(firstEdit.closest('.provider-model-item')).not.toHaveClass('thread-item')
    expect(secondEdit).toHaveClass('ui-list-item-action', 'ui-tool-button')
    expect(secondEdit.parentElement).toHaveClass('ui-list-item-action-wrap')
    expect(secondEdit.closest('.provider-model-item')).toHaveClass('ui-list-item-action-host')
    expect(document.querySelector('.provider-model-option-editor')).not.toBeInTheDocument()
  })

  it('updates the displayed limits and indicators when a model is saved', () => {
    const props = { onAdd: vi.fn(), onDelete: vi.fn(), onEdit: vi.fn(), onMove: vi.fn(),
      onModelListSettingsChange: vi.fn(), onSelect: vi.fn() }
    const { rerender } = render(<ProviderModelList {...props} provider={provider} />)
    const updated = { ...provider, models: provider.models.map(model => ({ ...model,
      maxContextTokens: 256000, maxOutputTokens: 0, contextCompressionEnabled: false, stream: false,
      capabilities: { vision: false, toolUse: false }, parameterPresetMode: 'none' as const
    })) }
    rerender(<ProviderModelList {...props} provider={updated} />)
    const item = screen.getByRole('option', { name: 'Friendly model' })
    expect(item).toHaveTextContent('256K · — · —')
    expect(within(item).getByLabelText('chat.model_non_streaming')).toBeVisible()
    expect(within(item).queryByLabelText('settings.model_capability_vision: common.on')).not.toBeInTheDocument()
    expect(within(item).queryByLabelText('settings.model_capability_tool_use: common.on')).not.toBeInTheDocument()
    expect(within(item).queryByLabelText('settings.model_parameter_presets: settings.enabled')).not.toBeInTheDocument()
  })

  it('edits the model list URL from the model list heading', async () => {
    const user = userEvent.setup()
    const onModelListSettingsChange = vi.fn()
    render(
      <ProviderModelList
        provider={provider}
        selectedIndex={0}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onMove={vi.fn()}
        onModelListSettingsChange={onModelListSettingsChange}
        onSelect={vi.fn()}
      />
    )

    const heading = screen.getByText('settings.provider_models').closest('.provider-model-list-heading') as HTMLElement
    await user.click(within(heading).getByRole('button', { name: 'settings.edit_model_list_settings' }))
    const input = screen.getByRole('textbox', { name: 'settings.model_list_url' })
    await user.clear(input)
    await user.type(input, '/custom-models{Enter}')

    expect(onModelListSettingsChange).toHaveBeenCalledWith({
      modelListUrl: '/custom-models'
    })
  })

  it('delegates model row clicks only to selection', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const onSelect = vi.fn()
    render(
      <ProviderModelList
        provider={provider}
        selectedIndex={0}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
        onEdit={onEdit}
        onMove={vi.fn()}
        onModelListSettingsChange={vi.fn()}
        onSelect={onSelect}
      />
    )

    await user.click(screen.getByRole('option', { name: /^Friendly model/ }))
    await user.click(screen.getByRole('option', { name: /^second-model/ }))

    expect(onSelect).toHaveBeenNthCalledWith(1, 0)
    expect(onSelect).toHaveBeenNthCalledWith(2, 1)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('delegates edit button clicks without treating them as row selection', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const onSelect = vi.fn()
    render(
      <ProviderModelList
        provider={provider}
        selectedIndex={0}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
        onEdit={onEdit}
        onMove={vi.fn()}
        onModelListSettingsChange={vi.fn()}
        onSelect={onSelect}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model: Friendly model' }))
    await user.click(screen.getByRole('button', { name: 'settings.edit_model: second-model' }))

    expect(onEdit).toHaveBeenNthCalledWith(1, 0)
    expect(onEdit).toHaveBeenNthCalledWith(2, 1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens model editing when a model row is double-clicked', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    render(
      <ProviderModelList
        provider={provider}
        selectedIndex={0}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
        onEdit={onEdit}
        onMove={vi.fn()}
        onModelListSettingsChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    await user.dblClick(screen.getByRole('option', { name: 'second-model' }))

    expect(onEdit).toHaveBeenCalledOnce()
    expect(onEdit).toHaveBeenCalledWith(1)
  })
})
