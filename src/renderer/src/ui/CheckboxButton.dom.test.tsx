import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CheckboxButton } from './CheckboxButton'

function Example() {
  const [checked, setChecked] = useState(false)
  return <CheckboxButton label="Enabled" checked={checked} onChange={setChecked} />
}

describe('CheckboxButton', () => {
  it('toggles by label, input and keyboard without submitting its form', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(event => event.preventDefault())
    render(<form onSubmit={onSubmit}><Example /></form>)
    const checkbox = screen.getByRole('checkbox', { name: 'Enabled' })
    await user.click(screen.getByText('Enabled'))
    expect(checkbox).toBeChecked()
    await user.click(checkbox)
    expect(checkbox).not.toBeChecked()
    await user.keyboard(' ')
    expect(checkbox).toBeChecked()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('respects both direct and fieldset disabling and reflects externally saved changes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const view = render(<CheckboxButton label="Enabled" checked={false} disabled onChange={onChange} />)
    const checkbox = screen.getByRole('checkbox', { name: 'Enabled' })
    expect(checkbox).toBeDisabled()
    await user.click(screen.getByText('Enabled'))
    expect(onChange).not.toHaveBeenCalled()
    view.rerender(<fieldset disabled><CheckboxButton label="Enabled" checked onChange={onChange} /></fieldset>)
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeChecked()
    await user.click(screen.getByText('Enabled'))
    expect(onChange).not.toHaveBeenCalled()
    view.rerender(<CheckboxButton label="Enabled" checked onChange={onChange} />)
    await user.click(screen.getByText('Enabled'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false)
  })
})
