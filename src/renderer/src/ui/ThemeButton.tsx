import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from './DropdownMenuShell'
import { normalizeTheme, themeOptions, type ThemeMode } from './theme'
import { useTitlebarMenuPosition } from './floatingViewport'

export function ThemeButton({ value, resolvedTheme, onChange }: {
  value?: string
  resolvedTheme: 'light' | 'dark'
  onChange(theme: ThemeMode): void | Promise<void>
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuPosition = useTitlebarMenuPosition(buttonRef)
  const theme = normalizeTheme(value)
  const index = themeOptions.findIndex(option => option.value === theme)
  const { Icon, label } = themeOptions[index]
  const title = `${t('settings.theme')}: ${t(label)}`
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark'
  const hint = t('settings.theme_titlebar_hint', {
    current: t(`settings.theme_${resolvedTheme}`), next: t(`settings.theme_${nextTheme}`)
  })
  function toggleTheme() {
    setMenuOpen(false)
    void onChange(nextTheme)
  }
  return <DropdownMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
    <DropdownMenuTrigger asChild
      onPointerDown={event => event.preventDefault()}
      onContextMenu={event => { event.preventDefault(); setMenuOpen(true) }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); setMenuOpen(true)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); toggleTheme()
        }
      }}>
      <button ref={buttonRef} type="button" className="ui-tool-button ui-tool-button-square" data-app-context-menu
        aria-label={title} data-tooltip={`${title}\n${hint}`}
        onClick={toggleTheme}>
        <Icon size={18} />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenu.Portal>
      <DropdownMenuContent className="ui-menu ui-menu-list" {...menuPosition}>
        <DropdownMenu.RadioGroup value={theme} onValueChange={next => void onChange(normalizeTheme(next))}>
          {themeOptions.map(({ value, label, Icon }) => <DropdownMenu.RadioItem
            key={value} value={value} className="ui-menu-item ui-menu-item-row">
            <Icon size={16} /><span>{t(label)}</span>
            <DropdownMenu.ItemIndicator className="ui-push-end"><Check size={14} /></DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenuContent>
    </DropdownMenu.Portal>
  </DropdownMenuRoot>
}
