import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommitTextarea, CommitTextInput } from './CommitTextField'

describe('CommitTextInput', () => {
  it('preserves newer typing across a delayed save acknowledgement', async () => {
    let finish!: () => void
    const onCommit = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const view = render(<CommitTextInput preserveDirtyDraft value="Original" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'First edit' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: 'Newer draft' } })
    view.rerender(<CommitTextInput preserveDirtyDraft value="First edit" onCommit={onCommit} />)
    await act(async () => finish())
    expect(input).toHaveValue('Newer draft')
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenLastCalledWith('Newer draft')
    view.rerender(<CommitTextInput preserveDirtyDraft value="Newer draft" onCommit={onCommit} />)
    await act(async () => finish())
    view.rerender(<CommitTextInput preserveDirtyDraft value="External update" onCommit={onCommit} />)
    expect(input).toHaveValue('External update')
  })

  it('saves a revert to the original value while an earlier change is still pending', async () => {
    const finish: (() => void)[] = []
    const onCommit = vi.fn(() => new Promise<void>(resolve => { finish.push(resolve) }))
    const view = render(<CommitTextInput preserveDirtyDraft value="Original" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Changed' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: 'Original' } })
    fireEvent.blur(input)
    expect(onCommit.mock.calls).toEqual([['Changed'], ['Original']])
    view.rerender(<CommitTextInput preserveDirtyDraft value="Changed" onCommit={onCommit} />)
    await act(async () => finish[0]())
    expect(input).toHaveValue('Original')
    view.rerender(<CommitTextInput preserveDirtyDraft value="Original" onCommit={onCommit} />)
    await act(async () => finish[1]())
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('keeps Enter used by an input method from committing or blurring the draft', () => {
    const onCommit = vi.fn()
    render(<CommitTextInput value="" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    input.focus()
    fireEvent.change(input, { target: { value: '技能目录' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(input).toHaveFocus()
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('技能目录')
  })
})

describe('CommitTextarea external updates', () => {
  it('adopts incoming values while pristine and preserves a dirty draft until committed', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<CommitTextarea preserveDirtyDraft value="" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    rerender(<CommitTextarea preserveDirtyDraft value="Detected environment" onCommit={onCommit} />)
    expect(input).toHaveValue('Detected environment')
    fireEvent.change(input, { target: { value: 'User edit' } })
    rerender(<CommitTextarea preserveDirtyDraft value="Updated environment" onCommit={onCommit} />)
    expect(input).toHaveValue('User edit')
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('User edit')
    rerender(<CommitTextarea preserveDirtyDraft value="User edit" onCommit={onCommit} />)
    rerender(<CommitTextarea preserveDirtyDraft value="Next saved value" onCommit={onCommit} />)
    expect(input).toHaveValue('Next saved value')
  })
})
