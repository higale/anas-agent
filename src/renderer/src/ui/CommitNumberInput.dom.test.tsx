import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommitNumberInput } from './CommitNumberInput'

describe('CommitNumberInput', () => {
  it('preserves fractional and negative values when decimals are allowed', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<CommitNumberInput integer={false} value="" onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton')
    await user.type(input, '-1234.56789')
    expect(input).toHaveValue('-1,234.56789')
    await user.tab()
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('-1234.56789')
  })

  it('keeps a disabled number control unchanged when its step buttons are clicked', async () => {
    const user = userEvent.setup()
    const onDraftChange = vi.fn()
    render(<CommitNumberInput disabled value="120" onCommit={vi.fn()} onDraftChange={onDraftChange} />)
    await user.click(screen.getByRole('button', { name: 'Increase Value' }))
    await user.click(screen.getByRole('button', { name: 'Decrease Value' }))
    expect(screen.getByRole('spinbutton')).toBeDisabled()
    expect(screen.getByRole('spinbutton')).toHaveValue('120')
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('groups digits while typing and commits the unformatted value on Enter', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<CommitNumberInput value="256000" min={2000} max={1000000} step={1000} onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton')
    expect(input).toHaveValue('256,000')
    await user.clear(input)
    await user.type(input, '128000')
    expect(input).toHaveValue('128,000')
    expect(onCommit).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('128000')
  })

  it('accepts grouped pasted values and commits on blur', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<CommitNumberInput value="16000" onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton')
    await user.clear(input)
    await user.paste('32,768')
    expect(input).toHaveValue('32,768')
    await user.tab()
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('32768')
  })

  it('reverts an edit on Escape without committing it', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<CommitNumberInput value="16000" onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton')
    await user.clear(input)
    await user.type(input, '32000{Escape}')
    expect(input).toHaveValue('16,000')
    expect(input).not.toHaveFocus()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits the final normalized value when an edit exceeds the allowed range', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<CommitNumberInput value="16000" min={2000} max={1000000} onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton')
    await user.clear(input)
    await user.type(input, '1000001')
    await user.tab()
    expect(input).toHaveValue('1,000,000')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('1000000')
  })

  it('steps by mouse and keyboard without changing values on wheel events', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<CommitNumberInput value="16000" min={0} max={1000000} step={1000} onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton')
    await user.click(screen.getByRole('button', { name: 'Increase Value' }))
    expect(input).toHaveValue('17,000')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('16,000')
    await user.click(screen.getByRole('button', { name: 'Decrease Value' }))
    expect(input).toHaveValue('15,000')
    fireEvent.wheel(input, { deltaY: 100 })
    expect(input).toHaveValue('15,000')
    await user.tab()
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('15000')
  })

  it('can return to an empty value by stepping down to zero', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<CommitNumberInput value="1000" min={0} step={1000}
      normalizeDraft={(value) => value === '0' ? '' : value} onCommit={onCommit} />)
    const input = screen.getByRole('spinbutton')
    await user.click(input)
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('')
    await user.tab()
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('')
  })

  it('keeps a zero-as-empty field blank when zero is typed into an already empty field', async () => {
    const user = userEvent.setup()
    const onDraftChange = vi.fn()
    render(<CommitNumberInput value="" min={0} normalizeDraft={(value) => value === '0' ? '' : value}
      onDraftChange={onDraftChange} onCommit={vi.fn()} />)
    const input = screen.getByRole('spinbutton')
    await user.type(input, '0')
    expect(input).toHaveValue('')
    expect(onDraftChange).toHaveBeenLastCalledWith('')
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('1')
  })
})
