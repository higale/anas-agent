import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useLayoutEffect, useRef, useState } from 'react'
import { FileDiff, List, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pluginDisplayText, pluginIconSources, type PluginSummary } from '@shared/plugins'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { PluginIcon } from '../plugins/PluginIcon'

export function WorkspaceMenu({ project, plugins, onOpenPlugin, onOpenPluginSettings }: {
  project?: { name: string; onOpenFiles(): void }
  plugins: PluginSummary[]; onOpenPlugin?(plugin: PluginSummary): void; onOpenPluginSettings?(): void
}) {
  const { t, i18n } = useTranslation()
  const launchable = onOpenPlugin ? plugins.filter(item => item.enabled && !item.error && item.manifest?.ui) : []
  const shortcuts = launchable.filter(item => item.showInTitlebar)
  const container = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const [layout, setLayout] = useState({ width: undefined as number | undefined, count: Infinity })
  const shortcutCount = shortcuts.length
  useLayoutEffect(() => {
    const element = container.current, button = menuButton.current
    if (!element || !button) return
    const update = () => {
      const size = button.getBoundingClientRect().width
      if (!size) return
      const gap = parseFloat(getComputedStyle(element).columnGap) || 0
      const width = (shortcutCount + 1) * (size + gap) - gap
      const count = Math.max(0, Math.min(shortcutCount, Math.floor((element.clientWidth + gap + 0.5) / (size + gap)) - 1))
      setLayout(previous => previous.width === width && previous.count === count ? previous : { width, count })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    observer.observe(button)
    return () => observer.disconnect()
  }, [shortcutCount])
  return <div ref={container} className="workspace-launcher ui-row ui-row-tight" style={{ width: layout.width }}>
    {shortcuts.slice(0, layout.count).map(item => {
      const name = pluginDisplayText(item, i18n.language)
      return <button type="button" key={item.id} className="ui-tool-button ui-tool-button-square"
        aria-label={name} data-tooltip={name} onClick={() => onOpenPlugin?.(item)}>
        <PluginIcon icon={pluginIconSources(item.id, item.manifest?.icon)} size={18} />
      </button>
    })}
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild><button ref={menuButton} type="button" className="ui-tool-button ui-tool-button-square"
        aria-label={t('agent.workspace_menu')} data-tooltip={t('agent.workspace_menu')}><List size={18} /></button></DropdownMenuTrigger>
      <DropdownMenu.Portal><DropdownMenuContent className="workspace-menu ui-menu ui-menu-list" align="end">
        {project && <DropdownMenu.Group className="ui-menu-group" aria-label={project.name}>
          <div className="ui-menu-group-heading"><DropdownMenu.Label className="ui-truncate" data-tooltip={project.name}>{project.name}</DropdownMenu.Label></div>
          <DropdownMenu.Item className="ui-menu-item ui-menu-item-row" onSelect={project.onOpenFiles}>
            <FileDiff size={16} /><span>{t('agent.file_changes')}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Group>}
        {project && onOpenPluginSettings && <DropdownMenu.Separator className="ui-menu-separator" />}
        {onOpenPluginSettings && <DropdownMenu.Group className="ui-menu-group" aria-label={t('plugins.title')}>
          <div className="ui-menu-group-heading">
            <DropdownMenu.Label className="ui-truncate">{t('plugins.title')}</DropdownMenu.Label>
            <DropdownMenu.Item asChild onSelect={onOpenPluginSettings}>
              <button type="button" className="ui-tool-button ui-tool-button-small ui-menu-item"
                aria-label={t('plugins.manage')} data-tooltip={t('plugins.manage')}><Settings size={16} /></button>
            </DropdownMenu.Item>
          </div>
          {launchable.map(item => <DropdownMenu.Item className="ui-menu-item ui-menu-item-row" key={item.id} onSelect={() => onOpenPlugin?.(item)}>
            <PluginIcon icon={pluginIconSources(item.id, item.manifest?.icon)} /><span className="ui-truncate">{pluginDisplayText(item, i18n.language)}</span>
          </DropdownMenu.Item>)}
        </DropdownMenu.Group>}
      </DropdownMenuContent></DropdownMenu.Portal>
    </DropdownMenuRoot>
  </div>
}
