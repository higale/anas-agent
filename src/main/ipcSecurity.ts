import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { runApplicationDataOperation } from './applicationDataLifecycle'

export type RendererLocation =
  | { kind: 'local'; url: string }
  | { kind: 'development'; origin: string; url: string }

const rendererLocations = new WeakMap<WebContents, RendererLocation>()

export function isMainRendererWindow(window: BrowserWindow): boolean {
  return !window.isDestroyed() && rendererLocations.has(window.webContents)
}

const applicationDataIpcPrefixes = [
  'plugins:',
  'agent:',
  'config:',
  'inputHistory:',
  'memory:',
  'mcp:',
  'projects:',
  'skills:',
  'tools:'
] as const

const applicationDataIpcChannels = new Set([
  'app:backupData',
  'app:cleanupData',
  'app:getDataStorageUsage',
  'app:getDeveloperHttpTraceEnabled',
  'app:getDeveloperHttpTraceUsage',
  'app:getLanguageResources',
  'app:getRuntimeTools',
  'app:openDataDir',
  'app:openDeveloperHttpTraceDir',
  'app:readHelp',
  'app:openLogDir',
  'app:openLogViewer',
  'app:openPath',
  'app:readEnvFile',
  'app:restartInConsole',
  'app:saveEnvFile',
  'app:setDeveloperHttpTraceEnabled',
  'app:showItemInFolder',
  'files:clearAvatar',
  'files:getAvatar',
  'files:getAvatarSource',
  'files:openText',
  'files:readAttachmentPreview',
  'files:readAttachments',
  'files:readDroppedAttachments',
  'files:releaseTemporaryAttachments',
  'files:saveAvatarCrop',
  'speech:listVoices'
])

export function ipcUsesApplicationData(channel: string): boolean {
  // Plugin opening performs data preparation inside the host, then awaits UI placement without a data lock.
  if (channel === 'plugins:invoke' || channel === 'plugins:openWindow') return false
  return applicationDataIpcChannels.has(channel)
    || applicationDataIpcPrefixes.some((prefix) => channel.startsWith(prefix))
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export function resolveRendererLocation(options: {
  isPackaged: boolean
  rendererFile: string
  rendererUrl?: string
}): RendererLocation {
  if (!options.isPackaged && options.rendererUrl) {
    const url = new URL(options.rendererUrl)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || !isLoopbackHostname(url.hostname)
      || url.username
      || url.password
    ) {
      throw new Error('Development renderer URL must use an HTTP(S) loopback origin.')
    }
    return {
      kind: 'development',
      origin: url.origin,
      url: url.toString()
    }
  }
  return {
    kind: 'local',
    url: pathToFileURL(options.rendererFile).toString()
  }
}

export function rendererLocationMatches(location: RendererLocation, frameUrl: string): boolean {
  try {
    const candidate = new URL(frameUrl)
    if (location.kind === 'development') return candidate.origin === location.origin
    candidate.hash = ''
    candidate.search = ''
    const expected = new URL(location.url)
    expected.hash = ''; expected.search = ''
    return candidate.toString() === expected.toString()
  } catch {
    return false
  }
}

export function registerMainRendererWindow(
  window: BrowserWindow,
  location: RendererLocation
): void {
  const webContents = window.webContents
  rendererLocations.set(webContents, location)
  window.once('closed', () => rendererLocations.delete(webContents))
}

interface ContentRenderer {
  location: RendererLocation
  allows(channel: string, args: unknown[]): boolean
}
const contentRenderers = new WeakMap<WebContents, ContentRenderer>()

export function registerContentRenderer(contents: WebContents, registration: ContentRenderer): void {
  contentRenderers.set(contents, registration)
  contents.once('destroyed', () => contentRenderers.delete(contents))
}

function assertApplicationIpcEvent(event: IpcMainInvokeEvent, channel: string, args: unknown[]): void {
  const content = contentRenderers.get(event.sender)
  if (!content) { assertTrustedIpcEvent(event); return }
  if (event.senderFrame !== event.sender.mainFrame || !event.senderFrame
    || !rendererLocationMatches(content.location, event.senderFrame.url)
    || !content.allows(channel, args)) throw new Error('IPC is unavailable for this panel context.')
}

export function assertTrustedIpcEvent(event: IpcMainInvokeEvent): void {
  const location = rendererLocations.get(event.sender)
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!location || !owner || owner.webContents !== event.sender) {
    throw new Error('IPC invocation did not originate from the registered main window.')
  }
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC invocation must originate from the main frame.')
  }
  if (!rendererLocationMatches(location, event.senderFrame.url)) {
    throw new Error('IPC invocation did not originate from the registered renderer location.')
  }
}

export function handleMainIpc<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertApplicationIpcEvent(event, channel, args)
    const invoke = () => listener(event, ...args as Args)
    return ipcUsesApplicationData(channel)
      ? runApplicationDataOperation(invoke, { snapshot: channel === 'app:backupData' })
      : invoke()
  })
}
