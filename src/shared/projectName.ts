import type { Project } from './types'

type NamedProject = Pick<Project, 'id' | 'name'>

export function hasDuplicateProjectName(projects: readonly NamedProject[], name: string, excludedProjectId?: string): boolean {
  return projects.some(project => project.id !== excludedProjectId
    && project.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
}

export function getAvailableProjectName(projects: readonly NamedProject[], prefix: string, excludedProjectId?: string): string {
  for (let number = 1; ; number += 1) {
    const candidate = `${prefix}${number}`
    if (!hasDuplicateProjectName(projects, candidate, excludedProjectId)) return candidate
  }
}
