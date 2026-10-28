import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentAttachmentArtifact, AgentMessageEditResult, AgentThreadSnapshot } from '../../shared/agentTypes'

/** Copy attachments before truncating their archived history; failed edits
 * discard only the new draft, preserving the original conversation. */
export async function prepareMessageEditDraft(artifacts: AgentAttachmentArtifact[], temporaryRoot: string,
  truncate: () => Promise<AgentThreadSnapshot>): Promise<AgentMessageEditResult> {
  if (artifacts.length === 0) {
    return {
      snapshot: await truncate(),
      attachments: []
    }
  }

  const draftRoot = join(
    temporaryRoot,
    'message_edit',
    randomUUID()
  )
  await mkdir(draftRoot, { recursive: true })
  try {
    const paths: string[] = []
    for (const [index, artifact] of artifacts.entries()) {
      if (!artifact.available) {
        throw new Error(`Attachment "${artifact.name}" is no longer available.`)
      }
      const destinationDirectory = join(
        draftRoot,
        String(index).padStart(4, '0')
      )
      await mkdir(destinationDirectory, { recursive: true })
      const destination = join(destinationDirectory, basename(artifact.name))
      await copyFile(artifact.path, destination)
      paths.push(destination)
    }
    const attachments = await Promise.all(artifacts.map(async (artifact, index) => ({
      path: paths[index],
      name: artifact.name,
      size: artifact.size,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      contextPolicy: artifact.contextPolicy,
      truncated: artifact.textTruncated,
      temporary: true,
      ...(artifact.kind === 'image'
        ? {
            dataUri: `data:${artifact.mimeType};base64,${
              (await readFile(paths[index])).toString('base64')
            }`
          }
        : {})
    })))
    const snapshot = await truncate()
    return { snapshot, attachments }
  } catch (reason) {
    await rm(draftRoot, { recursive: true, force: true }).catch(() => undefined)
    throw reason
  }
}
