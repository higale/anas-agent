import { isAbsolute } from 'node:path'
import type { Project } from '@shared/types'
import { resolveProjectSourceFolders } from './projectWorkspace'
import { isSameOrInsideDirectory } from './pathContainment'
import { canonicalizeAbsolutePath, resolveCanonicalWorkspacePath } from './workspacePath'

export async function resolveWorkspaceImagePath(
  filePath: string,
  project?: Project
): Promise<string | undefined> {
  if (isAbsolute(filePath)) return filePath
  if (!project) return undefined
  const [primaryFolder] = await resolveProjectSourceFolders(project)
  const [root, target] = await Promise.all([
    canonicalizeAbsolutePath(primaryFolder, 'follow'),
    resolveCanonicalWorkspacePath(filePath, primaryFolder, 'follow')
  ])
  if (!isSameOrInsideDirectory(root.canonicalPath, target.canonicalPath)) {
    throw new Error('Relative image path must stay inside the primary project folder.')
  }
  return target.canonicalPath
}
