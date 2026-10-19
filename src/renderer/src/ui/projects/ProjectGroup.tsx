import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isDefaultWorkspaceProject, type Project } from '@shared/types'
import { NoFocusButton } from '../NoFocusButton'
import { ProjectDetailsContextMenu, ProjectDetailsMenu } from './ProjectDetailsMenu'
import { ProjectIcon } from './ProjectIcon'

interface ProjectGroupProps {
  children: ReactNode
  project: Project
  selected?: boolean
  sortable?: boolean
  threadCount: number
  onDelete: (project: Project) => void
  onDeleteThreads: (project: Project) => void
  onEdit: (project: Project) => void
  onStartChat: (projectId: string) => void
  onToggleCollapsed: (project: Project) => void | Promise<void>
  onTogglePinned: (project: Project) => void | Promise<void>
}

export function ProjectGroup({
  children,
  project,
  selected = false,
  sortable = false,
  threadCount,
  onDelete,
  onDeleteThreads,
  onEdit,
  onStartChat,
  onToggleCollapsed,
  onTogglePinned
}: ProjectGroupProps) {
  const { t } = useTranslation()
  const defaultWorkspace = isDefaultWorkspaceProject(project)

  async function startChat(): Promise<void> {
    if (project.collapsed) await onToggleCollapsed(project)
    onStartChat(project.id)
  }

  return (
    <section className="project-thread-group" data-default-workspace={defaultWorkspace ? true : undefined}
      data-sidebar-sort-id={sortable ? project.id : undefined}
      data-sidebar-sort-kind={sortable ? 'project' : undefined}
      data-sidebar-sort-group={sortable ? project.kind : undefined}
      data-sidebar-sort-pinned={sortable ? String(project.pinned) : undefined}>
      <ProjectDetailsContextMenu
        project={project}
        threadCount={threadCount}
        onDelete={onDelete}
        onDeleteThreads={onDeleteThreads}
        onEdit={onEdit}
        onTogglePinned={onTogglePinned}
      >
        <div
          className="project-thread-heading"
          data-pinned={project.pinned ? true : undefined}
          data-selected={selected && !defaultWorkspace ? true : undefined}
        >
          <NoFocusButton
            className={defaultWorkspace ? 'thread-group-label' : 'project-thread-label'}
            data-sidebar-drag-handle={sortable ? true : undefined}
            type="button"
            aria-expanded={!project.collapsed}
            aria-label={t(project.collapsed ? 'project.expand' : 'project.collapse', { name: project.name })}
            onClick={() => void onToggleCollapsed(project)}
          >
            {!defaultWorkspace && <ProjectIcon color={project.iconColor} icon={project.icon} kind={project.kind} size={15} />}
            <span className="ui-truncate">
              {defaultWorkspace ? t('common.default') : project.name}
            </span>
            {defaultWorkspace && <ChevronRight className="thread-group-chevron" size={13} aria-hidden="true" />}
          </NoFocusButton>
          <ProjectDetailsMenu
            placement="sidebar"
            project={project}
            threadCount={threadCount}
            onDelete={onDelete}
            onDeleteThreads={onDeleteThreads}
            onEdit={onEdit}
            onTogglePinned={onTogglePinned}
          >
            <NoFocusButton
              className="project-thread-more ui-tool-button"
              type="button"
              aria-label={t('project.show_details', { name: project.name })}
            >
              <MoreHorizontal size={14} />
            </NoFocusButton>
          </ProjectDetailsMenu>
          <NoFocusButton
            className="project-thread-new-chat ui-tool-button"
            type="button"
            aria-label={t('project.new_chat', { name: project.name })}
            data-tooltip={t('project.new_chat', { name: project.name })}
            onClick={() => void startChat()}
          >
            <Plus size={14} />
          </NoFocusButton>
        </div>
      </ProjectDetailsContextMenu>
      {children}
    </section>
  )
}
