import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isHelpDocumentId } from '@shared/helpDocuments'
import { getBundledDataDir } from './config/dataDir'

const maxHelpBytes = 1024 * 1024

export async function readHelpDocument(documentId: unknown): Promise<string> {
  if (!isHelpDocumentId(documentId)) throw new Error('Unknown help document.')
  const file = await open(join(getBundledDataDir(), 'help', documentId), 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > maxHelpBytes) throw new Error('Help document is too large or not a file.')
    const buffer = Buffer.alloc(maxHelpBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > maxHelpBytes) throw new Error('Help document is too large.')
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    await file.close()
  }
}
