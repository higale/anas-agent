import { BrowserWindow } from 'electron'
import { lstat, readFile } from 'node:fs/promises'
import type { ResolvedPluginTool } from '@shared/pluginTools'
import type { PluginBackendCallContext } from '@shared/plugins'
import { parsePluginManifest } from '@shared/plugins'
import { pluginToolId } from '@shared/pluginTools'
import { getDataDir, getBundledDataDir, getSystemPluginsDir, getPluginExamplesDir } from '../config/dataDir'
import { join } from 'node:path'
import { isMainRendererWindow } from '../ipcSecurity'
import { runApplicationDataOperation } from '../applicationDataLifecycle'
import { mirrorBundledDirectories } from '../bundledDirectories'
import { PluginStore } from './pluginStore'
import { PluginBackends, type PluginViewAction } from './pluginBackend'

let store: PluginStore | undefined
let backends: PluginBackends | undefined
let viewAction: PluginViewAction | undefined
export function setPluginBackendViewAction(action: PluginViewAction): void { viewAction = action }

let readViews: ((id: string) => PluginBackendCallContext['views']) | undefined

export function setPluginBackendViews(reader: (id: string) => PluginBackendCallContext['views']): void { readViews = reader }

export function changed(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (isMainRendererWindow(window)) window.webContents.send('plugins:changed')
  }
}

/** Called before opening the application, or while plugin runtimes are closed for restore. */
export async function initializePluginsStore(): Promise<void> {
  await pluginRuntime().store.exclusive(async () => {
    for (const [sourceName, target] of [
      ['plugins_system', getSystemPluginsDir()],
      ['plugins_examples', getPluginExamplesDir()]
    ] as const) {
      await mirrorBundledDirectories(join(getBundledDataDir(), sourceName), target, async (path, name) => {
        const directory = await lstat(path)
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Bundled plugin must be a regular directory.')
        const file = join(path, 'PLUGIN.json')
        const info = await lstat(file)
        if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid or oversized bundled plugin manifest.')
        const manifest = parsePluginManifest(JSON.parse(await readFile(file, 'utf8')))
        if (sourceName === 'plugins_system' && manifest.id !== name) throw new Error('Bundled plugin ID does not match its directory.')
      })
    }
  })
}

export function pluginRuntime(): { store: PluginStore; backends: PluginBackends } {
  if (!store) {
    store = new PluginStore(getDataDir(), { 'usage-meter': join(getSystemPluginsDir(), 'usage-meter') })
    backends = new PluginBackends(store, changed, undefined, undefined, id => {
      if (!readViews) throw new Error('Plugin host services are not ready.')
      return readViews(id)
    }, (id, method, params, assertAvailable) => {
      if (!viewAction) throw new Error('Plugin host services are not ready.')
      return viewAction(id, method, params, assertAvailable)
    })
  }
  return { store, backends: backends! }
}

export async function resolvePluginTools(selection: readonly string[]): Promise<ResolvedPluginTool[]> {
  if (!selection.length) return []
  const { store } = pluginRuntime()
  return store.exclusive(() => store.resolveTools(selection))
}

export async function pluginToolMapping(selection: readonly string[]): Promise<string> {
  if (!selection.length) return ''
  return (await resolvePluginTools([...new Set(selection)])).map(tool => `${pluginToolId(tool.pluginId, tool.id)}: ${tool.name}`).join('\n')
}

export async function buildPluginPrompts(selection: readonly string[], selectedTools: readonly string[], agent: 'main' | 'subagent'): Promise<string> {
  if (!selection.length) return ''
  const { store } = pluginRuntime()
  return store.exclusive(async () => {
    const fragments: string[] = [], usedTools = new Set<string>()
    let bytes = 0
    for (const id of [...new Set(selection)].sort()) {
      const [pluginId, , localId] = id.split(':')
      const plugin = await store.read(pluginId, false)
      if (!plugin.enabled || plugin.error) continue
      const prompt = plugin.manifest?.prompts?.find(item => item.id === localId)
      if (!prompt || (prompt.scope !== 'all' && prompt.scope !== agent)) continue
      const dependencies = prompt.tools.map(id => pluginToolId(pluginId, id))
      if (dependencies.some(id => !selectedTools.includes(id))) continue
      const contents = await store.promptText(pluginId, prompt.path)
      bytes += Buffer.byteLength(contents)
      if (bytes > 64 * 1024) throw new Error('Selected plugin prompts exceed 64 KiB.')
      fragments.push(`### ${id}\n${contents}`)
      for (const dependency of dependencies) usedTools.add(dependency)
    }
    if (!fragments.length) return ''
    const mapping = (await store.resolveTools([...usedTools])).map(tool => `${pluginToolId(tool.pluginId, tool.id)}: ${tool.name}`)
    return ['<plugin_instructions>', ...fragments, ...(mapping.length ? ['Tool names:', ...mapping] : []), '</plugin_instructions>'].join('\n\n')
  })
}

export async function invokePluginTool(tool: ResolvedPluginTool, params: unknown, options: {
  signal?: AbortSignal; onDispatch(): void
}): Promise<unknown> {
  const { result } = await runApplicationDataOperation(async () => {
    const { store, backends } = pluginRuntime()
    options.signal?.throwIfAborted()
    const prepared = await store.exclusive(async () => {
      await store.requireTool(tool)
      return backends.prepare(tool.pluginId)
    })
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error('Plugin call cancelled before dispatch.'))
      if (options.signal?.aborted) { abort(); return }
      options.signal?.addEventListener('abort', abort, { once: true })
      void prepared.ready.then(resolve, reject).finally(() => options.signal?.removeEventListener('abort', abort))
    })
    // Hold the installation lock through dispatch, not through the long-running call.
    const { result } = await store.exclusive(async () => {
      options.signal?.throwIfAborted()
      await store.requireTool(tool)
      return { result: backends.tool(tool.pluginId, tool.handler, params, prepared, { ...options, timeoutMs: tool.timeoutSeconds * 1000 }) }
    })
    return { result }
  })
  return result
}

export function notifyPluginViewsChanged(): void { backends?.viewsChanged() }

export async function stopPluginBackends(): Promise<void> {
  await backends?.stopAll()
}
