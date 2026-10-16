import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelListUrlPopover } from './ModelListUrlPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { url?: string }) => values?.url ? `${key}: ${values.url}` : key
  })
}))

describe('model list URL popover', () => {
  it('shows the inferred endpoint when no explicit URL is configured', async () => {
    const user = userEvent.setup()
    render(
      <ModelListUrlPopover
        baseUrl="https://example.com/v1"
        modelListUrl=""
        onChange={vi.fn()}
        protocol="openai_chat_completions"
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model_list_settings' }))

    expect(screen.getByText('settings.model_list_url_resolved: https://example.com/v1/models'))
      .toBeInTheDocument()
  })

  it('commits a custom model list URL', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <ModelListUrlPopover
        baseUrl="https://example.com/v1"
        modelListUrl="{base_url}/models"
        onChange={onChange}
        protocol="openai_chat_completions"
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model_list_settings' }))
    const input = screen.getByRole('textbox', { name: 'settings.model_list_url' })
    await user.clear(input)
    await user.type(input, 'https://catalog.example.com/models{Enter}')

    expect(onChange).toHaveBeenCalledWith({
      modelListUrl: 'https://catalog.example.com/models'
    })
  })

  it('restores the model list URL from a matching template', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <ModelListUrlPopover
        baseUrl="https://api.anthropic.com"
        modelListUrl="/custom-models"
        onChange={onChange}
        protocol="anthropic_messages"
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model_list_settings' }))
    await user.click(screen.getByRole('button', { name: 'settings.restore_template_model_list_settings' }))

    expect(onChange).toHaveBeenCalledWith({
      modelListUrl: 'https://api.anthropic.com/v1/models'
    })
  })
})
