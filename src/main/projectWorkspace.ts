import type { AppSettings, Project } from '@shared/types'
import { getAppSettings } from './config/appConfig'
import { getDefaultWorkspaceDir } from './config/dataDir'

/** Resolve workspace defaults at the point of use, without changing the project definition. */
export async function resolveProjectSourceFolders(
  project: Pick<Project, 'sourceFolders'>,
  settings?: Pick<AppSettings, 'projectDefaultDirectory'>
): Promise<string[]> {
  if (project.sourceFolders.length) return project.sourceFolders
  const configured = settings ?? await getAppSettings()
  return [configured.projectDefaultDirectory || getDefaultWorkspaceDir()]
}
