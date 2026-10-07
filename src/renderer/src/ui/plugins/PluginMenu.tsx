import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Puzzle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pluginDisplayText, type PluginSummary } from '@shared/plugins'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'

export function PluginMenu({ plugins, onOpen }: { plugins: PluginSummary[]; onOpen(plugin: PluginSummary): void }) {
  const { t, i18n } = useTranslation()
  const enabled = plugins.filter(item => item.enabled && !item.error && item.manifest)
  if (!enabled.length) return null
  return <DropdownMenuRoot>
    <DropdownMenuTrigger asChild><button type="button" className="ui-tool-button ui-tool-button-square" aria-label={t('plugins.title')} data-tooltip={t('plugins.title')}><Puzzle size={18} /></button></DropdownMenuTrigger>
    <DropdownMenu.Portal><DropdownMenuContent className="ui-menu ui-menu-list" align="end">
      {enabled.map(item => <DropdownMenu.Item className="ui-menu-item ui-menu-item-row" key={item.id} onSelect={() => onOpen(item)}>{pluginDisplayText(item, i18n.language)}</DropdownMenu.Item>)}
    </DropdownMenuContent></DropdownMenu.Portal>
  </DropdownMenuRoot>
}
