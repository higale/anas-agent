import { PopoverContent } from '../PopoverContent'
import * as Popover from '@radix-ui/react-popover'
import { lazy, Suspense, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_PROJECT_ICON, PROJECT_ICON_COLORS, PROJECT_ICON_NAMES } from '@shared/projectAppearance'
import type { ProjectIconColor, ProjectIconName } from '@shared/types'
import { useIconUpload } from '../useIconUpload'
import { dataTransferHasFiles } from '../dragDrop'
import { ProjectIcon } from './ProjectIcon'
import { ProjectIconGrid } from './ProjectIconGrid'
import { SegmentedControl } from '../SegmentedControl'

const ProjectEmojiPicker = lazy(() => import('./ProjectEmojiPicker'))

interface ProjectAppearancePickerProps {
  disabled: boolean
  onPendingChange(pending: boolean): void
  iconData?: string
  onChangeImage(data?: string): void
  emoji?: string
  onChangeEmoji(emoji?: string): void
  color?: ProjectIconColor
  icon?: ProjectIconName
  onChangeColor(color?: ProjectIconColor): void
  onChangeIcon(icon: ProjectIconName): void
}

export function ProjectAppearancePicker({
  disabled,
  onPendingChange,
  color,
  icon,
  iconData,
  emoji,
  onChangeImage,
  onChangeEmoji,
  onChangeColor,
  onChangeIcon
}: ProjectAppearancePickerProps) {
  const { t } = useTranslation()
  const upload = useIconUpload(t('project.upload_icon'), data => {
    onChangeEmoji(undefined)
    onChangeImage(data)
  }, onPendingChange)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'emoji' | 'icon'>(emoji && !iconData ? 'emoji' : 'icon')
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)

  return (
    <Popover.Root modal open={open} onOpenChange={next => {
      setOpen(next)
      if (next) { setMode(emoji && !iconData ? 'emoji' : 'icon'); setQuery('') }
    }}>
      <Popover.Trigger asChild>
        <button
          className="ui-dialog-icon project-appearance-trigger"
          type="button"
          disabled={disabled}
          aria-label={t('project.choose_icon')}
          title={t('project.icon_hint')}
          data-drag-active={(upload.dragActive && !disabled) || undefined}
          onDragOver={(event) => {
            if (!dataTransferHasFiles(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
            if (!disabled) upload.buttonProps.onDragOver(event)
          }}
          onDragLeave={upload.buttonProps.onDragLeave}
          onDrop={(event) => {
            event.preventDefault()
            event.stopPropagation()
            upload.buttonProps.onDragLeave()
            if (!disabled) upload.buttonProps.onDrop(event)
          }}
        >
          <ProjectIcon iconData={iconData} emoji={emoji} color={color} icon={icon} size={18} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <PopoverContent
          className="project-appearance-popover ui-popover"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={event => { if (search.current) { event.preventDefault(); search.current.focus() } }}
        >
          <SegmentedControl ariaLabel={t('project.icon_type')} value={mode} disabled={disabled}
            onChange={value => { setMode(value); setQuery('') }} options={[
              { value: 'emoji', label: t('project.emoji') }, { value: 'icon', label: t('project.icon_tab') }
            ]} />
          {mode === 'emoji' && <input ref={search} className="ui-input" type="search" value={query} disabled={disabled}
            aria-label={t('project.search_emoji')} placeholder={t('project.search_emoji')}
            onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter') event.preventDefault()
            }} />}
          {mode === 'emoji' ? <Suspense fallback={<p className="project-appearance-empty" role="status">{t('common.loading')}</p>}>
            <ProjectEmojiPicker query={query} value={!iconData ? emoji : undefined} disabled={disabled} onChange={value => {
              upload.cancelUpload()
              onChangeImage(undefined)
              onChangeEmoji(value)
            }} />
          </Suspense> : <>
            <div className="project-icon-colors" aria-label={t('project.icon_color')} role="group">
              <button
                className="project-icon-color project-icon-color-auto"
                type="button"
                aria-label={t('project.icon_color_auto')}
                disabled={disabled || Boolean(iconData || emoji)}
                aria-pressed={!iconData && !emoji && !color}
                onClick={() => onChangeColor(undefined)}
              />
              {PROJECT_ICON_COLORS.map((option) => (
                <button
                  className="project-icon-color"
                  type="button"
                  key={option}
                  aria-label={t('project.icon_color_option', { color: t(`project.color_${option}`) })}
                  disabled={disabled || Boolean(iconData || emoji)}
                  aria-pressed={!iconData && !emoji && color === option}
                  style={{ '--project-icon-option-color': `var(--project-icon-${option})` } as CSSProperties}
                  onClick={() => onChangeColor(option)}
                />
              ))}
            </div>
            <div className="project-appearance-results">
              <ProjectIconGrid label={t('project.icon')} disabled={disabled} value={!iconData && !emoji ? icon ?? DEFAULT_PROJECT_ICON : undefined}
                options={PROJECT_ICON_NAMES.map(option => ({ value: option,
                  label: t('project.icon_option', { name: t(`project.icon_names.${option}`) }),
                  content: <ProjectIcon color={color} icon={option} size={18} /> }))}
                onChange={option => { upload.cancelUpload(); onChangeImage(undefined); onChangeEmoji(undefined); onChangeIcon(option) }} />
            </div>
          </>}
          <footer className="ui-row-between project-appearance-footer">
            {upload.fileInput}
            <button className="ui-button ui-button-compact" type="button" disabled={disabled} {...upload.buttonProps}>
              {t('project.upload_icon')}
            </button>
            <Popover.Close asChild>
              <button className="ui-button ui-button-compact" type="button">{t('common.done')}</button>
            </Popover.Close>
          </footer>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  )
}
