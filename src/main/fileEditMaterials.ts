import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FileEditStore, isFileEditInternalId } from './fileEditStore'
import { patchCompensationComplete } from './filePatchRecord'
import { validatePatchRestoreEvidence } from './filePatchRestore'

export interface FileEditReference { requestId: string; operationId: string }

/** Validate copied recovery material without examining or changing workspace
 * targets. Confirmed edits may already have been cleaned; retained effects
 * and unfinished reverse operations must still have their exact evidence. */
export async function validateFileEditMaterials(roots: readonly string[], required: readonly FileEditReference[]): Promise<void> {
  const requests = new Map<string, FileEditStore>(), operations: FileEditReference[] = []
  for (const root of roots) {
    const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) continue
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('File edit storage is not a real directory.')
    const store = new FileEditStore(root)
    for (const request of await readdir(root, { withFileTypes: true })) {
      if (!request.isDirectory() || !isFileEditInternalId(request.name)) throw new Error('Unexpected file edit request entry.')
      if (requests.has(request.name)) throw new Error(`File edit request belongs to multiple conversations: ${request.name}`)
      requests.set(request.name, store)
      for (const operation of await readdir(join(root, request.name), { withFileTypes: true })) {
        if (!operation.isDirectory() || !isFileEditInternalId(operation.name)) throw new Error('Unexpected file edit operation entry.')
        operations.push({ requestId: request.name, operationId: operation.name })
      }
    }
  }
  const load = async (reference: FileEditReference) => {
    const store = requests.get(reference.requestId)
    if (!store) throw new Error(`Missing file edit recovery material: ${reference.requestId}/${reference.operationId}`)
    return store.loadOperationRecord(reference.operationId, reference.requestId)
  }
  for (const operation of operations) {
    const record = await load(operation), transaction = record.transaction
    if (transaction.reverseAttempt && transaction.recovery?.state !== 'complete') {
      validatePatchRestoreEvidence(record, await load(transaction.reverseAttempt))
    }
    if (transaction.restores && !transaction.sourceFinalized && !patchCompensationComplete(transaction)) {
      const source = await load(transaction.restores)
      // A crash may publish the inverse preparation before publishing the
      // source pointer. That preparation has not performed any file effects.
      if (source.definitionHash !== transaction.restores.definitionHash || source.revision < transaction.restores.revision) {
        throw new Error('File edit inverse refers to changed source material.')
      }
      if (source.transaction.reverseAttempt?.operationId === record.operationId
        && source.transaction.reverseAttempt.requestId === record.requestId) validatePatchRestoreEvidence(source, record)
      else if (transaction.state !== 'prepared') throw new Error('File edit inverse has no matching source recovery reference.')
    }
  }
  for (const reference of required) await load(reference)
}
