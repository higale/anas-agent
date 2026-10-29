import Database from 'better-sqlite3'
import { validateRestoredTools } from './toolsStore'
import { access, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeConversationDatabase } from './agent/nativeConversationDatabase'
import { AgentStorage } from './agent/agentStorage'
import { avatarTransformPath, readAvatarTransform } from './avatarAssets'
import { normalizeAppConfigSnapshot } from './config/appConfig'
import {
  configDirName, getAgentAttachmentsDir, getAgentCatalogFile, getAgentConversationDatabaseFile,
  getAgentConversationsDir, getProjectsDir, getInputHistoryFile, getProjectStoreFile, skillsConfigFileName
} from './config/dataDir'
import { readRawConfigFromDirectory } from './config/rawAppConfig'
import { readInputHistoryStoreFile } from './inputHistoryStore'
import { readProjectStoreFile } from './projectStore'
import { validateRestoredSkillsDirectory, validateSkillsConfigFile } from './skillsStore'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

export async function validateRestoredDataDirectory(root: string): Promise<void> {
  const configRoot = join(root, configDirName)
  normalizeAppConfigSnapshot(await readRawConfigFromDirectory(configRoot))
  await validateSkillsConfigFile(join(configRoot, skillsConfigFileName))
  const projects = getProjectStoreFile(root)
  const projectIds = new Set([DEFAULT_WORKSPACE_PROJECT_ID])
  const definitions = await readdir(getProjectsDir(root), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const hasDefinitions = (await Promise.all(definitions.filter(entry => entry.isDirectory()).map(entry => exists(join(getProjectsDir(root), entry.name, 'project.json'))))).some(Boolean)
  if (await exists(projects) || hasDefinitions) {
    const store = await readProjectStoreFile(projects)
    for (const project of store.projects) projectIds.add(project.id)
  }
  const inputHistory = getInputHistoryFile(root)
  if (await exists(inputHistory)) await readInputHistoryStoreFile(inputHistory)
  if (await exists(avatarTransformPath(root))) await readAvatarTransform(root)
  await validateRestoredSkillsDirectory(join(root, 'skills'), true)
  await validateRestoredTools(root)
  const catalog = getAgentCatalogFile(root)
  const conversationIds = AgentStorage.validateCatalogBackup(catalog, projectIds)
  const locations = new Map<string, string>()
  if (await exists(catalog)) {
    const database = new Database(catalog, { readonly: true, fileMustExist: true })
    try {
      for (const row of database.prepare('SELECT id, project_id FROM agent_conversations').all() as Array<{ id: string; project_id: string }>) locations.set(row.id, row.project_id)
    } finally { database.close() }
  }
  if (await exists(getProjectsDir(root))) for (const projectId of projectIds) {
    const conversationsDir = getAgentConversationsDir(root, projectId)
    if (!await exists(conversationsDir)) continue
    if (!(await lstat(conversationsDir)).isDirectory()) throw new Error('Conversation storage is not a directory.')
    for (const entry of await readdir(conversationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || locations.get(entry.name) !== projectId) throw new Error(`Unexpected conversation storage entry: ${entry.name}`)
    }
  }
  for (const id of conversationIds) {
    const projectId = locations.get(id)!
    const file = getAgentConversationDatabaseFile(id, root, projectId)
    if (!(await lstat(file)).isFile()) throw new Error(`Conversation database is not a regular file: ${id}`)
    NativeConversationDatabase.validateBackup(file, getAgentAttachmentsDir(id, root, projectId), new Set([projectId]), id)
  }
}
