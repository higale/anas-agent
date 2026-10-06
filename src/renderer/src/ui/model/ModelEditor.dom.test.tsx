import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelEditor } from './ModelEditor'
import { emptyModelDraft } from './modelDraft'
import type { ModelDraft } from './modelDraft'
import type { ModelProviderConfigDetail } from '@shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

function providerForDraft(draft: ModelDraft): ModelProviderConfigDetail {
  return {
    id: 'provider-1',
    index: 0,
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    modelListUrl: draft.modelListUrl,
    modelListAuth: draft.modelListAuth,
    apiKey: draft.apiKey,
    parameters: JSON.parse(draft.providerParametersJson || '{}') as Record<string, unknown>,
    models: [{
      id: 'model-1',
      index: 0,
      displayName: draft.displayName,
      model: draft.model,
      parameters: {},
      parameterPresetMode: draft.parameterPresetMode,
      capabilities: draft.capabilities,
      stream: draft.stream,
      maxContextTokens: Number(draft.maxContextTokens),
      maxOutputTokens: Number(draft.maxOutputTokens),
      contextCompressionThreshold: draft.contextCompressionThreshold,
      contextCompressionEnabled: draft.contextCompressionEnabled
    }]
  }
}

async function openModelDetails(user = userEvent.setup()): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'settings.edit_model: settings.no_model_id' }))
  return screen.findByRole('dialog')
}

describe('model creation', () => {
  it('offers the three explicit provider protocols', async () => {
    const user = userEvent.setup()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )

    const protocol = screen.getByRole('combobox', { name: 'settings.provider' })
    expect(protocol).toHaveValue('OpenAI Chat Completions')
    await user.click(protocol)
    const protocolOptions = document.getElementById(protocol.getAttribute('aria-controls') ?? '')
    expect(protocolOptions).not.toBeNull()
    expect(within(protocolOptions!).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'OpenAI Responses',
      'OpenAI Chat Completions',
      'Anthropic Messages'
    ])
  })

  it('always shows provider-level parameters separately from model parameters', () => {
    const onUpdateDraft = vi.fn()
    const draft = emptyModelDraft()
    const view = render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )

    expect(screen.queryByRole('checkbox', { name: 'settings.extra_parameters' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'settings.extra_parameters' })).toHaveValue('')

    const populatedDraft = {
      ...draft,
      providerParametersJson: JSON.stringify({ reasoning_split: true }, null, 2)
    }
    view.rerender(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={populatedDraft}
        provider={providerForDraft(populatedDraft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox', { name: 'settings.extra_parameters' }))
      .toHaveValue(JSON.stringify({ reasoning_split: true }, null, 2))
  })

  it('opens the multi-select model list from the existing add button', async () => {
    const user = userEvent.setup()
    const onAddProviderModels = vi.fn().mockResolvedValue(true)
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={['model-a', 'model-b']}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onAddProviderModels={onAddProviderModels}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.add_provider_model' }))
    const dialog = await screen.findByRole('dialog', { name: 'settings.add_models_title' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'model-a' }))
    await user.click(within(dialog).getByRole('button', { name: 'settings.add_selected_models' }))

    expect(onAddProviderModels).toHaveBeenCalledWith(['model-a'])
  })
})

describe('model token controls', () => {
  it('keeps model editing open after backdrop clicks and allows Escape or Close', async () => {
    const user = userEvent.setup()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )
    const dialog = await openModelDetails(user)
    const displayName = within(dialog).getByRole('textbox', { name: 'settings.model_display_name' })
    await user.type(displayName, 'Unsaved model name')
    await user.click(document.querySelector('.ui-backdrop')!)
    expect(dialog).toBeVisible()
    expect(displayName).toHaveValue('Unsaved model name')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await openModelDetails(user)
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('edits the model display name separately from its provider model ID', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = { ...emptyModelDraft(), model: 'remote-model' }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model: remote-model' }))
    const dialog = await screen.findByRole('dialog')
    const displayName = within(dialog).getByRole('textbox', { name: 'settings.model_display_name' })
    await user.type(displayName, 'Friendly model{Enter}')

    expect(onUpdateDraft).not.toHaveBeenCalled()
    expect(displayName).toHaveValue('Friendly model')
    expect(within(dialog).getByRole('combobox', { name: 'settings.model_id' })).toHaveValue('remote-model')
  })

  it('steps maximum output tokens in thousand-token increments', async () => {
    const user = userEvent.setup()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )
    await openModelDetails()
    const input = screen.getByLabelText('settings.max_output_tokens') as HTMLInputElement
    const contextControls = input.closest('.model-context-controls')

    expect(input).toHaveAttribute('aria-valuemin', '0')
    expect(input).toHaveAttribute('step', '1000')
    expect(input.value).toBe('16,000')
    expect(contextControls).toHaveClass('ui-grid-3')
    expect(contextControls?.children).toHaveLength(3)

    await user.click(input)
    await user.keyboard('{ArrowUp}')
    expect(input.value).toBe('17,000')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(input.value).toBe('15,000')
  })

  it('steps from provider-default mode to one thousand tokens', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyModelDraft(), maxOutputTokens: '0' }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )
    await openModelDetails()
    const input = screen.getByLabelText('settings.max_output_tokens') as HTMLInputElement

    expect(input.value).toBe('')
    expect(input).toHaveAttribute('placeholder', 'settings.max_output_tokens_ignored')
    await user.click(input)
    await user.keyboard('{ArrowUp}')
    expect(input.value).toBe('1,000')
  })

  it('maps an empty maximum output field to the ignored value', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )
    await openModelDetails()
    const input = screen.getByLabelText('settings.max_output_tokens') as HTMLInputElement

    await user.clear(input)

    expect(onUpdateDraft).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it('uses the compression threshold label as the enable checkbox', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = { ...emptyModelDraft(), contextCompressionEnabled: false }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )

    await openModelDetails(user)
    const checkbox = screen.getByRole('checkbox', { name: 'settings.context_compression_threshold' })
    expect(checkbox).not.toBeChecked()
    expect(screen.getByRole('slider', { name: 'settings.context_compression_threshold' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText('settings.context_compression_enabled')).not.toBeInTheDocument()
    await user.click(checkbox)
    expect(onUpdateDraft).not.toHaveBeenCalled()
    expect(checkbox).toBeChecked()
  })

  it('shows extra parameters and switches reasoning option sources without enabling toggles', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = emptyModelDraft()
    const view = render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )

    await openModelDetails(user)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('checkbox', { name: 'settings.extra_parameters' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'settings.extra_parameters' })).toBeInTheDocument()
    const modePicker = within(dialog).getByRole('radiogroup', { name: 'settings.parameter_preset_mode' })
    expect(within(modePicker).getByRole('radio', { name: 'settings.parameter_preset_mode_protocol_default' }))
      .toBeChecked()
    expect(within(dialog).getByText('OpenAI Chat Completions')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'settings.add_model_parameter_preset' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
    const protocolDefaultToggle = within(dialog).getByRole('checkbox', { name: 'common.default' })
    expect(protocolDefaultToggle).not.toBeChecked()
    await user.click(protocolDefaultToggle)
    expect(protocolDefaultToggle).toBeChecked()
    await user.click(within(modePicker).getByRole('radio', { name: 'settings.parameter_preset_mode_custom' }))
    expect(onUpdateDraft).not.toHaveBeenCalled()

    const customDraft = {
      ...draft,
      parameterPresetMode: 'custom' as const
    }
    view.rerender(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={customDraft}
        provider={providerForDraft(customDraft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )
    expect(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'settings.extra_parameters' }))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.add_model_parameter_preset' })).toBeInTheDocument()
    expect(within(modePicker).getByRole('radio', { name: 'settings.parameter_preset_mode_custom' })).toBeChecked()
    await user.click(within(modePicker).getByRole('radio', { name: 'settings.parameter_preset_mode_none' }))
    expect(within(modePicker).getByRole('radio', { name: 'settings.parameter_preset_mode_none' })).toBeChecked()
  })

  it('selects model rows without opening details and opens details from the edit button', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyModelDraft(), parameterPresetMode: 'custom' as const }
    const provider = providerForDraft(draft)
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={provider}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )

    expect(screen.getByRole('option', { name: 'settings.no_model_id' })).toBeInTheDocument()
    expect(screen.queryByLabelText('settings.max_output_tokens')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.model_parameter_presets')).not.toBeInTheDocument()

    await user.click(screen.getByRole('option', { name: 'settings.no_model_id' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const dialog = await openModelDetails(user)
    expect(within(dialog).getByLabelText('settings.max_output_tokens')).toBeInTheDocument()
    expect(within(dialog).getByText('settings.model_parameter_presets')).toBeInTheDocument()
    const modelCard = document.querySelector<HTMLElement>('[data-settings-group="models"]')!
    expect(within(modelCard).queryByLabelText('settings.max_output_tokens')).not.toBeInTheDocument()
    expect(within(modelCard).queryByText('settings.model_parameter_presets')).not.toBeInTheDocument()
  })

  it('opens model details when the selected model row is double-clicked', async () => {
    const user = userEvent.setup()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )

    await user.dblClick(screen.getByRole('option', { name: 'settings.no_model_id' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('keeps model deletion out of the details dialog', async () => {
    const onDeleteProviderModel = vi.fn().mockResolvedValue(true)
    const draft = emptyModelDraft()
    const provider = providerForDraft(draft)
    provider.models.push({
      ...provider.models[0],
      id: 'model-2',
      index: 1,
      model: 'other-model'
    })
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={provider}
        selectedModelIndex={0}
        onDeleteProviderModel={onDeleteProviderModel}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )

    const dialog = await openModelDetails()
    expect(within(dialog).queryByRole('button', { name: 'settings.delete_model' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'common.cancel' })).not.toHaveClass('ui-button-compact')
    expect(onDeleteProviderModel).not.toHaveBeenCalled()
  })

  it('adds a model parameter preset from the model card', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = { ...emptyModelDraft(), parameterPresetMode: 'custom' as const }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )

    await openModelDetails(user)
    const addButton = screen.getByRole('button', { name: 'settings.add_model_parameter_preset' })
    const toolbar = addButton.closest<HTMLElement>('.ui-toolbar')
    expect(toolbar).not.toBeNull()
    expect(within(toolbar!).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'settings.import_protocol_defaults',
      'settings.add_model_parameter_preset',
      'settings.delete_model_parameter_preset',
      'common.move_up',
      'common.move_down'
    ])
    await user.click(addButton)
    expect(onUpdateDraft).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByRole('textbox', { name: 'settings.name' })).toHaveValue(
      'settings.new_model_parameter_preset'
    )
  })

  it('restores the current protocol parameter defaults directly', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const onSaveDetails = vi.fn().mockResolvedValue(undefined)
    const draft = {
      ...emptyModelDraft(), providerId: 'provider-1',
      protocol: 'anthropic_messages' as const,
      parameterPresetMode: 'custom' as const
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={onSaveDetails}
      />
    )

    await openModelDetails(user)
    await user.click(screen.getByRole('button', { name: 'settings.import_protocol_defaults' }))

    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSaveDetails).toHaveBeenCalledWith(expect.objectContaining({
      defaultParameterPresetId: undefined,
      parameterPresets: [
        expect.objectContaining({
          name: 'disable',
          parametersJson: JSON.stringify({ thinking: { type: 'disabled' } }, null, 2)
        }),
        expect.objectContaining({
          name: 'low',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low' }
          }, null, 2)
        }),
        expect.objectContaining({
          name: 'medium',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'medium' }
          }, null, 2)
        }),
        expect.objectContaining({
          name: 'high',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'high' }
          }, null, 2)
        }),
        expect.objectContaining({
          name: 'xhigh',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'xhigh' }
          }, null, 2)
        }),
        expect.objectContaining({
          name: 'max',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'max' }
          }, null, 2)
        })
      ]
    }))
  })

  it('confirms before replacing existing parameter options with protocol defaults', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const onSaveDetails = vi.fn().mockResolvedValue(undefined)
    const draft = {
      ...emptyModelDraft(), providerId: 'provider-1',
      protocol: 'openai_responses' as const,
      parameterPresetMode: 'custom' as const,
      parameterPresets: [{
        id: 'custom',
        name: 'custom',
        parametersJson: '{"temperature":0.5}'
      }],
      defaultParameterPresetId: 'custom'
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={onSaveDetails}
      />
    )

    await openModelDetails(user)
    await user.click(screen.getByRole('button', { name: 'settings.import_protocol_defaults' }))
    expect(onUpdateDraft).not.toHaveBeenCalled()
    const confirmation = await screen.findByRole('alertdialog')
    expect(within(confirmation).getByText('settings.restore_model_parameter_presets_title'))
      .toBeInTheDocument()

    await user.click(within(confirmation).getByRole('button', { name: 'settings.import_protocol_defaults' }))
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSaveDetails).toHaveBeenCalledWith(expect.objectContaining({
      defaultParameterPresetId: undefined,
      parameterPresets: expect.arrayContaining([
        expect.objectContaining({
          name: 'medium',
          parametersJson: JSON.stringify({
            reasoning: { effort: 'medium', summary: 'auto' }
          }, null, 2)
        })
      ])
    }))
  })

  it('edits a parameter preset name directly in its list item', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const onSaveDetails = vi.fn().mockResolvedValue(undefined)
    const draft = {
      ...emptyModelDraft(), providerId: 'provider-1',
      parameterPresetMode: 'custom' as const,
      parameterPresets: [{
        id: 'thinking-on',
        name: '思考开启',
        parametersJson: '{"enable_thinking":true}'
      }, {
        id: 'thinking-off',
        name: '思考关闭',
        parametersJson: '{"enable_thinking":false}'
      }]
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={onSaveDetails}
      />
    )

    const dialog = await openModelDetails(user)
    expect(within(dialog).queryByText('settings.name')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('option', { name: '思考关闭' }))
    expect(within(dialog).queryByRole('textbox', { name: 'settings.name' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('option', { name: '思考关闭' }))
    const nameInput = within(dialog).getByRole('textbox', { name: 'settings.name' })
    await user.clear(nameInput)
    await user.type(nameInput, '快速回答{Enter}')

    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSaveDetails).toHaveBeenCalledWith(expect.objectContaining({
      parameterPresets: [{
        id: 'thinking-on',
        name: '思考开启',
        parametersJson: '{"enable_thinking":true}'
      }, {
        id: 'thinking-off',
        name: '快速回答',
        parametersJson: '{"enable_thinking":false}'
      }]
    }))
  })

  it('places the default toggle after the parameter heading', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      parameterPresetMode: 'custom' as const,
      parameterPresets: [{
        id: 'thinking-on',
        name: '思考开启',
        parametersJson: '{"enable_thinking":true}'
      }],
      defaultParameterPresetId: 'thinking-on'
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )

    await openModelDetails(user)
    expect(screen.queryByText('settings.model_parameter_preset_parameters')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'common.default' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('option', { name: /思考开启/ }))
    const heading = screen.getByText('settings.model_parameter_preset_parameters')
      .closest('.ui-field-heading') as HTMLElement
    const defaultToggle = within(heading).getByRole('checkbox', { name: 'common.default' })
    expect(defaultToggle.closest('.ui-checkbox-field')).toHaveClass('ui-checkbox-field-inline')
    expect(defaultToggle).toBeChecked()

    await user.click(defaultToggle)
    expect(defaultToggle).not.toBeChecked()
    expect(onUpdateDraft).not.toHaveBeenCalled()
  })

  it('shows an explicit expression example when no model list URL is configured', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyModelDraft(), baseUrl: 'https://example.com/v1' }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )

    const listHeading = screen.getByText('settings.provider_models').closest('.provider-model-list-heading') as HTMLElement
    expect(within(listHeading).getByLabelText('settings.edit_model_list_settings')).toBeInTheDocument()
    const providerCard = screen.getByLabelText('settings.name').closest('[data-settings-group="provider"]')
    const dialog = await openModelDetails(user)
    const modelCard = document.querySelector<HTMLElement>('[data-settings-group="models"]')!
    expect(providerCard).toHaveAttribute('data-settings-group', 'provider')
    expect(modelCard).toHaveAttribute('data-settings-group', 'models')
    expect(providerCard).not.toBe(modelCard)
    expect(within(dialog).getByLabelText('settings.max_output_tokens')).toBeInTheDocument()
    expect(within(dialog).getByText('settings.model_parameter_presets')).toBeInTheDocument()
    const modelIdInput = within(dialog).getByRole('combobox', { name: 'settings.model_id' })
    expect(modelIdInput.closest('.model-details-dialog')).toBe(dialog)
    expect(modelIdInput).toHaveAttribute('placeholder', 'settings.model_id_placeholder')
    await user.click(screen.getByRole('button', { name: 'settings.model_id' }))
    const modelPicker = document.querySelector('.searchable-option-popover') as HTMLElement
    expect(within(modelPicker).queryByLabelText('settings.edit_model_list_settings')).not.toBeInTheDocument()
    expect(within(modelPicker).getByLabelText('settings.fetch_available_models')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(within(dialog).getByRole('button', { name: 'common.cancel' }))
    await user.click(within(listHeading).getByLabelText('settings.edit_model_list_settings'))
    expect(screen.getByLabelText('settings.model_list_url')).toHaveAttribute('placeholder', '{base_url}/models')
  })

  it('restores a matching template model list URL', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      protocol: 'anthropic_messages' as const,
      baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
      modelListUrl: '',
      modelListAuth: 'anthropic' as const
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )

    await user.click(screen.getByLabelText('settings.edit_model_list_settings'))
    await user.click(screen.getByText('settings.restore_template_model_list_settings'))

    expect(onUpdateDraft).toHaveBeenCalledWith({
      modelListAuth: 'bearer',
      modelListUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models'
    })
  })

  it('refreshes available models from inside the model picker', async () => {
    const user = userEvent.setup()
    const onRefreshCandidates = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      baseUrl: 'https://example.com/v1',
      modelListUrl: '{base_url}/models'
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={onRefreshCandidates}
        onUpdateDraft={vi.fn()}
        onSaveDetails={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model: settings.no_model_id' }))
    await user.click(screen.getByRole('button', { name: 'settings.model_id' }))
    await user.click(screen.getByLabelText('settings.fetch_available_models'))
    expect(onRefreshCandidates).toHaveBeenCalledOnce()
  })

  it('keeps duplicate model IDs selectable inside the model dialog portal', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = emptyModelDraft()
    const provider = providerForDraft(draft)
    provider.models.push({
      ...provider.models[0],
      id: 'model-2',
      index: 1,
      model: 'existing-model'
    })
    render(
      <ModelEditor
        candidates={['existing-model', 'new-model']}
        listLoading={false}
        modelDraft={draft}
        provider={provider}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onSaveDetails={vi.fn()}
      />
    )

    const dialog = await openModelDetails(user)
    await user.click(within(dialog).getByRole('button', { name: 'settings.model_id' }))
    const candidatePopover = screen.getByRole('dialog', { name: 'settings.model_id' })
    const candidateList = within(candidatePopover).getByRole('listbox')
    const configuredOption = within(candidateList).getByRole('option', { name: 'existing-model' })
    expect(candidateList.closest('.model-details-dialog')).toBe(dialog)
    expect(configuredOption).not.toBeDisabled()
    await user.click(configuredOption)
    expect(within(dialog).getByRole('combobox', { name: 'settings.model_id' })).toHaveValue('existing-model')
    await user.click(within(dialog).getByRole('checkbox', { name: 'settings.stream_output' }))
    expect(within(dialog).getByRole('checkbox', { name: 'settings.stream_output' })).not.toBeChecked()
    await user.click(within(dialog).getByRole('checkbox', { name: 'settings.model_capability_vision' }))
    expect(within(dialog).getByRole('checkbox', { name: 'settings.model_capability_vision' })).not.toBeChecked()
    await user.click(within(dialog).getByRole('checkbox', { name: 'settings.model_capability_tool_use' }))
    expect(within(dialog).getByRole('checkbox', { name: 'settings.model_capability_tool_use' })).not.toBeChecked()
    expect(onUpdateDraft).not.toHaveBeenCalled()
  })
})


describe('explicit model save and cancel', () => {
  function setup() {
    const draft = { ...emptyModelDraft(), providerId: 'provider-1', modelConfigId: 'model-1' }
    const onSaveDetails = vi.fn<(draft: ModelDraft) => Promise<void>>().mockResolvedValue(undefined)
    const onUpdateDraft = vi.fn()
    render(<ModelEditor candidates={[]} listLoading={false} modelDraft={draft}
      provider={providerForDraft(draft)} selectedModelIndex={0} onRefreshCandidates={vi.fn()}
      onUpdateDraft={onUpdateDraft} onSaveDetails={onSaveDetails} />)
    return { draft, onSaveDetails, onUpdateDraft }
  }

  it.each([
    ['settings.model_display_name', 'Friendly', 'displayName'],
    ['settings.model_id', 'remote-v2', 'model'],
    ['settings.max_context_tokens', '256000', 'maxContextTokens'],
    ['settings.max_output_tokens', '24000', 'maxOutputTokens'],
    ['settings.extra_parameters', '{"temperature":0.5}', 'parametersJson']
  ])('saves the focused %s field once with the capability toggles', async (label, value, key) => {
    const { onSaveDetails, onUpdateDraft } = setup()
    const user = userEvent.setup()
    const dialog = await openModelDetails(user)
    await user.click(within(dialog).getByRole('checkbox', { name: 'settings.model_capability_vision' }))
    const input = label === 'settings.model_id'
      ? within(dialog).getByRole('combobox', { name: label })
      : within(dialog).getByLabelText(label)
    await user.clear(input)
    await user.click(input)
    await user.paste(value)
    expect(input).toHaveFocus()
    expect(onSaveDetails).not.toHaveBeenCalled()
    expect(onUpdateDraft).not.toHaveBeenCalled()
    // Also covers activation without the browser first moving focus to the button.
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }))
    await screen.findByRole('button', { name: 'settings.edit_model: settings.no_model_id' })
    expect(onSaveDetails).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      [key]: value, capabilities: { vision: false, toolUse: true }
    }))
  })

  it('discards all edits on Cancel and reopens the persisted values', async () => {
    const { onSaveDetails, onUpdateDraft } = setup()
    const user = userEvent.setup()
    let dialog = await openModelDetails(user)
    await user.type(within(dialog).getByLabelText('settings.model_display_name'), 'Discard me')
    await user.click(within(dialog).getByRole('checkbox', { name: 'settings.stream_output' }))
    await user.click(within(dialog).getByRole('radio', { name: 'settings.parameter_preset_mode_custom' }))
    await user.click(within(dialog).getByRole('button', { name: 'settings.add_model_parameter_preset' }))
    await user.click(within(dialog).getByRole('button', { name: 'common.cancel' }))
    dialog = await openModelDetails(user)
    expect(within(dialog).getByLabelText('settings.model_display_name')).toHaveValue('')
    expect(within(dialog).getByRole('checkbox', { name: 'settings.stream_output' })).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: 'settings.parameter_preset_mode_protocol_default' })).toBeChecked()
    expect(onSaveDetails).not.toHaveBeenCalled()
    expect(onUpdateDraft).not.toHaveBeenCalled()
  })

  it('keeps invalid JSON for correction and saves the last focused preset JSON', async () => {
    const { onSaveDetails } = setup()
    const user = userEvent.setup()
    const dialog = await openModelDetails(user)
    await user.click(within(dialog).getByRole('radio', { name: 'settings.parameter_preset_mode_custom' }))
    await user.click(within(dialog).getByRole('button', { name: 'settings.add_model_parameter_preset' }))
    const name = within(dialog).getByLabelText('settings.name')
    await user.clear(name)
    await user.type(name, 'Think')
    const parameters = within(dialog).getByLabelText('settings.model_parameter_preset_parameters')
    await user.click(parameters)
    await user.paste('{bad')
    await user.click(within(dialog).getByRole('button', { name: 'common.save' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('settings.model_parameter_preset_invalid_json')
    expect(parameters).toHaveValue('{bad')
    expect(onSaveDetails).not.toHaveBeenCalled()
    await user.clear(parameters)
    await user.paste('{"enable_thinking":true}')
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }))
    expect(onSaveDetails).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      parameterPresets: [expect.objectContaining({ name: 'Think', parametersJson: '{"enable_thinking":true}' })]
    }))
  })

  it('blocks duplicate saves and closing while saving, then preserves edits on failure for retry', async () => {
    const { onSaveDetails } = setup()
    const user = userEvent.setup()
    let reject!: (error: Error) => void
    onSaveDetails.mockImplementationOnce(() => new Promise((_, rejectSave) => { reject = rejectSave }))
    const dialog = await openModelDetails(user)
    await user.type(within(dialog).getByLabelText('settings.model_display_name'), 'Keep me')
    const save = within(dialog).getByRole('button', { name: 'common.save' })
    await user.click(save)
    expect(save).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'common.cancel' })).toBeDisabled()
    const slider = within(dialog).getByRole('slider', { name: 'settings.context_compression_threshold' })
    expect(slider).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39 })
    expect(slider).toHaveAttribute('aria-valuenow', '0.8')
    await user.keyboard('{Escape}')
    fireEvent.click(save)
    expect(onSaveDetails).toHaveBeenCalledTimes(1)
    expect(dialog).toBeVisible()
    await act(async () => reject(new Error('Disk unavailable')))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('settings.failed_save_model')
    expect(within(dialog).getByRole('alert')).toHaveAttribute('data-tooltip', 'Disk unavailable')
    expect(within(dialog).getByLabelText('settings.model_display_name')).toHaveValue('Keep me')
    expect(slider).not.toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39 })
    expect(slider).toHaveAttribute('aria-valuenow', '0.85')
    await user.click(save)
    expect(onSaveDetails).toHaveBeenCalledTimes(2)
    expect(onSaveDetails).toHaveBeenLastCalledWith(expect.objectContaining({ contextCompressionThreshold: 0.85 }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('creates a blank model only when saved and leaves no entry after Cancel', async () => {
    const { onSaveDetails, onUpdateDraft } = setup()
    const user = userEvent.setup()
    async function openBlank() {
      await user.click(screen.getByRole('button', { name: 'settings.add_provider_model' }))
      await user.click(screen.getByRole('button', { name: 'settings.blank_model' }))
      return screen.findByRole('dialog')
    }
    let dialog = await openBlank()
    await user.click(within(dialog).getByRole('button', { name: 'common.cancel' }))
    expect(onSaveDetails).not.toHaveBeenCalled()
    expect(onUpdateDraft).not.toHaveBeenCalled()
    dialog = await openBlank()
    await user.type(within(dialog).getByRole('combobox', { name: 'settings.model_id' }), 'new-model')
    await user.click(within(dialog).getByRole('button', { name: 'common.save' }))
    expect(onSaveDetails).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      providerId: 'provider-1', model: 'new-model'
    }))
    expect(onSaveDetails.mock.calls[0][0].modelConfigId).toBeUndefined()
  })
})
