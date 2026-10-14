import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCacheDir } from '../config/dataDir'
import { withApplicationDataMutation } from '../applicationDataSnapshot'

/** A readable cache of a tool result; the complete checkpoint message remains authoritative. */
export async function saveToolResultFile(content: string, root = join(getCacheDir(), 'tool-results')): Promise<string> {
  return withApplicationDataMutation(async () => {
    await mkdir(root, { recursive: true })
    const name = createHash('sha256').update(content).digest('hex')
    const path = join(root, `${name}.txt`)
    const temporary = join(root, `.${name}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
    return path
  })
}
