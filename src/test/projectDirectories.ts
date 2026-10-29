import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Build current-layout fixtures explicitly; this is never a product upgrade path. */
export async function writeProjectFixture(root: string, document: { version?: number; projects: Record<string, unknown>[] }): Promise<void> {
  const states = []
  await mkdir(join(root, 'db/projects'), { recursive: true })
  for (const project of document.projects) {
    const { pinned, collapsed, sort_order, thread_order, ...definition } = project
    const directory = join(root, 'db/projects', String(project.id))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'project.json'), JSON.stringify({ version: 0, project: definition }))
    states.push({ id: project.id, pinned, collapsed, sort_order, thread_order })
  }
  await writeFile(join(root, 'db/projects/state.json'), JSON.stringify({ version: document.version, storage_layout: 'project-directories', projects: states }))
}

export async function readProjectFixture(root: string): Promise<string> {
  const state = JSON.parse(await readFile(join(root, 'db/projects/state.json'), 'utf8'))
  const projects = []
  for (const entry of await readdir(join(root, 'db/projects'), { withFileTypes: true })) if (entry.isDirectory()) {
    const document = JSON.parse(await readFile(join(root, 'db/projects', entry.name, 'project.json'), 'utf8'))
    projects.push({ ...document.project, ...state.projects.find((item: { id: string }) => item.id === entry.name) })
  }
  return JSON.stringify({ version: state.version, projects })
}

/** Relocate fixture resources without opening or rewriting the frozen SQLite bytes. */
export async function placeFrozenConversationsInProject(root: string, projectId: string): Promise<void> {
  const directory = join(root, 'db/projects', projectId)
  await mkdir(directory, { recursive: true })
  await rename(join(root, 'db/conversations'), join(directory, 'conversations'))
  await rm(join(root, 'db/projects.json'), { force: true })
}
