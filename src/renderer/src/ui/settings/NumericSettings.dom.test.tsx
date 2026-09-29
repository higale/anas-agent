import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/types'
import { McpEditor } from '../mcp/McpEditor'
import { emptyMcpDraft } from '../mcp/mcpDraft'
import { AttachmentSettings } from './AttachmentSettings'
import { ChatModeSettings } from './ChatModeSettings'
import { LogSettings } from './LogSettings'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../speech/SpeechReplySettings', () => ({ SpeechReplySettings: () => null }))

describe('numeric settings', () => {
  it('saves grouped attachment limits as numbers and keeps thousand-character steps', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<AttachmentSettings settings={undefined} onChange={onChange} />)
    const input = screen.getByRole('spinbutton', { name: /settings.attachment_text_max_chars/ })
    expect(input).toHaveValue('200,000')
    await user.clear(input)
    await user.paste('300,000')
    await user.keyboard('{ArrowUp}{Enter}')
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ attachmentTextMaxChars: 301000 })
  })

  it('preserves unlimited model calls and commits a numeric count', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const view = render(<ChatModeSettings settings={undefined} onChange={onChange} onSpeechReplyChange={vi.fn()} />)
    const input = screen.getByRole('spinbutton', { name: /settings.max_model_calls_per_run/ })
    expect(input).toHaveValue('')
    await user.type(input, '1234{Enter}')
    expect(input).toHaveValue('1,234')
    expect(onChange).toHaveBeenLastCalledWith({ maxModelCallsPerRun: 1234 })
    view.rerender(<ChatModeSettings settings={{ maxModelCallsPerRun: 1234 } as AppSettings}
      onChange={onChange} onSpeechReplyChange={vi.fn()} />)
    await user.clear(input)
    await user.tab()
    expect(onChange).toHaveBeenLastCalledWith({ maxModelCallsPerRun: 0 })
  })

  it('saves MCP timeouts in milliseconds after stepping by one second', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const t = ((key: string) => key) as Parameters<typeof emptyMcpDraft>[0]
    render(<McpEditor mcpDraft={emptyMcpDraft(t)} runtimeEnabled={false} status={undefined}
      onAutosizeInput={vi.fn()} onUpdateDraft={onUpdateDraft} />)
    const input = screen.getByRole('spinbutton', { name: 'settings.timeout_ms' })
    expect(input).toHaveValue('30,000')
    await user.clear(input)
    await user.paste('60,000')
    await user.keyboard('{ArrowDown}')
    await user.tab()
    expect(onUpdateDraft).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 59000 })
  })

  it('preserves zero log retention while accepting grouped day counts', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<LogSettings settings={undefined} onChange={onChange}
      onOpenLogDirectory={vi.fn()} onOpenRuntimeLogViewer={vi.fn()} />)
    const input = screen.getByRole('spinbutton', { name: /settings.log_retention_days/ })
    await user.clear(input)
    await user.paste('3,000')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ logRetentionDays: 3000 })
    await user.clear(input)
    await user.type(input, '0{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ logRetentionDays: 0 })
  })
})
