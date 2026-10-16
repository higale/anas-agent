import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { PopoverContent } from './PopoverContent'

/** Read-only details: hover to preview, activate to keep open for reading/copying. */
export function DetailsPopover({ label, text, className, disabled, ariaLabel, iconSrc }: {
  label: string; text: string; className?: string; disabled?: boolean; ariaLabel?: string; iconSrc?: string
}) {
  const [mode, setMode] = useState<'closed' | 'preview' | 'pinned'>('closed')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const trigger = useRef<HTMLButtonElement>(null)
  const triggerPointerDown = useRef<Event | null>(null)
  const clearTimer = () => { clearTimeout(timer.current); timer.current = undefined }
  useEffect(() => () => clearTimeout(timer.current), [])
  const enter = () => {
    clearTimer()
    if (!disabled && mode === 'closed') timer.current = setTimeout(() => setMode('preview'), 450)
  }
  const leave = () => {
    clearTimer()
    timer.current = setTimeout(() => setMode(current => current === 'preview' ? 'closed' : current), 150)
  }
  return <Popover.Root open={mode !== 'closed'} onOpenChange={open => {
    clearTimer()
    setMode(open ? 'pinned' : 'closed')
  }}>
    <Popover.Trigger asChild>
      <button ref={trigger} type="button" className={className} disabled={disabled} aria-label={ariaLabel}
        onPointerDown={event => { triggerPointerDown.current = event.nativeEvent }}
        // Bubbling over/out events also work when entering a portal in a ShadowRoot.
        // React's synthesized enter/leave can miss that boundary crossing.
        onPointerOver={event => {
          if (event.pointerType !== 'touch' && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) enter()
        }} onPointerOut={event => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) leave()
        }}
        onClick={event => {
          // Radix normally toggles; an already visible hover preview must instead become pinned.
          event.preventDefault()
          clearTimer()
          setMode(current => current === 'pinned' ? 'closed' : 'pinned')
        }}>{iconSrc ? <img src={iconSrc} alt="" draggable={false} /> : label}</button>
    </Popover.Trigger>
    <Popover.Portal>
      <PopoverContent className="ui-popover ui-details-popover" side="top" align="start" sideOffset={7} collisionPadding={12}
        role={mode === 'pinned' ? 'dialog' : 'tooltip'} aria-label={ariaLabel ?? label}
        onPointerOver={clearTimer} onPointerOut={event => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) leave()
        }}
        onPointerDown={() => { clearTimer(); setMode('pinned') }}
        onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => {
          // Shadow events are retargeted; deferred pointer dismissal has also lost composedPath().
          const original = event.detail.originalEvent
          if (original === triggerPointerDown.current || (trigger.current && original.composedPath().includes(trigger.current))) event.preventDefault()
        }}
        onEscapeKeyDown={() => trigger.current?.focus()}>
        {text}
      </PopoverContent>
    </Popover.Portal>
  </Popover.Root>
}
