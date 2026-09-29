import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from './SegmentedControl'

const options = [
  { value: 'preview', label: 'Preview' },
  { value: 'unavailable', label: 'Unavailable', disabled: true },
  { value: 'source', label: 'Source' }
]

function Example({ label, itemWidth }: { label: string; itemWidth?: 'content' | 'equal' }) {
  const [value, setValue] = useState('preview')
  return <SegmentedControl ariaLabel={label} options={options} value={value} onChange={setValue} itemWidth={itemWidth} />
}

describe('SegmentedControl', () => {
  it.each(['content', 'equal'] as const)('selects one option with the keyboard, skips disabled options and keeps groups independent (%s)', async itemWidth => {
    const user = userEvent.setup()
    render(<><Example label="First" itemWidth={itemWidth} /><Example label="Second" itemWidth={itemWidth} /><button>Next</button></>)
    const first = within(screen.getByRole('radiogroup', { name: 'First' }))
    const second = within(screen.getByRole('radiogroup', { name: 'Second' }))
    await user.tab()
    expect(first.getByRole('radio', { name: 'Preview' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(first.getByRole('radio', { name: 'Source' })).toHaveFocus()
    expect(first.getByRole('radio', { name: 'Source' })).toBeChecked()
    expect(first.getByRole('radio', { name: 'Preview' })).not.toBeChecked()
    expect(second.getByRole('radio', { name: 'Preview' })).toBeChecked()
    await user.keyboard('{ArrowRight}')
    expect(first.getByRole('radio', { name: 'Preview' })).toBeChecked()
    await user.tab()
    expect(second.getByRole('radio', { name: 'Preview' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus()
  })

  it('changes through labels, leaves selected values alone and respects group disabling', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const view = render(<SegmentedControl ariaLabel="View" options={options} value="preview" onChange={onChange} />)
    await user.click(screen.getByText('Preview'))
    await user.click(screen.getByText('Unavailable'))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByText('Source'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('source')
    view.rerender(<SegmentedControl ariaLabel="View" options={options} value="source" onChange={onChange} disabled />)
    expect(screen.getByRole('radio', { name: 'Source' })).toBeChecked()
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    await user.click(screen.getByText('Preview'))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
