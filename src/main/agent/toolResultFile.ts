import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import fs from 'stubborn-fs'
import { withApplicationDataMutation } from '../applicationDataSnapshot'

const rename = fs.retry.rename({ timeout: 2_000, interval: 25 })

/** A conversation-owned readable copy of a tool result; the persisted native message remains authoritative. */
export async function saveToolResultFile(content: string, root: string): Promise<string> {
  return withApplicationDataMutation(async () => {
    await mkdir(root, { recursive: true })
    const name = createHash('sha256').update(content).digest('hex')
    const path = join(root, `${name}.txt`)
    const temporary = join(root, `.${name}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
      // Concurrent publications and Windows readers can briefly deny replacement.
      // Retry the atomic rename without deleting the existing complete result.
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
    return path
  })
}
