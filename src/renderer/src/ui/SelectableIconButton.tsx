import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { NoFocusButton } from './NoFocusButton'

type SelectableIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'tabIndex' | 'type'> & {
  iconSize: number
  label: string
  pressed: boolean
  preserveFocus?: boolean
  variant?: 'default' | 'toolbar'
} & ({ Icon: LucideIcon; PressedIcon?: LucideIcon; icon?: never } | { icon: ReactNode; Icon?: never; PressedIcon?: never })

export function SelectableIconButton({
  className,
  Icon,
  icon,
  iconSize,
  label,
  pressed,
  PressedIcon,
  preserveFocus = false,
  variant = 'default',
  ...props
}: SelectableIconButtonProps) {
  const Button = preserveFocus ? NoFocusButton : 'button'
  const DisplayIcon = pressed && PressedIcon ? PressedIcon : Icon

  return (
    <Button
      {...props}
      aria-label={label}
      aria-pressed={pressed}
      className={[
        variant === 'toolbar' ? 'ui-tool-button ui-tool-button-square' : 'ui-icon-button',
        'ui-selectable-icon-button',
        pressed ? 'ui-selectable-icon-button-active' : '',
        className ?? ''
      ].filter(Boolean).join(' ')}
      data-tooltip={label}
      type="button"
    >
      {icon ?? (DisplayIcon && <DisplayIcon size={iconSize} />)}
    </Button>
  )
}
