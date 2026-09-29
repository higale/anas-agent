import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RangeField } from './RangeField'

describe('RangeField', () => {
  it('keeps decimal keyboard changes, the displayed value and accessible value synchronized', () => {
    const onChange = vi.fn()
    function Example() {
      const [value, setValue] = useState(1)
      return <RangeField label={<strong>Speed</strong>} min={0.25} max={4} step={0.05}
        value={value} formatValue={value => `${value}x`} onChange={next => { setValue(next); onChange(next) }} />
    }
    render(<Example />)
    const slider = screen.getByRole('slider', { name: 'Speed' })
    fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39 })
    expect(onChange).toHaveBeenLastCalledWith(1.05)
    expect(slider).toHaveAttribute('aria-valuenow', '1.05')
    expect(slider).toHaveAttribute('aria-valuetext', '1.05x')
    expect(slider).toHaveTextContent('1.05x')
    fireEvent.keyDown(slider, { key: 'Home', keyCode: 36 })
    expect(slider).toHaveAttribute('aria-valuenow', '0.25')
    fireEvent.keyDown(slider, { key: 'ArrowLeft', keyCode: 37 })
    expect(onChange).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(slider, { key: 'End', keyCode: 35 })
    expect(slider).toHaveAttribute('aria-valuenow', '4')
    fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39 })
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('allows mark selection when enabled and blocks marks and keyboard changes when disabled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function Example({ disabled = false }: { disabled?: boolean }) {
      const [checked, setChecked] = useState(false)
      const [value, setValue] = useState(14)
      return <RangeField label="Threshold" checked={checked} onCheckedChange={setChecked}
        disabled={disabled} min={10} max={18} step={1} value={value}
        marks={[{ value: 10, label: 'Minimum' }, { value: 18, label: 'Maximum' }]}
        onChange={next => { setValue(next); onChange(next) }} />
    }
    const view = render(<Example />)
    const slider = screen.getByRole('slider', { name: 'Threshold' })
    expect(slider).toHaveAttribute('aria-disabled', 'true')
    expect(slider).not.toHaveAttribute('tabindex', '0')
    await user.click(screen.getByText('Maximum'))
    fireEvent.keyDown(slider, { key: 'End', keyCode: 35 })
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'Threshold' }))
    await user.click(screen.getByText('Maximum'))
    expect(onChange).toHaveBeenLastCalledWith(18)
    expect(slider).toHaveAttribute('aria-valuenow', '18')
    view.rerender(<Example disabled />)
    await user.click(screen.getByText('Minimum'))
    fireEvent.keyDown(slider, { key: 'Home', keyCode: 36 })
    expect(slider).toHaveAttribute('aria-disabled', 'true')
    expect(slider).toHaveAttribute('aria-valuenow', '18')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
