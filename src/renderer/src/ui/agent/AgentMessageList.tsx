import type { AgentModelRetryState } from '@shared/agentTypes'
import {
  Activity,
  AudioLines,
  Brain,
  Braces,
  Check,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Clock,
  Copy,
  FileText,
  Globe,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  Pencil,
  RotateCcw,
  ShieldAlert,
  Terminal,
  Trash2,
  Wrench
} from 'lucide-react'
import { memo, type ReactNode, type RefObject, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NoFocusButton } from '../NoFocusButton'
import type {
  AgentContentBlock,
  AgentContextSummary,
  AgentMessage,
  AgentRunActivity,
  AgentToolCall
} from '@shared/agentTypes'
import { isCommandShellToolName } from '@shared/commandShell'
import {
  delegationToolForSubagent,
  subagentDescription,
  toolArgumentSummary,
  visibleToolsForAgent
} from '@shared/agentActivity'
import {
  projectRunActivityItems,
  projectTurnTimeline,
  type TurnTimelineActivityItem,
  type TurnTimelineActivityRange,
  type TurnTimelineCleanupItem
} from '@shared/agentTimeline'
import type { SelectedAttachment } from '@shared/types'
import { AttachmentGrid } from '../chat/AttachmentGrid'
import { ScrollBoundaryControls, useScrollBoundaryNavigation } from '../chat/ScrollBoundaryNavigation'
import { FollowOutputContext } from '../chat/followOutput'
import { MarkdownText } from '../chat/MarkdownText'
import { ImageLightbox } from '../chat/ImageLightbox'
import { toolResultImages } from './toolResultImages'
import { CodeReviewResult } from './CodeReviewResult'
import {
  AgentSubagentActivityTrigger,
  AgentSubagentStatusIcon,
  subagentStatusLabel
} from './AgentSubagentActivityDock'
import type { AgentRunView } from './useAgentWorkspace'
import type { AgentSpeechState } from '../speech/useAgentSpeech'
import { notice } from '../notice'
import { localizeAgentError } from './agentErrorMessage'
import { usePanelDisclosure, usePanelRef, usePanelScroll } from './PanelViewState'
import { ActivityDetail } from './ActivityDetail'
import { VirtualTimeline, type TimelineRow } from '../chat/VirtualTimeline'
import { DelayedLoading } from '../DelayedLoading'
import { useActivityDirectories } from './useActivityDirectories'
import { ActivityDirectoryStore, directoryScopeKey, type DirectoryScope } from './activityDirectoryStore'
import { activityAtomsFromItems, ActivityGroupBuilder, compareActivityPositions, isProcessAtom, type ActivityGroup, type ActivityViewItem } from '@shared/activityView'
import { CodeFileEditor, largeTextThreshold } from '../CodeFileEditor'
import type { AgentActivityDetailReference, AgentActivityDetail } from '@shared/agentTypes'
import { ActivityPreferences } from './ActivityPreferences'
import { scopeIsRunning, useActivityDisclosures, type ActivityDisclosures } from './useActivityDisclosures'
import { RoundChangesButton, useRoundChangeAvailability } from './RoundChangesButton'
import type { RoundChangeAvailabilityStore } from './roundChangeAvailabilityStore'

interface AgentMessageListProps {
  onOpenChanges?(runId: string): void
  title: string
  navigationKey?: string
  messages: AgentMessage[]
  activities: AgentRunActivity[]
  run?: AgentRunView
  panelRef: RefObject<HTMLElement | null>
  followOutputRef: RefObject<boolean>
  error?: string
  modelRetries?: AgentModelRetryState[]
  onRetryModel?(retry: AgentModelRetryState, withholdToolResults: boolean): Promise<void>
  speech: AgentSpeechState
  earlierMessageCount?: number
  onOpenSubagent?(runId: string, subagentId: string): void
  onDeleteRound?(userMessageId: string): void
  onEditUserMessage?(message: AgentMessage): void
  onRegenerate?(userMessageId: string, action: 'regenerate' | 'resend'): void
  onLoadEarlier?(request: { threadId: string; signal: AbortSignal }): void | Promise<void>
  onLoadEarlierError?(threadId: string, error: string): void
  onSpeak(messageId: string, text: string): void | Promise<void>
}

function textContent(content: AgentContentBlock[]): string {
  return content
    .filter((block): block is Extract<AgentContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const now = new Date()
  const pad = (part: number): string => String(part).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  if (sameDay) return clock

  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${clock}`
    : `${date.getFullYear()}-${day} ${clock}`
}

export function formatCompactTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) {
    const scaled = value / 1_000
    return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}k`
  }
  const scaled = value / 1_000_000
  return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}m`
}

export function messageRetryAction(role: 'assistant' | 'user'): 'regenerate' | 'resend' {
  return role === 'user' ? 'resend' : 'regenerate'
}

function imageAttachments(content: AgentContentBlock[]): SelectedAttachment[] {
  return content.flatMap((block, index) => {
    if (block.type !== 'image') return []
    const mimeType = block.mimeType ?? 'image/png'
    const path = block.path ?? ''
    const name = path.split(/[\\/]/).pop() || `image-${index + 1}`
    return [{
      path,
      name,
      size: block.data ? Math.floor(block.data.length * 0.75) : 0,
      kind: 'image' as const,
      mimeType,
      contextPolicy: 'one_turn' as const,
      dataUri: block.data ? `data:${mimeType};base64,${block.data}` : undefined,
      url: block.url
    }]
  })
}

function ContentBlocks({ message }: { message: AgentMessage }) {
  const { t } = useTranslation()
  const text = textContent(message.content)
  const archivedAttachments: SelectedAttachment[] = (message.attachments ?? []).map(
    (attachment) => ({
      path: attachment.path,
      name: attachment.name,
      size: attachment.size,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      contextPolicy: attachment.contextPolicy,
      truncated: attachment.textTruncated,
      skippedReason: attachment.available
        ? undefined
        : t('chat.attachment_file_unavailable')
    })
  )
  const attachments = archivedAttachments.length > 0
    ? archivedAttachments
    : imageAttachments(message.content)
  const media = message.content.filter(
    (block) => block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'image'
  )

  return (
    <>
      {message.codeReview ? <CodeReviewResult review={message.codeReview} /> : text && (message.role === 'assistant'
        ? <MarkdownText text={text} />
        : <p data-native-context-menu="text">{text}</p>)}
      <AttachmentGrid attachments={attachments} mode="message" />
      {media.map((block, index) => {
        if (block.type === 'file') {
          return (
            <div className="agent-file" key={index}>
              <FileText size={15} />
              <span>{block.name || t('agent.file')}</span>
            </div>
          )
        }
        return (
          <details className="agent-json" key={index}>
            <summary tabIndex={-1} onMouseDown={(event) => event.preventDefault()}>{t('agent.data')}</summary>
            <div className="native-context-menu-text" data-native-context-menu="text">
              <pre>{JSON.stringify(block.value, null, 2)}</pre>
            </div>
          </details>
        )
      })}
    </>
  )
}

function MessageItem({
  message,
  roundUserMessageId,
  actionsDisabled,
  speech,
  onDeleteRound,
  onEditUserMessage,
  onRegenerate,
  onSpeak,
  onOpenChanges,
  changeAvailability
}: {
  onOpenChanges?(runId: string): void
  changeAvailability?: RoundChangeAvailabilityStore
  message: AgentMessage
  roundUserMessageId?: string
  actionsDisabled: boolean
  speech: AgentSpeechState
  onDeleteRound?(userMessageId: string): void
  onEditUserMessage?(message: AgentMessage): void
  onRegenerate?(userMessageId: string, action: 'regenerate' | 'resend'): void
  onSpeak(messageId: string, text: string): void | Promise<void>
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current)
  }, [])
  const copyMessage = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(textContent(message.content))
      setCopied(true)
      notice.success(t('chat.message_copied'))
      if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      notice.error(t('chat.failed_copy_message'))
    }
  }
  if (message.role === 'system') return null
  if (message.role === 'tool') return null
  const retryAction = messageRetryAction(message.role)
  const text = textContent(message.content)
  const canEdit = message.role === 'user' && Boolean(text && onEditUserMessage)
  const canRegenerate = Boolean(roundUserMessageId && onRegenerate)
  const canSpeak = message.role === 'assistant' && Boolean(text)
  const canCopy = Boolean(text)
  const canDelete = Boolean(roundUserMessageId && onDeleteRound)
  const canShowChanges = Boolean(message.runId && onOpenChanges)
  const hasActions = canEdit || canRegenerate || canSpeak || canCopy || canDelete || canShowChanges
  const regenerateLabel = message.role === 'user'
    ? t('common.resend')
    : t('common.regenerate')
  const speechActive = speech.messageId === message.id
    && (speech.status === 'generating' || speech.status === 'playing')
  const speechError = speech.messageId === message.id && speech.status === 'error'
  const speechLabel = speechActive
    ? t('agent.stop_speech')
    : speechError
      ? speech.error ?? t('speech.generation_failed')
      : t('agent.read_aloud')
  return (
    <div className={`message-sequence ${message.role}`} data-message-id={message.id}>
      <article className={`message-row ${message.role}`}>
        <div className="bubble ui-surface">
          <ContentBlocks message={message} />
          {(hasActions || message.createdAt) && (
            <div className="message-meta">
              {hasActions && (
                <div className="message-actions">
                  {canShowChanges && <RoundChangesButton runId={message.runId!} store={changeAvailability} onOpen={onOpenChanges!} />}
                  {canEdit && onEditUserMessage && (
                    <NoFocusButton
                      className="ui-tool-button ui-tool-button-muted"
                      type="button"
                      disabled={actionsDisabled}
                      aria-label={t('common.edit')}
                      data-tooltip={t('common.edit')}
                      onClick={() => onEditUserMessage(message)}
                    >
                      <Pencil size={15} />
                    </NoFocusButton>
                  )}
                  {canCopy && (
                    <NoFocusButton
                      className="ui-tool-button ui-tool-button-muted"
                      type="button"
                      aria-label={t('common.copy')}
                      data-tooltip={copied ? t('chat.message_copied') : t('common.copy')}
                      onClick={() => void copyMessage()}
                    >
                      {copied ? <Check size={16} /> : <Copy size={16} />}
                    </NoFocusButton>
                  )}
                  {message.role === 'assistant' && (
                    <NoFocusButton
                      className={[
                        'ui-tool-button ui-tool-button-muted',
                        speechActive ? 'active' : '',
                        speechError ? 'error' : ''
                      ].filter(Boolean).join(' ')}
                      type="button"
                      aria-label={speechLabel}
                      data-tooltip={speechLabel}
                      data-speech-status={speech.messageId === message.id ? speech.status : 'idle'}
                      onClick={() => void onSpeak(message.id, text)}
                    >
                      <AudioLines size={16} />
                    </NoFocusButton>
                  )}
                  {canRegenerate && roundUserMessageId && onRegenerate && (
                    <NoFocusButton
                      className="ui-tool-button ui-tool-button-muted"
                      type="button"
                      disabled={actionsDisabled}
                      aria-label={regenerateLabel}
                      data-tooltip={regenerateLabel}
                      onClick={() => onRegenerate(
                        roundUserMessageId,
                        retryAction
                      )}
                    >
                      <RotateCcw size={16} />
                    </NoFocusButton>
                  )}
                  {canDelete && roundUserMessageId && onDeleteRound && (
                    <NoFocusButton
                      className="ui-tool-button ui-tool-button-muted"
                      type="button"
                      disabled={actionsDisabled}
                      aria-label={t('common.delete')}
                      data-tooltip={t('common.delete')}
                      onClick={() => onDeleteRound(roundUserMessageId)}
                    >
                      <Trash2 size={16} />
                    </NoFocusButton>
                  )}
                </div>
              )}
              {message.createdAt && (
                <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
              )}
            </div>
          )}
        </div>
      </article>
    </div>
  )
}

function ContextSummaryItem({
  summary,
  number
}: {
  summary: AgentContextSummary
  number: number
}) {
  const disclosure = usePanelDisclosure(`summary:${summary.id}`, summary.status === 'running')
  const tokenLabel = summary.inputTokensBefore !== undefined && summary.inputTokensAfter !== undefined
    ? `≈ ${formatCompactTokens(summary.inputTokensBefore)} → ${formatCompactTokens(summary.inputTokensAfter)} tokens`
    : undefined
  return (
    <div className="agent-context-summary-row">
      <details className="agent-context-summary" {...disclosure}>
        <summary tabIndex={-1} onMouseDown={(event) => event.preventDefault()}>
          {summary.status === 'running'
            ? <LoaderCircle className="agent-spin" size={13} />
            : <Check size={13} />}
          <span>
            {summary.status === 'running'
              ? 'Compressing context'
              : `Context compressed #${number}`}
          </span>
          {tokenLabel && <small>· {tokenLabel}</small>}
          <time dateTime={summary.createdAt}>· {formatMessageTime(summary.createdAt)}</time>
        </summary>
        {disclosure.open && (summary.detail
          ? <ActivityDetail reference={summary.detail} field="text">{value => <MarkdownText text={String(value ?? '')} compact />}</ActivityDetail>
          : summary.summaryText && <MarkdownText text={summary.summaryText} compact />)}
      </details>
    </div>
  )
}

function formatTraceValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') {
    const source = value.trim()
    if (source[0] !== '{' && source[0] !== '[') return value
    try {
      JSON.parse(source)
      // Validate JSON, then change only structural whitespace. Reserializing
      // parsed values would alter large numbers, duplicate keys and escapes.
      const compact = source.replace(/("(?:\\.|[^"\\])*")|\s+/g, '$1')
      let depth = 0
      const newline = () => '\n' + '  '.repeat(depth)
      return compact.replace(/("(?:\\.|[^"\\])*")|[{}[\],:]/g, (token: string, quoted: string | undefined, offset: number) => {
        if (quoted) return token
        if (token === '{' || token === '[') {
          depth++
          return token + (compact[offset + 1] === '}' || compact[offset + 1] === ']' ? '' : newline())
        }
        if (token === '}' || token === ']') {
          depth--
          return (compact[offset - 1] === '{' || compact[offset - 1] === '[' ? '' : newline()) + token
        }
        return token === ',' ? ',' + newline() : ': '
      })
    } catch { return value }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function reasoningTitleSummary(reasoning: string, summary: string | undefined): string | undefined {
  const compactSummary = summary?.replace(/\s+/g, ' ').trim()
  if (!compactSummary) return undefined
  const compactReasoning = reasoning.replace(/\s+/g, ' ').trim()
  return compactSummary === compactReasoning ? '...' : compactSummary
}

function ActivityDisclosure({
  stateKey,
  icon,
  label,
  text = '',
  defaultOpen = false,
  phase,
  className = '',
  bodyClassName = '',
  statusIndicator,
  summaryActions,
  children,
  disabled = false,
  renderWhenEmpty = false,
  detail,
  field = 'text'
}: {
  stateKey: string
  icon: ReactNode
  label: ReactNode
  text?: string
  defaultOpen?: boolean
  phase?: boolean
  className?: string
  bodyClassName?: string
  statusIndicator?: ReactNode
  summaryActions?: ReactNode
  children?: ReactNode | (() => ReactNode)
  disabled?: boolean
  renderWhenEmpty?: boolean
  detail?: AgentActivityDetailReference
  field?: keyof AgentActivityDetail
}) {
  const disclosure = usePanelDisclosure(stateKey, defaultOpen, phase)
  if (!renderWhenEmpty && !detail && !text.trim() && !children) return null
  const body = !disabled && disclosure.open ? (
    <>
      {detail ? <ActivityDetail reference={detail} field={field}>{value => <ActivityTraceBody value={value} />}</ActivityDetail> : <>
      {text.trim() && (
        <div className="native-context-menu-text" data-native-context-menu="text">
          <pre>{text}</pre>
        </div>
      )}
      {typeof children === 'function' ? children() : children}
      </>}
    </>
  ) : null
  return (
    <details
      className={`agent-activity-disclosure ${className}`.trim()}
      {...disclosure}
      open={disabled ? false : disclosure.open}
    >
      <summary
        tabIndex={-1}
        aria-disabled={disabled || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => { if (disabled) event.preventDefault() }}
        onKeyDown={(event) => {
          if (disabled && (event.key === 'Enter' || event.key === ' ')) event.preventDefault()
        }}
      >
        <span className="agent-activity-summary-content">
          <span className="agent-activity-summary-icon">{icon}</span>
          <span className="agent-activity-summary-label">{label}</span>
          {statusIndicator && (
            <span className="agent-activity-summary-status">{statusIndicator}</span>
          )}
        </span>
        {!disabled && <ChevronRight className="agent-activity-disclosure-chevron" size={13} />}
        {summaryActions}
      </summary>
      {body && (bodyClassName ? <div className={bodyClassName}>{body}</div> : body)}
    </details>
  )
}

interface ToolPresentation {
  icon: ReactNode
  title: string
  codeTitle?: boolean
  showArgumentSummary?: boolean
}

function BackgroundCleanupDisclosure({ entry }: { entry: TurnTimelineCleanupItem }) {
  const { t } = useTranslation()
  const { cleanup } = entry
  const label = cleanup.status === 'completed' ? 'agent.background_cleanup_completed'
    : cleanup.status === 'unconfirmed' ? 'agent.background_cleanup_unconfirmed' : 'agent.background_cleanup'
  return (
    <ActivityDisclosure
      stateKey={entry.key}
      icon={<Info size={13} />}
      label={t(label)}
      statusIndicator={cleanup.status === 'running'
        ? <LoaderCircle className="agent-spin" size={13} role="status" aria-label={t('agent.background_cleanup_started')} />
        : undefined}
    >
      {() => <ActivityTraceBody value={localizeAgentError(cleanup.report, t)} />}
    </ActivityDisclosure>
  )
}

function specialToolPresentation(call: AgentToolCall): ToolPresentation | undefined {
  if (isCommandShellToolName(call.name)) {
    return {
      icon: <Terminal size={13} />,
      title: call.name,
      codeTitle: true,
      showArgumentSummary: true
    }
  }
  switch (call.name.toLowerCase()) {
    case 'sleep':
      return {
        icon: <Clock size={13} />,
        title: call.name,
        codeTitle: true,
        showArgumentSummary: true
      }
    case 'http_request':
      return {
        icon: <Globe size={13} />,
        title: call.name,
        codeTitle: true,
        showArgumentSummary: true
      }
    default:
      return undefined
  }
}

function toolPresentation(call: AgentToolCall): ToolPresentation {
  return specialToolPresentation(call) ?? {
    icon: <Wrench size={13} />,
    title: call.name,
    codeTitle: true,
    showArgumentSummary: true
  }
}

const ActivityTraceBody = memo(function ActivityTraceBody({ value, copyable = false, plainText = false }: {
  value: unknown; copyable?: boolean; plainText?: boolean
}) {
  const { t } = useTranslation()
  const text = useMemo(() => plainText ? String(value ?? '') : formatTraceValue(value), [value, plainText])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      notice.success(t('chat.message_copied'))
    } catch { notice.error(t('chat.failed_copy_message')) }
  }
  return <div className={copyable ? 'agent-activity-trace-body' : 'native-context-menu-text'} data-native-context-menu="text">
    {text.length >= largeTextThreshold
      ? <CodeFileEditor path={t('agent.activity_content')} content={text} /> : <pre>{text}</pre>}
    {copyable && <NoFocusButton type="button" className="agent-activity-trace-copy ui-icon-button ui-icon-button-xs"
      aria-label={t('common.copy')} data-tooltip={t('common.copy')} disabled={value === undefined}
      onClick={event => { event.stopPropagation(); void copy() }}>
      <Copy size={13} />
    </NoFocusButton>}
  </div>
})

function ToolResultDisclosure({ tool, output }: { tool: AgentRunActivity['tools'][number]; output: unknown }) {
  const { t } = useTranslation()
  const images = useMemo(() => toolResultImages(output), [output])
  const [imageIndex, setImageIndex] = useState<number>()
  const imageLabel = (index: number) => t('agent.view_tool_image', { index: index + 1 })
  return (
    <>
      <ActivityDisclosure
        stateKey={`result:${tool.call.id}`}
        className="agent-activity-result"
        icon={<CircleCheck size={13} />}
        label="result"
        renderWhenEmpty
        summaryActions={images.length > 0 && (
          <span className="ui-toolbar">
            {images.map((_, index) => (
              <button
                key={index}
                type="button"
                className="ui-icon-button ui-icon-button-xs"
                aria-label={imageLabel(index)}
                data-tooltip={imageLabel(index)}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setImageIndex(index)
                }}
              >
                <ImageIcon size={13} />
              </button>
            ))}
          </span>
        )}
      >
        {() => <ActivityTraceBody value={output} copyable />}
      </ActivityDisclosure>
      {imageIndex !== undefined && (
        <ImageLightbox
          open
          index={imageIndex}
          slides={images.map((src, index) => ({ src, alt: imageLabel(index) }))}
          onView={setImageIndex}
          onClose={() => setImageIndex(undefined)}
        />
      )}
    </>
  )
}

function sleepDeadline(tool: AgentRunActivity['tools'][number]): number | undefined {
  if (tool.call.name !== 'sleep' || !tool.startedAt || tool.completedAt) return undefined
  const args = tool.call.args
  if (!args || typeof args !== 'object' || !('seconds' in args)) return undefined
  const seconds = args.seconds
  const startedAt = Date.parse(tool.startedAt)
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > 300 || !Number.isFinite(startedAt)) return undefined
  return startedAt + seconds * 1000
}

function SleepCountdown({ deadline }: { deadline: number }) {
  const { t } = useTranslation()
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
  useEffect(() => {
    const update = () => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setRemaining(seconds)
      if (seconds === 0) window.clearInterval(timer)
    }
    const timer = window.setInterval(update, 1000)
    update()
    return () => window.clearInterval(timer)
  }, [deadline])
  return <small className="agent-sleep-countdown" role="timer" aria-live="off">
    {remaining > 0 ? t('agent.sleep_remaining', { seconds: remaining }) : t('agent.sleep_finishing')}
  </small>
}

interface ToolDisclosureInput {
  standalone?: boolean
  processActive?: boolean
  tool: AgentRunActivity['tools'][number]
  progress?: import('@shared/agentTypes').AgentToolCallProgress
  active: boolean
}

function ToolActivityLabel({ tool, progress }: Pick<ToolDisclosureInput, 'tool' | 'progress'>) {
  const { t } = useTranslation()
  const presentation = toolPresentation(tool.call)
  const args = tool.call.args
  const freeform = tool.freeform ?? (tool.call.name === 'apply_patch' && args !== null && typeof args === 'object'
    && !Array.isArray(args) && Object.keys(args).length === 1 && 'input' in args && typeof args.input === 'string'
  )
  const summary = toolArgumentSummary(tool.call.args)
  const duration = activityDuration(tool.startedAt, tool.completedAt)
  return <>
    {!presentation.title ? <span>{t('agent.tool_call')}</span> : presentation.codeTitle
      ? <code>{presentation.title}</code> : <span>{presentation.title}</span>}
    {freeform && <span className="ui-badge ui-badge-inline" data-tooltip={t('agent.tool_call_freeform_hint')}>{t('agent.tool_call_freeform')}</span>}
    {presentation.showArgumentSummary && summary && <span className="agent-activity-argument">{summary}</span>}
    {duration && <small>· {duration}</small>}
    {progress && <small>· {t(progress.complete ? 'agent.tool_arguments_ready' : 'agent.tool_arguments_generating', { count: progress.characterCount })}</small>}
  </>
}

function ToolActivityDisclosure({ tool, progress, active, standalone = false, processActive }: ToolDisclosureInput) {
  const presentation = toolPresentation(tool.call)
  const waitingForApproval = tool.approval?.status === 'pending_approval'
  const executing = active && tool.status === 'running' && !tool.completedAt && !progress && !waitingForApproval
  const shimmer = executing && tool.call.name !== 'request_user_input'
  const deadline = executing ? sleepDeadline(tool) : undefined
  return (
    <ActivityDisclosure
      stateKey={`tool:${tool.call.id}`}
      phase={processActive}
      className={`agent-activity-tool${shimmer ? ' agent-tool-running' : ''}`}
      bodyClassName="agent-activity-tool-body"
      disabled={Boolean(progress)}
      icon={standalone && (!active || tool.status !== 'running') ? <Activity size={13} /> : presentation.icon}
      statusIndicator={waitingForApproval
        ? <ShieldAlert size={13} />
        : active && tool.status === 'running'
          ? deadline !== undefined ? <SleepCountdown key={`${tool.call.id}:${deadline}`} deadline={deadline} /> : <LoaderCircle className="agent-spin" size={13} />
          : undefined}
      label={<ToolActivityLabel tool={tool} progress={progress} />}
      renderWhenEmpty
    >
      {() => tool.detail
        ? <ActivityDetail reference={tool.detail}>{detail => <ToolActivityBody tool={tool} detail={detail} />}</ActivityDetail>
        : <ToolActivityBody tool={tool} detail={{ args: tool.call.args, output: tool.output }} />}
    </ActivityDisclosure>
  )
}

function ToolActivityBody({ tool, detail }: { tool: AgentRunActivity['tools'][number]; detail: AgentActivityDetail }) {
  return <>
    {detail.args !== undefined && (
      <ActivityDisclosure
        stateKey={`arguments:${tool.call.id}`}
        className="agent-activity-arguments"
        icon={<Braces size={13} />}
        label="arguments"
      >
        {() => <ActivityTraceBody value={detail.args} copyable />}
      </ActivityDisclosure>
    )}
    {tool.status === 'completed' && <ToolResultDisclosure tool={tool} output={detail.output} />}
  </>
}

type ModelItem = Extract<TurnTimelineActivityItem, { type: 'model' }>

function toolIsActive(run: AgentRunActivity, tool: AgentRunActivity['tools'][number]) {
  return (run.status === 'running' || run.status === 'interrupted') && (!tool.subagentId || run.subagents.some(child =>
    child.id === tool.subagentId && (child.status === 'running' || child.status === 'interrupted')))
}

function ReasoningActivityLabel({ model }: { model: ModelItem['model'] }) {
  const summary = reasoningTitleSummary(model.reasoning, model.reasoningSummary)
  return <><span>reasoning</span>{summary && <span className="agent-activity-argument">{summary}</span>}</>
}

function modelIsActive(run: AgentRunActivity, model: ModelItem['model']): boolean {
  return model.status === 'running' && run.status === 'running'
    && (!model.subagentId || run.subagents.some(child => child.id === model.subagentId && child.status === 'running'))
}

function activeProcessItem(group: ActivityGroup, run: AgentRunActivity) {
  const candidate = group.attention ?? group.active
  return candidate?.type === 'tool' ? toolIsActive(run, candidate.tool) ? candidate : undefined
    : candidate?.type === 'model' && modelIsActive(run, candidate.model) ? candidate : undefined
}

function ModelActivityDetails({ item, run }: { item: ModelItem; run: AgentRunActivity }) {
  const { t } = useTranslation()
  const { showModelRounds } = useContext(ActivityPreferences)
  const duration = activityDuration(item.model.startedAt, item.model.completedAt)
  const active = modelIsActive(run, item.model)
  return (
    <section className="agent-activity-model">
      {showModelRounds && <header>
        <span>{item.round === undefined ? 'round' : `round ${item.round}`}</span>
        {duration && <small>· {duration}</small>}
        {item.model.recovery && active && item.model.id === run.models.at(-1)?.id && (
          <small role="status">{t(`agent.model_recovery_${item.model.recovery.reason}`, { count: item.model.recovery.attempts })}</small>
        )}
        {active
          && (!item.model.recovery || item.model.id === run.models.at(-1)?.id) && (
          <LoaderCircle className="agent-spin" size={13} />
        )}
      </header>}
      {(item.model.reasoning || item.model.hasReasoning) && (
        <ActivityDisclosure
          stateKey={`reasoning:${item.model.id}`}
          className="agent-activity-reasoning"
          defaultOpen={item.model.status === 'running'}
          icon={<Brain size={13} />}
          label={<ReasoningActivityLabel model={item.model} />}
        >
          {() => item.model.detail
            ? <ActivityDetail reference={item.model.detail} field="reasoning">{value => <ActivityTraceBody value={value} plainText copyable />}</ActivityDetail>
            : <ActivityTraceBody value={item.model.reasoning} plainText copyable />}
        </ActivityDisclosure>
      )}
    </section>
  )
}

function ProcessGroup({ group, run, expanded, onExpanded }: { group: ActivityGroup; run: AgentRunActivity; expanded: boolean; onExpanded(open: boolean): void }) {
  const { t } = useTranslation()
  const active = activeProcessItem(group, run)
  const thinking = active?.type === 'model' && (active.model.hasReasoning || Boolean(active.model.reasoning))
  let label: ReactNode = group.hasThought ? t(group.hasTools ? 'agent.process_thought_tools' : 'agent.process_thought')
    : t(group.hasTools ? 'agent.process_tools' : 'agent.process_model')
  if (active?.type === 'tool') label = <ToolActivityLabel tool={active.tool} progress={active.progress} />
  else if (active?.type === 'model') label = thinking ? <ReasoningActivityLabel model={active.model} /> : t('agent.process_waiting')
  const recovery = active?.type === 'model' ? active.model.recovery : undefined
  const deadline = active?.type === 'tool' && !active.progress ? sleepDeadline(active.tool) : undefined
  let icon: ReactNode = <Activity size={13} />
  if (recovery) icon = <RotateCcw size={13} />
  else if (active?.type === 'tool') icon = active.tool.approval ? <ShieldAlert size={13} /> : toolPresentation(active.tool.call).icon
  else if (active?.type === 'model') icon = thinking ? <Brain size={13} /> : <Clock size={13} />
  return <details className="agent-activity-disclosure agent-activity-process" open={expanded}
    onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open !== expanded) onExpanded(event.currentTarget.open) }}>
    <summary tabIndex={-1} onMouseDown={event => event.preventDefault()}>
      <span className="agent-activity-summary-content">
        <span className="agent-activity-summary-icon">{icon}</span>
        <span className="agent-activity-summary-label">{recovery ? <span role="status">{t(`agent.model_recovery_${recovery.reason}`, { count: recovery.attempts })}</span> : label}</span>
        <span className="agent-activity-summary-status">{deadline !== undefined ? <SleepCountdown deadline={deadline} /> : active && <LoaderCircle className="agent-spin" size={13} />}</span>
      </span>
      <ChevronRight className="agent-activity-disclosure-chevron" size={13} />
    </summary>
  </details>
}

function ActivityViewNode({ node, run, standalone, processActive, onOpenSubagent }: {
  node: Exclude<ActivityViewItem, ActivityGroup>; run: AgentRunActivity; standalone?: boolean; processActive?: boolean
  onOpenSubagent?(runId: string, subagentId: string): void
}) {
  if (node.type === 'reply') return <div className="message-sequence assistant agent-activity-model-message">
    <article className="message-row assistant"><div className="bubble ui-surface">
      {node.model.detail ? <ActivityDetail reference={node.model.detail} field="text">{value => <MarkdownText text={String(value ?? '')} />}</ActivityDetail>
        : <MarkdownText text={node.model.text} />}
    </div></article>
  </div>
  const item = node.item
  if (item.type === 'model') return <ModelActivityDetails item={item} run={run} />
  if (item.type === 'tool') return <ToolActivityDisclosure tool={item.tool} progress={item.progress} active={toolIsActive(run, item.tool)} standalone={standalone} processActive={processActive} />
  if (item.type === 'direction') return <div className="message-sequence user agent-activity-direction-message" data-message-id={item.message.id}>
    <article className="message-row user"><div className="bubble ui-surface"><>{item.detail ? <ActivityDetail reference={item.detail}>{value => value.message && <ContentBlocks message={value.message} />}</ActivityDetail> : <ContentBlocks message={item.message} />}</></div></article>
  </div>
  if (item.type === 'subagent') return <div className="agent-activity-subagent-group">
    <AgentSubagentActivityTrigger run={{ ...run, subagents: [...run.subagents.filter(child => child.id !== item.subagent.id), item.subagent] }}
      subagentId={item.subagent.id} variant="labeled" onOpenSubagent={(runId, id) => onOpenSubagent?.(runId, id)} />
  </div>
  if (item.type === 'summary') return <ContextSummaryItem summary={item.summary} number={item.number} />
  return <ActivityDisclosure stateKey={item.key} className="agent-activity-input agent-activity-skill-input" icon={<FileText size={13} />}
    label={`/${item.invocation.name}${item.invocation.args ? ` ${item.invocation.args}` : ''}`} text={item.invocation.promptText} detail={item.invocation.detail} />
}

function DirectoryStatus({ store, scope }: { store: ActivityDirectoryStore; scope: DirectoryScope }) {
  const { t } = useTranslation(), view = store.view(scope)
  if (view.error) return <div className="agent-activity-error" role="alert">{t('agent.load_activities_failed')}
    <NoFocusButton onClick={() => store.retry(scope)}>{t('common.retry')}</NoFocusButton></div>
  return view.loading && !view.initialized ? <DelayedLoading /> : null
}

const activityRowKey = (scope: DirectoryScope, key: string) => `${scope.runId}:${scope.subagentId ?? 'root'}:${key}`
const messageRowKey = (message: AgentMessage) => message.activityModelId && message.runId
  ? activityRowKey({ runId: message.runId }, `text:model:root:${message.activityModelId}`) : `message:${message.id}`

function activitySource(scope: DirectoryScope, run: AgentRunActivity, store?: ActivityDirectoryStore, messages: AgentMessage[] = []) {
  // Optimistic previews without a persisted conversation use the same grouping
  // contract. All persisted activity comes exclusively from the directory API.
  const atoms = store ? [] : activityAtomsFromItems(projectRunActivityItems(run, new Map(), messages, scope.subagentId))
  const builder = new ActivityGroupBuilder()
  const nodes = store ? store.view(scope).items : [...atoms.flatMap(atom => builder.push(atom)), ...builder.finish()]
  // Reply boundaries are already in the outline. No member or body reads.
  const lastReply = nodes.filter(node => node.type === 'reply').at(-1)?.start
  const running = scopeIsRunning(run, scope)
  const groups = nodes.flatMap(node => node.type === 'process' ? [{ scope, key: node.key,
    active: running && (!lastReply || compareActivityPositions(node.end, lastReply) > 0) }] : [])
  return { scope, run, store, atoms, nodes, groups }
}

/** Expansion projects a complete directory into flat rows. Every row in a
 * panel shares one virtualizer and one scroll intent owner. */
function activityRows({ source, scopes, disclosures, runningProcessDisplay, showModelRounds, parentKey, omitted, onOpenSubagent }: {
  source: ReturnType<typeof activitySource>; scopes: DirectoryScope[]
  disclosures: ActivityDisclosures; runningProcessDisplay: 'expanded' | 'collapsed'; showModelRounds: boolean
  parentKey?: string; omitted?: ReadonlySet<string>; onOpenSubagent?(runId: string, id: string): void
}): TimelineRow[] {
  const rows: TimelineRow[] = []
  const { scope, run, store, atoms, nodes, groups } = source
  const activeGroups = new Set(groups.filter(group => group.active).map(group => group.key))
  if (store) { scopes.push(scope); rows.push({ key: `directory:${directoryScopeKey(scope)}`, content: <DirectoryStatus store={store} scope={scope} />, estimatedHeight: 0, parentKey }) }
  const add = (node: Exclude<ActivityViewItem, ActivityGroup>, parent: string | undefined, group?: ActivityGroup) => {
    const key = activityRowKey(scope, node.key)
    if (omitted?.has(key)) return
    // Live model status belongs to the group title. Hidden rounds must not
    // leave a member row containing only a spinner or duplicated retry text.
    if (!showModelRounds && node.type === 'entry' && node.item.type === 'model'
      && !node.item.model.hasReasoning && !node.item.model.reasoning) return
    const single = group?.start.key === group?.end.key && group?.first.type === 'tool'
    rows.push({ key, activityKey: node.key, parentKey: parent, estimatedHeight: node.type === 'reply' ? 120 : 40,
      className: group && !single ? 'agent-timeline-member' : undefined,
      content: <div onClickCapture={event => {
        const target = event.target instanceof Element ? event.target.closest('summary') : null
        if (group && !single && target && target.getAttribute('aria-disabled') !== 'true') disclosures.set(scope, group.key, true)
      }} onToggle={event => {
        if (single && event.target instanceof HTMLDetailsElement && event.target.classList.contains('agent-activity-tool')) disclosures.set(scope, group!.key, event.target.open)
      }}><ActivityViewNode node={node} run={run} standalone={single} processActive={group ? activeGroups.has(group.key) : undefined} onOpenSubagent={onOpenSubagent} /></div> })
  }
  for (const node of nodes) {
    if (node.type !== 'process') { add(node, parentKey); continue }
    // The outline already describes content and live status. Omit empty groups
    // before selecting member scopes, without reading their members or bodies.
    if (!showModelRounds && !node.hasThought && !node.hasTools && !activeProcessItem(node, run)) continue
    const key = activityRowKey(scope, node.key), single = node.start.key === node.end.key && node.first.type === 'tool'
    const running = activeGroups.has(node.key)
    const open = disclosures.open(scope, node.key, running && (runningProcessDisplay === 'expanded' || Boolean(node.attention)))
    if (single) {
      add({ type: 'entry', item: node.first, position: node.start, key: node.first.key, start: node.start, end: node.end }, parentKey, node)
      continue
    }
    rows.push({ key, activityKey: node.key, parentKey, content: <ProcessGroup group={node} run={run} expanded={open} onExpanded={value => disclosures.set(scope, node.key, value)} /> })
    if (!open) continue
    const childScope = { ...scope, parentId: node.key }
    if (store) {
      scopes.push(childScope)
      rows.push({ key: `directory:${directoryScopeKey(childScope)}`, content: <DirectoryStatus store={store} scope={childScope} />, estimatedHeight: 0, parentKey: key })
    }
    const members = store ? store.view(childScope).items : atoms.filter(atom => isProcessAtom(atom)
      && compareActivityPositions(atom.position, node.start) >= 0 && compareActivityPositions(atom.position, node.end) <= 0)
      .map(atom => ({ ...atom, key: atom.position.key, start: atom.position, end: atom.position }))
    for (const child of members) if (child.type !== 'process') add(child, key, node)
  }
  return rows
}

export function AgentSubagentPanel({
  run,
  subagentId,
  onOpenSubagent,
  threadId
}: {
  run?: AgentRunActivity
  subagentId?: string
  onOpenSubagent?(runId: string, subagentId: string): void
  threadId?: string
}) {
  const { t } = useTranslation()
  const directories = useActivityDirectories(threadId)
  const source = run && subagentId ? activitySource({ runId: run.runId, subagentId }, run, threadId ? directories : undefined) : undefined
  const disclosures = useActivityDisclosures(`subagent:${threadId}:${subagentId}`, run ? [run] : [], source?.groups ?? [])
  const { runningProcessDisplay, showModelRounds } = useContext(ActivityPreferences)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const followOutputRef = usePanelRef('followOutput', run?.subagents.some(child => child.id === subagentId && (child.status === 'running' || child.status === 'interrupted')) ?? false)
  const onScroll = usePanelScroll(panelRef, Boolean(run))
  const subagent = run?.subagents.find((item) => item.id === subagentId)
  const open = Boolean(run && subagent)
  const navigation = useScrollBoundaryNavigation({
    contentRef,
    contentVersion: run,
    enabled: open,
    followOutputRef,
    panelRef,
    resetKey: subagentId, virtualized: true
  })


  const scopes: DirectoryScope[] = []
  const rows = source && subagent ? activityRows({ source,
    scopes, disclosures, runningProcessDisplay, showModelRounds, onOpenSubagent }) : []
  const scopeKey = JSON.stringify(scopes)
  useEffect(() => { directories.sync(JSON.parse(scopeKey) as DirectoryScope[]) }, [directories, scopeKey])
  if (!run || !subagent) return null
  const delegationTool = delegationToolForSubagent(run, subagent)
  const summary = activitySummaryLabel(run, subagent.id, t)
  const description = subagentDescription(run, subagent)
  const resultText = formatTraceValue(subagent.result)
  const errorText = subagent.error ? localizeAgentError(subagent.error, t) : ''
  const recoveryError = Boolean(
    errorText
    && (subagent.status === 'running' || subagent.status === 'interrupted')
  )
  const displayedStatus = recoveryError
    ? 'Recovery error'
    : subagentStatusLabel(subagent.status)

  return (
    <FollowOutputContext value={followOutputRef}><section className="ui-detail-panel agent-subagent-panel">
          <header className="agent-subagent-panel-header">
            <div className="agent-subagent-panel-title">
              <AgentSubagentStatusIcon
                status={recoveryError ? 'failed' : subagent.status}
                size={14}
              />
              <h2 className="ui-dialog-title">{subagent.name}</h2>
              <small>· {displayedStatus} · {summary}</small>
            </div>
              <p className={description
                ? 'agent-subagent-panel-description'
                : 'ui-visually-hidden'}>
                {description ?? summary}
              </p>
          </header>
          <div className="scroll-boundary-frame agent-subagent-scroll-frame">
            <div
              className="agent-subagent-panel-body"
              role="region"
              aria-label={subagent.name}
              tabIndex={-1}
              ref={panelRef}
              style={{ overflowAnchor: 'none' }}
              onClickCapture={navigation.onClickCapture}
              onPointerDown={navigation.onPointerDown}
              onScroll={() => { navigation.onScroll(); onScroll() }}
              onTouchMove={navigation.onTouchMove}
              onTouchStart={navigation.onTouchStart}
              onWheel={navigation.onWheel}
            >
              <div ref={contentRef}>
                <VirtualTimeline rows={[
                  ...(delegationTool ? [{ key: 'delegation', content: <ToolActivityDisclosure tool={delegationTool} active={run.status === 'running' || run.status === 'interrupted'} /> }] : []),
                  ...rows,
                  { key: 'result', content: <>
                {subagent.detailsDeferred && !subagent.detail && <LoaderCircle className="agent-spin" size={14} aria-label={t('common.loading')} />}
                {subagent.status === 'completed' && (!subagent.detailsDeferred || subagent.detail) && (
                  <ActivityDisclosure
                    stateKey="subagent-result"
                    className="agent-subagent-result"
                    icon={<CircleCheck size={13} />}
                    label="subagent result"
                    text={resultText}
                    detail={subagent.detail}
                    field="result"
                  />
                )}
                {errorText && (
                  <ActivityDisclosure
                    stateKey="subagent-error"
                    className="agent-subagent-result agent-subagent-error"
                    icon={<AgentSubagentStatusIcon status="failed" size={13} />}
                    label={recoveryError ? 'recovery error' : 'error'}
                    text={errorText}
                    detail={subagent.detail}
                    field="error"
                    renderWhenEmpty
                  />
                )}
                  </> }
                ]} panelRef={panelRef} followOutput={followOutputRef} resetKey={subagentId} />
              </div>
            </div>
            <ScrollBoundaryControls
              atBottom={navigation.boundaries.atBottom}
              atTop={navigation.boundaries.atTop}
              visible={navigation.showControls}
              onScrollToBottom={navigation.scrollToBottom}
              onScrollToTop={navigation.scrollToTop}
            />
          </div>
    </section></FollowOutputContext>
  )
}

function activityCountLabel(
  count: number,
  singular: string
): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function activitySummaryLabel(
  run: AgentRunActivity,
  agentId: string | undefined,
  t: ReturnType<typeof useTranslation>['t']
): string {
  const counts = agentId ? run.subagents.find(item => item.id === agentId)?.activityCounts : run.display
  const modelCount = counts?.modelCount ?? (agentId
    ? run.models.filter((model) => model.subagentId === agentId).length
    : run.models.length)
  const toolCount = counts?.toolCount ?? visibleToolsForAgent(run, agentId).length
  const subagentCount = counts?.subagentCount ?? (agentId
    ? run.subagents.filter((subagent) => subagent.parentSubagentId === agentId).length
    : run.subagents.length)
  const summary = [
    activityCountLabel(modelCount, 'model round'),
    activityCountLabel(toolCount, 'tool call'),
    ...(subagentCount > 0
      ? [activityCountLabel(subagentCount, 'subagent')]
      : [])
  ].join(' · ')
  return !counts && run.activityWindow?.hasEarlier
    ? t('agent.loaded_activity_summary', { summary })
    : summary
}

function rangeLabel(
  range: TurnTimelineActivityRange,
  t: ReturnType<typeof useTranslation>['t']
): string {
  if (range.run.status === 'failed') return t('agent.run_failed')
  if (range.run.status === 'cancelled') return t('agent.run_cancelled')
  if (range.run.status === 'interrupted') return t('agent.run_waiting_for_approval')
  if (range.run.status === 'completed' && !range.finalMessageId) {
    return t('agent.run_completed_without_reply')
  }
  return t('agent.process_model')
}

function activityDuration(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt || !completedAt) return undefined
  const milliseconds = Date.parse(completedAt) - Date.parse(startedAt)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined
  if (milliseconds < 1_000) return `${milliseconds} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
}

function RunElapsed({ run }: { run: AgentRunActivity }) {
  const { t, i18n } = useTranslation()
  const active = run.status === 'running' || run.status === 'interrupted'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const update = () => setNow(Date.now())
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [active, run.runId])
  const elapsed = Math.max(0, Math.floor(((active ? now : Date.parse(run.updatedAt)) - Date.parse(run.createdAt)) / 1_000))
  const duration = Number.isFinite(elapsed) ? [
    [Math.floor(elapsed / 3600), 'hour'], [Math.floor(elapsed % 3600 / 60), 'minute'], [elapsed % 60, 'second']
  ].filter(([value, unit]) => value || unit === 'second' && elapsed === 0)
    .map(([value, unit]) => new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { style: 'unit', unit: String(unit), unitDisplay: 'narrow' }).format(Number(value))).join(' ') : undefined
  return <span className="agent-run-elapsed">{duration ? t(active ? 'agent.run_elapsed_active' : 'agent.run_elapsed', { duration }) : t('agent.process_model')}</span>
}

function ActivityRangeHeader({ range, expanded, onExpanded }: {
  range: TurnTimelineActivityRange; expanded: boolean; onExpanded(open: boolean): void
}) {
  const { t } = useTranslation()
  const canCollapse = range.run.status !== 'running' && range.run.status !== 'interrupted'
  return <section className={`agent-activity-range ${expanded ? 'expanded' : 'collapsed'}`}>
    <div className="agent-activity-range-boundary agent-activity-range-boundary-top">
      {canCollapse ? <NoFocusButton className="agent-activity-range-toggle" type="button" aria-expanded={expanded}
        data-scroll-follow-toggle onClick={() => onExpanded(!expanded)}>
        <RunElapsed run={range.run} />
        {(range.run.status !== 'completed' || !range.finalMessageId) && <small>{rangeLabel(range, t)}</small>}
        <ChevronRight className="agent-activity-range-chevron" size={13} />
      </NoFocusButton> : <div className="agent-activity-range-status">
        <RunElapsed run={range.run} />
        {range.run.status === 'interrupted' && <small>{rangeLabel(range, t)}</small>}
      </div>}
    </div>
  </section>
}

function ActivityRangeFooter({ collapse }: { collapse(): void }) {
  const { t } = useTranslation()
  return <div className="agent-activity-range-boundary agent-activity-range-boundary-bottom">
    <NoFocusButton className="agent-activity-range-toggle agent-activity-range-collapse-button" type="button"
      aria-label={t('agent.collapse_activity')} data-scroll-follow-toggle data-tooltip={t('agent.collapse_activity')} onClick={collapse}>
      <ChevronUp size={14} />
    </NoFocusButton>
  </div>
}

function ModelRetryActions({ retry, onRetry }: { retry: AgentModelRetryState; onRetry(withhold: boolean): Promise<void> }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const submit = async (withhold: boolean) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try { await onRetry(withhold) }
    catch { notice.error(t('agent.model_retry_failed')) }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className="agent-model-retry-actions">
    <NoFocusButton type="button" className="ui-button" disabled={busy} onClick={() => void submit(false)}>{t('common.retry')}</NoFocusButton>
    {retry.canWithholdToolResults && <NoFocusButton type="button" className="ui-button" disabled={busy}
      title={t('agent.retry_without_tool_results_hint')}
      onClick={() => void submit(true)}>{t('agent.retry_without_tool_results')}</NoFocusButton>}
  </div>
}

export function AgentMessageList({
  onOpenChanges,
  title,
  navigationKey,
  messages,
  activities,
  run,
  panelRef,
  followOutputRef,
  error,
  modelRetries,
  onRetryModel,
  speech,
  earlierMessageCount = 0,
  onDeleteRound,
  onEditUserMessage,
  onRegenerate,
  onLoadEarlier,
  onLoadEarlierError,
  onOpenSubagent,
  onSpeak
}: AgentMessageListProps) {
  const { t } = useTranslation()
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const paginationRef = useRef<AbortController | undefined>(undefined)
  const directories = useActivityDirectories(navigationKey)
  const changeAvailability = useRoundChangeAvailability(navigationKey, Boolean(onOpenChanges))
  const { runningProcessDisplay, showModelRounds } = useContext(ActivityPreferences)
  const navigationKeyRef = useRef(navigationKey)
  navigationKeyRef.current = navigationKey
  const navigation = useScrollBoundaryNavigation({
    contentRef,
    followOutputRef,
    followThreshold: 96,
    panelRef,
    resetKey: navigationKey, virtualized: true
  })
  const timeline = projectTurnTimeline(messages, activities, run)
  const previewMessages = [...messages.filter(message => message.role === 'user'), ...timeline.entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : [])]
  const sources = new Map(timeline.entries.flatMap(entry => entry.type === 'activity-range'
    ? [[entry.key, activitySource({ runId: entry.run.runId }, entry.run, navigationKey ? directories : undefined, previewMessages)] as const] : []))
  const disclosures = useActivityDisclosures(`timeline:${navigationKey}`, [...sources.values()].map(source => source.run),
    [...sources.values()].flatMap(source => source.groups))
  const errorRenderedInTimeline = Boolean(error && timeline.entries.some((entry) =>
    entry.type === 'error' && entry.message === error
  ))

  useEffect(() => {
    paginationRef.current?.abort(); paginationRef.current = undefined
    setLoadingEarlier(false)
    return () => paginationRef.current?.abort()
  }, [navigationKey])

  const loadEarlier = async (): Promise<void> => {
    const threadId = navigationKey
    if (!onLoadEarlier || paginationRef.current || !threadId) return
    const request = new AbortController(); paginationRef.current = request; setLoadingEarlier(true)
    try { await onLoadEarlier({ threadId, signal: request.signal }) }
    catch {
      if (!request.signal.aborted && navigationKeyRef.current === threadId) onLoadEarlierError?.(threadId, t('agent.load_earlier_failed'))
    } finally {
      if (paginationRef.current === request) { paginationRef.current = undefined; setLoadingEarlier(false) }
    }
  }
  const scopes: DirectoryScope[] = []
  const omitted = new Set(timeline.entries.flatMap(entry => entry.type === 'message' ? [messageRowKey(entry.message)] : []))
  const rows: TimelineRow[] = timeline.entries.flatMap((entry): TimelineRow[] => {
    if (entry.type === 'error') {
      const retry = modelRetries?.find(item => item.runId === entry.runId)
      return [{ key: entry.key, content: <div className="agent-activity-error" role="alert" data-native-context-menu="text">
        <div>{localizeAgentError(entry.message, t)}</div>
        {retry && onRetryModel && !run && <ModelRetryActions key={retry.revisionId} retry={retry} onRetry={withhold => onRetryModel(retry, withhold)} />}
      </div> }]
    }
    if (entry.type === 'cleanup') return [{ key: entry.key, content: <BackgroundCleanupDisclosure entry={entry} /> }]
    if (entry.type === 'summary') return [{ key: entry.key, content: <ContextSummaryItem summary={entry.summary} number={entry.number} /> }]
    if (entry.type === 'activity-range') {
      const active = entry.run.status === 'running' || entry.run.status === 'interrupted'
      const scope = { runId: entry.run.runId }
      const open = active || disclosures.open(scope, entry.key, entry.startsExpanded)
      return [
        { key: entry.key, content: <ActivityRangeHeader range={entry} expanded={open} onExpanded={value => disclosures.set(scope, entry.key, value)} /> },
        ...(open ? activityRows({ source: sources.get(entry.key)!,
          scopes, disclosures, runningProcessDisplay, showModelRounds, parentKey: entry.key, omitted, onOpenSubagent }) : []),
        ...(open && !active ? [{ key: `${entry.key}:collapse`, parentKey: entry.key, content: <ActivityRangeFooter collapse={() => disclosures.set(scope, entry.key, false)} /> }] : [])
      ]
    }
    return [{ key: messageRowKey(entry.message), estimatedHeight: 120, content: <MessageItem
      message={entry.message} roundUserMessageId={entry.roundUserMessageId} actionsDisabled={Boolean(run)} speech={speech} changeAvailability={changeAvailability}
      onDeleteRound={onDeleteRound} onEditUserMessage={onEditUserMessage} onRegenerate={onRegenerate} onSpeak={onSpeak} onOpenChanges={onOpenChanges} /> }]
  })
  const scopeKey = JSON.stringify(scopes)
  useEffect(() => { directories.sync(JSON.parse(scopeKey) as DirectoryScope[]) }, [directories, scopeKey])
  return (
    <FollowOutputContext value={followOutputRef}><div className="scroll-boundary-frame agent-message-scroll-frame">
      <section
        className="agent-message-panel workspace-content-scroll"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
        style={{ overflowAnchor: 'none' }}
        onClickCapture={navigation.onClickCapture}
        onPointerDown={navigation.onPointerDown}
        onScroll={navigation.onScroll}
        onTouchMove={navigation.onTouchMove}
        onTouchStart={navigation.onTouchStart}
        onWheel={navigation.onWheel}
      >
        <div className="agent-message-content" ref={contentRef}>
          {earlierMessageCount > 0 && onLoadEarlier && (
            <NoFocusButton
              className="agent-load-earlier"
              type="button"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier
                ? <LoaderCircle className="agent-spin" size={13} />
                : <ChevronUp size={13} />}
              {t('agent.load_earlier_messages', { count: earlierMessageCount })}
            </NoFocusButton>
          )}
          <VirtualTimeline rows={rows} panelRef={panelRef} followOutput={followOutputRef} resetKey={navigationKey} />
          {error && !errorRenderedInTimeline && (
            <div className="thread-title error" data-native-context-menu="text">
              {localizeAgentError(error, t)}
            </div>
          )}
        </div>
      </section>
      <ScrollBoundaryControls
        atBottom={navigation.boundaries.atBottom}
        atTop={navigation.boundaries.atTop}
        visible={navigation.showControls}
        onScrollToBottom={navigation.scrollToBottom}
        onScrollToTop={navigation.scrollToTop}
      />
    </div></FollowOutputContext>
  )
}
