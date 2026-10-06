import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SegmentedMultiSelect } from './SegmentedMultiSelect'

function Example() {
  const [values, setValues] = useState({ model: true, user: true, scripts: false })
  return <SegmentedMultiSelect ariaLabel="Availability"
    options={Object.entries(values).map(([value, checked]) => ({ value, label: value, checked }))}
    onChange={(value, checked) => setValues(previous => ({ ...previous, [value]: checked }))} />
}

describe('SegmentedMultiSelect', () => {
  it('toggles independent options by label and keyboard, allowing all and none', async () => {
    const user = userEvent.setup()
    render(<Example />)
    const model = screen.getByRole('checkbox', { name: 'model' })
    const shortcut = screen.getByRole('checkbox', { name: 'user' })
    const scripts = screen.getByRole('checkbox', { name: 'scripts' })
    await user.click(screen.getByText('scripts'))
    for (const input of [model, shortcut, scripts]) expect(input).toBeChecked()
    await user.click(screen.getByText('model'))
    expect(model).not.toBeChecked()
    expect(shortcut).toBeChecked()
    expect(scripts).toBeChecked()
    await user.tab()
    expect(shortcut).toHaveFocus()
    await user.keyboard(' ')
    await user.tab()
    expect(scripts).toHaveFocus()
    await user.keyboard(' ')
    for (const input of [model, shortcut, scripts]) expect(input).not.toBeChecked()
  })

  it('respects individual and group disabling and sends only the changed option', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const options = [
      { value: 'model', label: 'Model', checked: true, disabled: true },
      { value: 'user', label: 'User', checked: false }
    ]
    const view = render(<SegmentedMultiSelect ariaLabel="Availability" options={options} onChange={onChange} />)
    await user.click(screen.getByText('Model'))
    expect(onChange).not.toHaveBeenCalled()
    await user.tab()
    expect(screen.getByRole('checkbox', { name: 'User' })).toHaveFocus()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('user', true)
    view.rerender(<SegmentedMultiSelect ariaLabel="Availability" options={options} onChange={onChange} disabled />)
    for (const input of screen.getAllByRole('checkbox')) expect(input).toBeDisabled()
    await user.click(screen.getByText('User'))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
