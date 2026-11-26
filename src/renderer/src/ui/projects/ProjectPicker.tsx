import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, FolderKanban, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isDefaultWorkspaceProject, type Project } from '@shared/types'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { NoFocusButton } from '../NoFocusButton'
import { ProjectIcon } from './ProjectIcon'

interface ProjectPickerProps {
  disabled: boolean
  projects: Project[]
  selectedProjectId: string
  onCreateProject: () => void
  onSelectProject: (projectId: string) => void
}

export function ProjectPicker({
  disabled,
  projects,
  selectedProjectId,
  onCreateProject,
  onSelectProject
}: ProjectPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const selectedProject = projects.find((project) => project.id === selectedProjectId)

  function openCreateDialog(): void {
    setOpen(false)
    window.requestAnimationFrame(() => onCreateProject())
  }

  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <NoFocusButton
          className="project-picker-trigger"
          type="button"
          disabled={disabled}
          aria-label={t('project.select')}
        >
          {selectedProject
            ? <ProjectIcon
                iconData={selectedProject.iconData}
                color={selectedProject.iconColor}
                icon={selectedProject.icon}
                size={14}
              />
            : <FolderKanban size={14} />}
          <span className={selectedProject && isDefaultWorkspaceProject(selectedProject)
            ? 'project-default-workspace-name'
            : undefined}
          >
            {selectedProject?.name ?? t('project.select')}
          </span>
        </NoFocusButton>
      </DropdownMenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          className="project-picker-menu ui-menu ui-menu-list"
          side="top"
          align="start"
          sideOffset={7}
          collisionPadding={10}
        >
          <DropdownMenu.Group className="project-picker-scroll">
            {projects.map((project) => (
              <DropdownMenu.Item
                className="project-picker-item ui-menu-item ui-menu-item-row"
                key={project.id}
                onSelect={() => onSelectProject(project.id)}
              >
                <ProjectIcon iconData={project.iconData} color={project.iconColor} icon={project.icon} size={15} />
                <span className={`ui-truncate${isDefaultWorkspaceProject(project) ? ' project-default-workspace-name' : ''}`}>
                  {project.name}
                </span>
                {selectedProjectId === project.id && <Check className="project-picker-check" size={14} />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
          <DropdownMenu.Separator className="ui-menu-separator" />
          <DropdownMenu.Item className="project-picker-item ui-menu-item ui-menu-item-row" onSelect={openCreateDialog}>
            <Plus size={15} />
            <span>{t('project.create')}</span>
          </DropdownMenu.Item>
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}
