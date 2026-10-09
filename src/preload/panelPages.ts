import { ipcRenderer } from 'electron'
import type { PanelPageApi, PanelPageCommand } from '@shared/panelLifecycle'

export const panelPagesApi: PanelPageApi = {
  list: () => ipcRenderer.invoke('panel-page:list'),
  context: pageId => ipcRenderer.invoke('panel-page:context', pageId),
  escape: pageId => ipcRenderer.invoke('panel-page:escape', pageId),
  ready: pageId => ipcRenderer.invoke('panel-page:ready', pageId),
  failed: pageId => ipcRenderer.invoke('panel-page:failed', pageId),
  complete: (pageId, requestId, result, failed) => ipcRenderer.invoke('panel-page:complete', pageId, requestId, result, failed),
  setToolbar: (pageId, toolbar) => ipcRenderer.invoke('panel-page:toolbar', pageId, toolbar),
  pluginInvoke: (pageId, method, params) => ipcRenderer.invoke('panel-page:plugin', pageId, method, params),
  onChanged: listener => {
    ipcRenderer.on('panel-page:changed', listener)
    return () => ipcRenderer.removeListener('panel-page:changed', listener)
  },
  onCommand: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: PanelPageCommand) => listener(value)
    ipcRenderer.on('panel-page:command', handler)
    return () => ipcRenderer.removeListener('panel-page:command', handler)
  },
  onCancel: listener => {
    const handler = (_event: Electron.IpcRendererEvent, id: string) => listener(id)
    ipcRenderer.on('panel-page:cancel', handler)
    return () => ipcRenderer.removeListener('panel-page:cancel', handler)
  }
}
