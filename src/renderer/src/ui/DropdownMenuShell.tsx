import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode
} from 'react'
import { useMenuCollisionProps } from './floatingViewport'

type DropdownMenuRootProps = ComponentPropsWithoutRef<typeof DropdownMenu.Root>

export function DropdownMenuRoot({ modal = false, ...props }: DropdownMenuRootProps) {
  return <DropdownMenu.Root {...props} modal={modal} />
}

type DropdownMenuTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof DropdownMenu.Trigger>,
  'onMouseDown' | 'tabIndex'
>

export function DropdownMenuTrigger(props: DropdownMenuTriggerProps) {
  return (
    <DropdownMenu.Trigger
      {...props}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
    />
  )
}

type DropdownMenuContentProps = Omit<ComponentPropsWithoutRef<typeof DropdownMenu.Content>, 'sticky'> & {
  restoreFocus?: boolean
}

export function DropdownMenuContent({
  collisionPadding,
  onCloseAutoFocus,
  restoreFocus = false,
  ...props
}: DropdownMenuContentProps) {
  const collision = useMenuCollisionProps(collisionPadding)
  return (
    <DropdownMenu.Content
      {...props}
      {...collision}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event)
        if (!restoreFocus) event.preventDefault()
      }}
    />
  )
}

export function DropdownMenuSubContent({ collisionPadding, ...props }: Omit<ComponentProps<typeof DropdownMenu.SubContent>, 'sticky'>) {
  const collision = useMenuCollisionProps(collisionPadding)
  return <DropdownMenu.SubContent {...props} {...collision} />
}

interface DropdownMenuPosition {
  align: 'start' | 'center' | 'end'
  collisionPadding: number
  side: 'top' | 'right' | 'bottom' | 'left'
  sideOffset: number
}

interface DropdownMenuShellProps {
  children: ReactNode
  className: string
  position: DropdownMenuPosition
  sidebarFloating?: boolean
  trigger: ReactElement
}

export function DropdownMenuShell({
  children,
  className,
  position,
  sidebarFloating = false,
  trigger
}: DropdownMenuShellProps) {
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          className={className}
          data-sidebar-floating={sidebarFloating ? true : undefined}
          {...position}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}
