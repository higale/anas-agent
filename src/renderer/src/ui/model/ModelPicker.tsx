import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Eye, FileText, Settings2, Star, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { findProviderModelConfig, isSelectableModelConfig, resolveProviderModelConfig } from '@shared/modelConfig'
import type { ModelProviderConfig, ResolvedModelConfig } from '@shared/types'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { NoFocusButton } from '../NoFocusButton'
import { ModelParameterPresetBadge } from './ModelParameterPresetBadge'
import { ProviderIcon } from './ProviderIcon'
import { providerProtocolLabel } from './providerProtocol'

interface ModelPickerProps {
  providers: ModelProviderConfig[] | undefined
  selectedId?: string
  emptyLabel?: string
  clearLabel?: string
  defaultModelId?: string
  disabled: boolean
  focusRef?: RefObject<HTMLElement | null>
  modal?: boolean
  onOpenModelSettings?(): void | Promise<void>
  onClear?(): void
  onSelect(modelConfigId: string): void | Promise<void>
  onSetDefault?(modelConfigId: string | null): void | Promise<void>
}

interface ModelContextMenuState {
  left: number
  modelConfigId: string
  top: number
  trigger: HTMLElement
}

const modelContextMenuWidth = 148
const modelContextMenuHeight = 44

export function ModelPicker({
  providers: configuredProviders,
  selectedId,
  emptyLabel,
  clearLabel,
  defaultModelId,
  disabled,
  focusRef,
  modal = false,
  onOpenModelSettings,
  onClear,
  onSelect,
  onSetDefault
}: ModelPickerProps) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [activeProviderId, setActiveProviderId] = useState<string>()
  const [contextMenu, setContextMenu] = useState<ModelContextMenuState | undefined>()
  const contextActionRef = useRef<HTMLButtonElement>(null)
  const Trigger = focusRef ? DropdownMenuTrigger : DropdownMenu.Trigger
  const TriggerButton = focusRef ? NoFocusButton : 'button'
  const selectedModelItemRef = useRef<HTMLDivElement>(null)
  const activeProviderItemRef = useRef<HTMLDivElement>(null)
  const modelListRef = useRef<HTMLDivElement>(null)
  const providers = useMemo(
    () => configuredProviders?.map((provider) => ({
      provider,
      models: provider.models
        .map((model) => resolveProviderModelConfig(provider, model))
        .filter(isSelectableModelConfig)
    })).filter((group) => group.models.length > 0) ?? [],
    [configuredProviders]
  )
  const activeProvider = providers.find(({ provider }) => provider.id === activeProviderId) ?? providers[0]
  const selectedModel = findProviderModelConfig(configuredProviders ?? [], selectedId)
  const selectedModelIsDefault = Boolean(selectedModel && selectedModel.id === defaultModelId)
  const label = selectedId && (!selectedModel || !isSelectableModelConfig(selectedModel))
    ? t('chat.model_unavailable')
    : selectedModel?.displayName.trim() || selectedModel?.model.trim() || emptyLabel || t('chat.select_model')
  const compactTokens = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
  function modelSummary(model: ResolvedModelConfig, location: 'trigger' | 'item'): string {
    const name = model.displayName.trim() || model.model.trim()
    const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language)
    const state = (enabled: boolean) => t(enabled ? 'common.on' : 'common.off')
    return [
      ...(location === 'trigger' ? [t('chat.model_summary_provider', { provider: model.providerName })] : []),
      t('chat.model_summary_protocol', { protocol: providerProtocolLabel(model.protocol) }),
      ...(location === 'trigger' ? [t('chat.model_summary_name', { name })] : []),
      ...(name !== model.model.trim() ? [t('chat.model_summary_id', { id: model.model })] : []),
      t('chat.model_summary_limits', {
        context: number.format(model.maxContextTokens),
        output: model.maxOutputTokens > 0 ? number.format(model.maxOutputTokens) : t('chat.model_summary_output_unset')
      }),
      model.contextCompressionEnabled
        ? t('chat.model_summary_compression_on', { percent: number.format(Math.round(model.contextCompressionThreshold * 100)) })
        : t('chat.model_summary_compression_off'),
      t('chat.model_summary_capabilities', {
        stream: state(model.stream), vision: state(model.capabilities.vision), tools: state(model.capabilities.toolUse)
      })
    ].join('\n')
  }

  const summary = selectedModel && isSelectableModelConfig(selectedModel) ? modelSummary(selectedModel, 'trigger') : label

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
    setContextMenu(undefined)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      activeProviderItemRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      selectedModelItemRef.current?.scrollIntoView?.({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeProvider?.provider.id, open, selectedModel?.id])

  function select(modelConfigId: string): void {
    setOpen(false)
    window.requestAnimationFrame(() => void onSelect(modelConfigId))
  }

  function setDefault(event: Event): void {
    event.preventDefault()
    if (!selectedModel) return
    window.requestAnimationFrame(() => void onSetDefault?.(selectedModelIsDefault ? null : selectedModel.id))
  }

  function openContextMenu(event: ReactMouseEvent<HTMLElement>, modelConfigId: string): void {
    event.preventDefault()
    event.stopPropagation()
    const menu = event.currentTarget.closest('.composer-model-menu')
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    setContextMenu({
      left: Math.max(0, Math.min(event.clientX - bounds.left, bounds.width - modelContextMenuWidth)),
      modelConfigId,
      top: Math.max(0, Math.min(event.clientY - bounds.top, bounds.height - modelContextMenuHeight)),
      trigger: event.currentTarget
    })
    window.requestAnimationFrame(() => contextActionRef.current?.focus())
  }

  function closeContextMenu(restoreFocus = false): void {
    if (restoreFocus) contextMenu?.trigger.focus()
    setContextMenu(undefined)
  }

  return (
    <DropdownMenuRoot
      modal={modal}
      open={open && !disabled}
      onOpenChange={(nextOpen) => {
        if (disabled && nextOpen) return
        setOpen(nextOpen)
        setActiveProviderId(nextOpen
          ? providers.some(({ provider }) => provider.id === selectedModel?.providerId)
            ? selectedModel?.providerId
            : providers[0]?.provider.id
          : undefined)
        if (!nextOpen) setContextMenu(undefined)
      }}
    >
      <Trigger asChild disabled={disabled}>
        <TriggerButton
          className="composer-model-trigger composer-model-segment"
          type="button"
          disabled={disabled}
          aria-label={t('chat.select_model')}
          data-tooltip={open ? undefined : summary}
        >
          <span className="ui-truncate">{label}</span>
        </TriggerButton>
      </Trigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          restoreFocus={!focusRef}
          className="composer-model-menu ui-menu ui-menu-list"
          side="top"
          align="center"
          sideOffset={7}
          collisionPadding={10}
          onPointerDownCapture={(event) => {
            if (contextMenu && event.target instanceof Element && !event.target.closest('.composer-model-context-menu')) {
              setContextMenu(undefined)
            }
          }}
          onKeyDownCapture={(event) => {
            if (contextMenu && event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeContextMenu(true)
            }
          }}
          onCloseAutoFocus={(event) => {
            if (!focusRef) return
            event.preventDefault()
            focusRef.current?.focus()
          }}
        >
          {onClear && (
            <DropdownMenu.RadioGroup value={selectedModel?.id ?? ''}>
              <DropdownMenu.RadioItem
                className={`composer-model-item ui-list-item ui-menu-item ui-menu-item-row${!selectedModel ? ' ui-list-item-active active' : ''}`}
                value=""
                onSelect={() => {
                  setOpen(false)
                  window.requestAnimationFrame(onClear)
                }}
              >
                {clearLabel ?? t('chat.clear_model_selection')}
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          )}
          {providers.length === 0 ? (
            <DropdownMenu.Item className="composer-model-empty ui-menu-item ui-menu-item-row" disabled>
              {t('chat.no_available_models')}
            </DropdownMenu.Item>
          ) : (
            <div className="composer-model-columns">
              <DropdownMenu.Group className="composer-model-providers composer-model-options">
                {providers.map(({ provider, models }) => {
                  const active = provider.id === activeProvider?.provider.id
                  return (
                    <DropdownMenu.Item
                      ref={active ? activeProviderItemRef : undefined}
                      key={provider.id}
                      className={`composer-model-provider-label ui-list-item-split ui-list-item ui-menu-item${active ? ' ui-list-item-active active' : ''}`}
                      aria-current={active ? true : undefined}
                      aria-label={provider.name}
                      onSelect={(event) => {
                        event.preventDefault()
                        setActiveProviderId(provider.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowRight') return
                        event.preventDefault()
                        event.stopPropagation()
                        setActiveProviderId(provider.id)
                        window.requestAnimationFrame(() => {
                          const list = modelListRef.current
                          const item = list?.querySelector<HTMLElement>('[role="menuitemradio"][data-state="checked"]')
                            ?? list?.querySelector<HTMLElement>('[role="menuitemradio"]')
                          item?.focus()
                        })
                      }}
                    >
                      <span className="model-list-item-main">
                        <span className="provider-icon-badge">
                          <ProviderIcon iconData={provider.iconData} />
                        </span>
                        <span className="ui-copy-stack">
                          <strong>{provider.name}</strong>
                          <small className="ui-list-item-meta">{providerProtocolLabel(provider.protocol)}</small>
                        </span>
                      </span>
                      <span className="model-list-item-badges ui-list-item-meta">{models.length}</span>
                    </DropdownMenu.Item>
                  )
                })}
              </DropdownMenu.Group>
              <DropdownMenu.RadioGroup
                ref={modelListRef}
                key={activeProvider?.provider.id}
                className="composer-model-models composer-model-options"
                aria-label={activeProvider?.provider.name}
                value={selectedModel?.id ?? ''}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft') return
                  event.preventDefault()
                  event.stopPropagation()
                  activeProviderItemRef.current?.focus()
                }}
              >
                {activeProvider?.models.map((model) => (
                  <DropdownMenu.RadioItem
                    ref={model.id === selectedModel?.id ? selectedModelItemRef : undefined}
                    key={model.id}
                    value={model.id}
                    className={`composer-model-item ui-list-item ui-menu-item ui-menu-item-row${model.id === selectedModel?.id ? ' ui-list-item-active active' : ''}`}
                    aria-label={model.displayName.trim() || model.model.trim()}
                    aria-description={modelSummary(model, 'item')}
                    data-app-context-menu={onSetDefault ? true : undefined}
                    onContextMenu={onSetDefault ? (event) => openContextMenu(event, model.id) : undefined}
                    onSelect={() => select(model.id)}
                  >
                    <span className="composer-model-name ui-copy-stack">
                      <span className="ui-row">
                        <span className="composer-model-name ui-truncate">
                          {model.displayName.trim() || model.model.trim()}
                        </span>
                        {model.id === defaultModelId && (
                          <span
                            className="composer-model-default-marker"
                            aria-hidden="true"
                            data-tooltip={t('chat.default_model')}
                          >
                            <Star size={13} fill="currentColor" />
                          </span>
                        )}
                      </span>
                      <small className="composer-model-details ui-row">
                        <span className="ui-truncate">
                          {compactTokens.format(model.maxContextTokens)} · {model.maxOutputTokens > 0 ? compactTokens.format(model.maxOutputTokens) : '—'}
                          {' · '}{model.contextCompressionEnabled ? `${Math.round(model.contextCompressionThreshold * 100)}%` : '—'}
                        </span>
                        <span className="composer-model-capabilities ui-row">
                          {[
                            { Icon: FileText, label: t('chat.model_non_streaming'), visible: !model.stream },
                            { Icon: Eye, label: `${t('settings.model_capability_vision')}: ${t('common.on')}`, visible: model.capabilities.vision },
                            { Icon: Wrench, label: `${t('settings.model_capability_tool_use')}: ${t('common.on')}`, visible: model.capabilities.toolUse }
                          ].filter(({ visible }) => visible).map(({ Icon, label }) => (
                            <span
                              key={label}
                              className="ui-status-icon"
                              aria-label={label}
                              data-tooltip={contextMenu ? undefined : label}
                            >
                              <Icon size={13} aria-hidden="true" />
                            </span>
                          ))}
                          <ModelParameterPresetBadge
                            mode={model.parameterPresetMode}
                            presetCount={model.parameterPresets?.length ?? 0}
                          />
                        </span>
                      </small>
                    </span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </div>
          )}
          {(onOpenModelSettings || onSetDefault) && <>
            <DropdownMenu.Separator className="ui-menu-separator" />
            <div className="composer-model-footer">
              {onOpenModelSettings && <DropdownMenu.Item
                className="composer-model-settings ui-menu-item ui-menu-item-row"
                onSelect={() => void onOpenModelSettings()}
              >
                <Settings2 size={15} />
                <span>{t('chat.model_settings')}</span>
              </DropdownMenu.Item>}
              {onSetDefault && <DropdownMenu.Item
                className="composer-model-default ui-menu-item ui-menu-item-row"
                disabled={!selectedModel}
                onSelect={setDefault}
              >
                <Star size={15} fill={selectedModelIsDefault ? 'currentColor' : 'none'} />
                <span>{t(selectedModelIsDefault ? 'chat.clear_default_model' : 'chat.set_default_model')}</span>
              </DropdownMenu.Item>}
            </div>
          </>}
          {contextMenu && onSetDefault && (() => {
            const modelIsDefault = contextMenu.modelConfigId === defaultModelId
            return (
              <div
                className="composer-model-context-menu ui-menu ui-menu-list"
                role="menu"
                tabIndex={-1}
                aria-label={t(modelIsDefault ? 'chat.clear_default_model' : 'chat.set_default_model')}
                style={{ left: contextMenu.left, top: contextMenu.top }}
                onContextMenu={(event) => event.preventDefault()}
              >
                <NoFocusButton
                  ref={contextActionRef}
                  className="ui-menu-item ui-menu-item-row"
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation()
                    setContextMenu(undefined)
                    void onSetDefault(modelIsDefault ? null : contextMenu.modelConfigId)
                  }}
                >
                  <Star size={15} fill={modelIsDefault ? 'currentColor' : 'none'} />
                  <span>{t(modelIsDefault ? 'chat.clear_default_model' : 'chat.set_default_model')}</span>
                </NoFocusButton>
              </div>
            )
          })()}
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}
