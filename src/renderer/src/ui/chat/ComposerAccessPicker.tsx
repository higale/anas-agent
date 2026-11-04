import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Shield, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropdownMenuContent, DropdownMenuRoot } from '../DropdownMenuShell'
import type { AgentAccessMode } from '@shared/agentTypes'

interface ComposerAccessPickerProps {
  modal?: boolean
  disabled: boolean
  accessMode: AgentAccessMode
  onChange(accessMode: AgentAccessMode): void
}

export function ComposerAccessPicker({
  modal,
  disabled,
  accessMode,
  onChange
}: ComposerAccessPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const slot = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const labelId = useId()
  const keyboardOpened = useRef(false)
  const key = accessMode === 'full_access' ? 'access_full' : `access_${accessMode}`
  const label = t(`chat.${key}`)
  const tooltip = t('chat.access_mode_current', { mode: label })

  useLayoutEffect(() => {
    const container = slot.current, trigger = button.current
    if (!container || !trigger) return
    // The flex slot owns the remaining toolbar width, independently of the visible label.
    const fit = () => {
      const available = container.getBoundingClientRect().width
      if (!available) return
      trigger.removeAttribute('data-icon-only')
      trigger.toggleAttribute('data-icon-only', trigger.getBoundingClientRect().width > available)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    observer.observe(trigger)
    return () => observer.disconnect()
  }, [modal, label])

  function select(nextAccessMode: AgentAccessMode): void {
    setOpen(false)
    window.requestAnimationFrame(() => onChange(nextAccessMode))
  }

  const trigger = (
    <DropdownMenu.Trigger asChild>
      <button
        ref={button}
        className={`composer-access-trigger${accessMode === 'full_access' ? ' composer-access-trigger-full' : ''}`}
        type="button"
        disabled={disabled}
        aria-label={t('chat.access_mode')}
        aria-describedby={labelId}
        data-tooltip={open ? undefined : tooltip}
        onKeyDown={() => { keyboardOpened.current = true }}
        onPointerDown={() => { keyboardOpened.current = false }}
        onMouseDown={modal ? undefined : event => event.preventDefault()}
      >
        {accessMode === 'full_access'
          ? <ShieldCheck size={14} />
          : accessMode === 'strict_approval'
            ? <ShieldQuestion size={14} />
            : <Shield size={14} />}
        <span id={labelId}>{label}</span>
        <ChevronDown size={12} />
      </button>
    </DropdownMenu.Trigger>
  )

  return (
    <DropdownMenuRoot modal={modal} open={open} onOpenChange={setOpen}>
      {modal ? trigger : <span ref={slot} className="composer-access-slot">{trigger}</span>}
      <DropdownMenu.Portal>
        <DropdownMenuContent
          restoreFocus={modal || keyboardOpened.current}
          className="composer-access-menu ui-menu ui-menu-list"
          side="top"
          align="start"
          sideOffset={7}
          collisionPadding={10}
        >
          <DropdownMenu.Label className="composer-access-menu-label">
            {t('chat.access_mode')}
          </DropdownMenu.Label>
          <DropdownMenu.Item
            className="composer-access-item ui-menu-item ui-menu-item-row"
            onSelect={() => select('strict_approval')}
          >
            <ShieldQuestion size={16} />
            <span className="ui-copy-stack">
              <strong>{t('chat.access_strict_approval')}</strong>
              <small>{t('chat.access_strict_approval_hint')}</small>
            </span>
            {accessMode === 'strict_approval' && <Check className="composer-access-check" size={15} />}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="composer-access-item ui-menu-item ui-menu-item-row"
            onSelect={() => select('smart_approval')}
          >
            <Shield size={16} />
            <span className="ui-copy-stack">
              <strong>{t('chat.access_smart_approval')}</strong>
              <small>{t('chat.access_smart_approval_hint')}</small>
            </span>
            {accessMode === 'smart_approval' && <Check className="composer-access-check" size={15} />}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="composer-access-item composer-access-item-full ui-menu-item ui-menu-item-row"
            onSelect={() => select('full_access')}
          >
            <ShieldCheck size={16} />
            <span className="ui-copy-stack">
              <strong>{t('chat.access_full')}</strong>
              <small>{t('chat.access_full_hint')}</small>
            </span>
            {accessMode === 'full_access' && <Check className="composer-access-check" size={15} />}
          </DropdownMenu.Item>
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}
