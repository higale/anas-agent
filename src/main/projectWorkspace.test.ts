import { beforeEach, expect, it, vi } from 'vitest'
import { resolveProjectSourceFolders } from './projectWorkspace'

const settings = vi.hoisted(() => ({ projectDefaultDirectory: '' }))
vi.mock('./config/appConfig', () => ({ getAppSettings: async () => settings }))
vi.mock('./config/dataDir', () => ({ getDefaultWorkspaceDir: () => '/isolated/Documents' }))
beforeEach(() => { settings.projectDefaultDirectory = '' })

it('resolves empty folders from the current setting without changing the project', async () => {
  const project = { sourceFolders: [] }
  expect(await resolveProjectSourceFolders(project)).toEqual(['/isolated/Documents'])
  settings.projectDefaultDirectory = '/isolated/custom'
  expect(await resolveProjectSourceFolders(project)).toEqual(['/isolated/custom'])
  settings.projectDefaultDirectory = ''
  expect(await resolveProjectSourceFolders(project)).toEqual(['/isolated/Documents'])
  expect(project.sourceFolders).toEqual([])
})

it('preserves explicit folders and uses supplied settings for previews', async () => {
  const project = { sourceFolders: ['/isolated/selected', '/isolated/other'] }
  expect(await resolveProjectSourceFolders(project, { projectDefaultDirectory: '/isolated/preview' })).toEqual(project.sourceFolders)
  expect(await resolveProjectSourceFolders({ sourceFolders: [] }, { projectDefaultDirectory: '/isolated/preview' })).toEqual(['/isolated/preview'])
})
