import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AgentAttachmentArtifact,
  AgentAttachmentInput
} from '@shared/agentTypes'
import { withApplicationDataMutation } from '../applicationDataSnapshot'

export interface ArchivedAgentAttachment {
  artifact: AgentAttachmentArtifact
  storagePath: string
}

function normalizedStoragePath(root: string, path: string): string {
  const rel = relative(resolve(root), resolve(path))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Attachment storage path escaped the managed attachment directory.')
  }
  return rel.split(sep).join('/')
}

function storedFileName(sourcePath: string): string {
  const extension = extname(sourcePath)
  return /^\.[a-zA-Z0-9]{1,16}$/.test(extension)
    ? `content${extension.toLowerCase()}`
    : 'content'
}

async function archiveOne(
  input: AgentAttachmentInput,
  context: { threadId: string; runId: string; messageId: string },
  root: string
): Promise<ArchivedAgentAttachment> {
  const sourcePath = resolve(input.path)
  const sourceInfo = await stat(sourcePath)
  if (!sourceInfo.isFile()) throw new Error(`Attachment "${input.name}" is not a file.`)
  const id = randomUUID()
  const threadRoot = join(root, context.threadId)
  const temporaryDirectory = join(threadRoot, `.tmp-${id}`)
  const artifactDirectory = join(threadRoot, id)
  const fileName = storedFileName(sourcePath)
  const temporaryPath = join(temporaryDirectory, fileName)
  const finalPath = join(artifactDirectory, fileName)
  await mkdir(temporaryDirectory, { recursive: true })
  try {
    await copyFile(sourcePath, temporaryPath)
    await rename(temporaryDirectory, artifactDirectory)
  } catch (reason) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw reason
  }
  const createdAt = new Date().toISOString()
  return {
    artifact: {
      id,
      threadId: context.threadId,
      messageId: context.messageId,
      runId: context.runId,
      name: input.name,
      mimeType: input.mimeType,
      size: sourceInfo.size,
      kind: input.kind,
      path: finalPath,
      available: true,
      textTruncated: Boolean(input.textTruncated),
      contextPolicy: input.contextPolicy,
      createdAt
    },
    storagePath: normalizedStoragePath(root, finalPath)
  }
}

export async function archiveAgentAttachments(
  inputs: AgentAttachmentInput[],
  context: { threadId: string; runId: string; messageId: string },
  root: string
): Promise<ArchivedAgentAttachment[]> {
  if (inputs.length === 0) return []
  await mkdir(join(root, context.threadId), { recursive: true })
  const archived: ArchivedAgentAttachment[] = []
  try {
    for (const input of inputs) {
      archived.push(await archiveOne(input, context, root))
    }
    return archived
  } catch (reason) {
    await deleteArchivedAgentAttachments(
      archived.map((item) => item.artifact),
      root
    )
    throw reason
  }
}

export async function deleteArchivedAgentAttachments(
  attachments: Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>,
  root: string
): Promise<void> {
  return withApplicationDataMutation(async () => {
    const managedRoot = resolve(root)
    await Promise.all(attachments.map(async (attachment) => {
      if (!attachment.path) return
      const artifactDirectory = resolve(attachment.path, '..')
      if (
        !artifactDirectory.startsWith(`${managedRoot}${sep}`)
        || artifactDirectory.split(/[\\/]/).at(-1) !== attachment.id
      ) {
        throw new Error(`Attachment ${attachment.id} has an invalid managed path.`)
      }
      await rm(artifactDirectory, { recursive: true, force: true })
    }))
  })
}

export async function deleteArchivedAgentThreadAttachments(
  threadId: string,
  root: string
): Promise<void> {
  return withApplicationDataMutation(async () => {
    const managedRoot = resolve(root)
    const threadRoot = resolve(managedRoot, threadId)
    if (
      !threadId
      || threadRoot === managedRoot
      || !threadRoot.startsWith(`${managedRoot}${sep}`)
      || relative(managedRoot, threadRoot).split(sep).length !== 1
    ) {
      throw new Error(`Thread ${threadId} has an invalid managed attachment path.`)
    }
    await rm(threadRoot, { recursive: true, force: true })
  })
}

export function validatedAttachmentInputs(
  value: unknown,
  label: 'Direction' | 'Queued input'
): AgentAttachmentInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} attachments must be an array.`)
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${label} attachment ${index + 1} is invalid.`)
    }
    const attachment = candidate as Partial<AgentAttachmentInput>
    if (typeof attachment.path !== 'string' || !attachment.path.trim() || !isAbsolute(attachment.path)) {
      throw new Error(`${label} attachment ${index + 1} requires an absolute file path.`)
    }
    if (typeof attachment.name !== 'string' || !attachment.name.trim()) {
      throw new Error(`${label} attachment ${index + 1} requires a name.`)
    }
    if (typeof attachment.mimeType !== 'string' || !attachment.mimeType.trim()) {
      throw new Error(`${label} attachment ${index + 1} requires a MIME type.`)
    }
    const size = attachment.size
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`${label} attachment ${index + 1} has an invalid size.`)
    }
    const kind = attachment.kind
    if (kind !== 'image' && kind !== 'text' && kind !== 'binary') {
      throw new Error(`${label} attachment ${index + 1} has an invalid kind.`)
    }
    const contextPolicy = attachment.contextPolicy
    if (contextPolicy !== 'one_turn' && contextPolicy !== 'conversation') {
      throw new Error(`${label} attachment ${index + 1} has an invalid context policy.`)
    }
    if (
      attachment.textTruncated !== undefined
      && typeof attachment.textTruncated !== 'boolean'
    ) {
      throw new Error(`${label} attachment ${index + 1} has an invalid truncation state.`)
    }
    return {
      path: attachment.path,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size,
      kind,
      ...(attachment.textTruncated === undefined
        ? {}
        : { textTruncated: attachment.textTruncated }),
      contextPolicy
    }
  })
}
