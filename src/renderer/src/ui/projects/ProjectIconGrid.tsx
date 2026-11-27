import { useState, type KeyboardEvent, type ReactNode } from 'react'

export function ProjectIconGrid<T extends string>({ label, options, value, disabled, onChange }: {
  label: string
  options: Array<{ value: T; label: string; content: ReactNode }>
  value?: T
  disabled: boolean
  onChange(value: T): void
}) {
  const [focused, setFocused] = useState<T>()
  const active = options.find(option => option.value === focused)?.value
    ?? options.find(option => option.value === value)?.value ?? options[0]?.value
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>): void {
    const buttons = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('button'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[event.key]
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : offset === undefined ? undefined : Math.max(0, Math.min(buttons.length - 1, index + offset))
    if (next === undefined) return
    event.preventDefault()
    buttons[next]?.focus()
  }
  return <div className="project-icon-options" role="group" aria-label={label}>
    {options.map(option => <button key={option.value} className="project-icon-option" type="button"
      disabled={disabled} aria-label={option.label} title={option.label} aria-pressed={option.value === value}
      tabIndex={option.value === active ? 0 : -1} onFocus={() => setFocused(option.value)} onKeyDown={moveFocus}
      onClick={() => onChange(option.value)}>{option.content}</button>)}
  </div>
}
