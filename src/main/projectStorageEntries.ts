import { existsSync, lstatSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export function isProjectDirectoryId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
}

/** Collection directories may also contain arbitrary user or OS entries. */
export function isConversationStorageEntry(directory: string, entry: Dirent, registered = false): boolean {
  return registered || entry.isDirectory() && existsSync(join(directory, entry.name, 'conversation.sqlite'))
}

export function isProjectStorageEntry(directory: string, entry: Dirent, registered = false): boolean {
  if (!isProjectDirectoryId(entry.name)) return false
  if (registered) return true
  if (!entry.isDirectory()) return false
  const project = join(directory, entry.name)
  if (existsSync(join(project, 'project.json'))) return true
  const conversations = join(project, 'conversations')
  return existsSync(conversations) && lstatSync(conversations).isDirectory()
    && readdirSync(conversations, { withFileTypes: true }).some(child => isConversationStorageEntry(conversations, child))
}
