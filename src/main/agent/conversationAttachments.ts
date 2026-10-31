import { readFile } from 'node:fs/promises'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type {
  AgentAttachmentArtifact
} from '@shared/agentTypes'
import type { AttachmentTextOverflowMode } from '@shared/types'
import { extractLocalAttachmentText, supportsLocalTextExtraction } from '../attachmentTextExtractor'
import { runtimeLog } from '../runtimeLogger'
import { ModelSelectionError } from '../../runtime/errors'

type ModelContentBlock = Record<string, unknown>

export interface AttachmentProjectionOptions {
  artifacts: AgentAttachmentArtifact[]
  currentRunId?: string
  textMaxChars: number
  textOverflow: AttachmentTextOverflowMode
}

export interface ConversationAttachmentProjector {
  artifacts: AgentAttachmentArtifact[]
  addArtifacts(artifacts: AgentAttachmentArtifact[]): void
  project(messages: ConversationMessage[], visionEnabled: boolean, includedMessageIds?: ReadonlySet<string>): Promise<ConversationMessage[]>
}

function selectedForContext(
  artifact: AgentAttachmentArtifact,
  currentRunId?: string
): boolean {
  return artifact.runId === currentRunId || artifact.contextPolicy === 'conversation'
}

function textMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/')
    || [
      'application/json',
      'application/jsonl',
      'application/toml',
      'application/xml',
      'application/yaml'
    ].includes(mimeType)
}

function fileLabel(artifact: AgentAttachmentArtifact): ModelContentBlock {
  return {
    type: 'text',
    text: `[Attachment: ${artifact.name}]`
  }
}

function unavailableAttachment(artifact: AgentAttachmentArtifact, detail: string): ModelContentBlock[] {
  return [{ type: 'text', text: `[Application attachment notice: ${JSON.stringify(artifact.name)}]\n${detail}\nThe attachment content was not provided. Do not claim to have read it. Continue with available information, or explain what is missing if it is needed for the task.` }]
}

async function textContent(
  artifact: AgentAttachmentArtifact,
  maxChars: number,
  overflow: AttachmentTextOverflowMode
): Promise<ModelContentBlock[]> {
  const text = supportsLocalTextExtraction(artifact.mimeType)
    ? (await extractLocalAttachmentText(artifact.path, artifact.mimeType)).text
    : (await readFile(artifact.path)).toString('utf8')
  if (text.length > maxChars && overflow === 'error') return unavailableAttachment(artifact, 'Extracted text exceeds the configured attachment limit.')
  const content = text.length > maxChars ? text.slice(0, maxChars) : text
  return [{
    type: 'text',
    text: `<file name=${JSON.stringify(artifact.name)}>\n${content}\n</file>`
  }]
}

async function modelContent(
  artifact: AgentAttachmentArtifact,
  maxChars: number,
  overflow: AttachmentTextOverflowMode
): Promise<ModelContentBlock[]> {
  if (!artifact.available) return unavailableAttachment(artifact, 'The archived attachment is unavailable.')
  try {
    if (artifact.kind === 'image') {
      const content = await readFile(artifact.path)
      return [
        fileLabel(artifact),
        {
          type: 'image_url',
          image_url: {
            url: `data:${artifact.mimeType};base64,${content.toString('base64')}`,
            detail: 'auto'
          }
        }
      ]
    }
    if (
      artifact.kind === 'text'
      && (supportsLocalTextExtraction(artifact.mimeType) || textMimeType(artifact.mimeType))
    ) {
      return await textContent(artifact, maxChars, overflow)
    }
    return unavailableAttachment(artifact, 'This attachment has no supported text extraction method.')
  } catch (reason) {
    runtimeLog('warn', 'agent', 'Archived attachment could not be projected into model context.', {
      attachmentId: artifact.id,
      file: artifact.path,
      error: reason instanceof Error ? reason.message : String(reason)
    })
    return unavailableAttachment(artifact, `Reading the archived file or extracting its text failed: ${reason instanceof Error ? reason.message.slice(0, 1000) : String(reason).slice(0, 1000)}`)
  }
}

function appendAttachments(message: ConversationMessage, content: ModelContentBlock[]): ConversationMessage {
  const original = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
  return { ...message, content: [...original, ...content], context: { ...message.context,
    attachmentProjection: true,
    attachmentBlockCount: (typeof message.context?.attachmentBlockCount === 'number' ? message.context.attachmentBlockCount : 0) + content.length } }
}

export function stripConversationAttachments(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map(message => {
    const count = message.context?.attachmentBlockCount
    if (message.kind !== 'user' || typeof count !== 'number' || count <= 0 || typeof message.content === 'string') return message
    const { attachmentProjection: _projection, attachmentBlockCount: _count, ...context } = message.context ?? {}
    return { ...message, content: message.content.slice(0, Math.max(0, message.content.length - count)), context }
  })
}

export function createConversationAttachmentProjector(
  options: AttachmentProjectionOptions
): ConversationAttachmentProjector {
  const artifacts = options.artifacts.filter((artifact) =>
    selectedForContext(artifact, options.currentRunId)
  )
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const contentCache = new Map<string, Promise<ModelContentBlock[]>>()

  function addArtifacts(items: AgentAttachmentArtifact[]): void {
    for (const artifact of items) {
      if (
        artifactIds.has(artifact.id)
        || !selectedForContext(artifact, options.currentRunId)
      ) continue
      artifactIds.add(artifact.id)
      artifacts.push(artifact)
    }
  }

  async function contentFor(artifact: AgentAttachmentArtifact): Promise<ModelContentBlock[]> {
    const cached = contentCache.get(artifact.id)
    if (cached) return cached
    const pending = modelContent(
      artifact,
      options.textMaxChars,
      options.textOverflow
    )
    contentCache.set(artifact.id, pending)
    return pending
  }

  async function project(messages: ConversationMessage[], visionEnabled: boolean, includedMessageIds?: ReadonlySet<string>): Promise<ConversationMessage[]> {
    if (
      artifacts.length === 0
      || messages.some((message) => message.context?.attachmentProjection === true)
    ) {
      return messages
    }

    const contentByMessage = new Map<string, ModelContentBlock[]>()
    const messageIds = new Set(messages.flatMap((message) => message.id ? [message.id] : []))
    for (const artifact of artifacts) {
      if (!messageIds.has(artifact.messageId) || includedMessageIds && !includedMessageIds.has(artifact.messageId)) continue
      if (artifact.available && artifact.kind === 'image' && !visionEnabled) {
        throw new ModelSelectionError(`The selected model does not support the required image attachment "${artifact.name}". The run was stopped. Choose a model with vision enabled and send again.`)
      }
      const content = await contentFor(artifact)
      if (content.length === 0) continue
      contentByMessage.set(
        artifact.messageId,
        [...(contentByMessage.get(artifact.messageId) ?? []), ...content]
      )
    }

    return messages.map((message) => {
      const content = message.id ? contentByMessage.get(message.id) : undefined
      return content?.length && message.kind === 'user'
        ? appendAttachments(message, content)
        : message
    })
  }

  return { addArtifacts, artifacts, project }
}
