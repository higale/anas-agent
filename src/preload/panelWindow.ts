import { contextBridge, ipcRenderer } from 'electron'
import type { PanelWindowApi, PanelWindowState } from '@shared/panels'
import { panelPagesApi } from './panelPages'
import { contentServices } from './contentServices'

const api: PanelWindowApi = {
  pages: panelPagesApi,
  services: contentServices,
  getState: () => ipcRenderer.invoke('panel-window:state'),
  getLanguageResources: () => ipcRenderer.invoke('panel-window:languages'),
  moveToSidebar: () => ipcRenderer.invoke('panel-window:move'),
  invokeToolbarAction: id => ipcRenderer.invoke('panel-window:action', id),
  open: panel => ipcRenderer.invoke('panel-window:open', panel),
  updatePreferences: preferences => ipcRenderer.invoke('panels:preferences', preferences),
  review: (pageId, request, navigationId) => ipcRenderer.invoke('agent:panels:review', pageId, request, navigationId),
  onCloseFailed: listener => {
    ipcRenderer.on('panel-window:closeFailed', listener)
    return () => ipcRenderer.removeListener('panel-window:closeFailed', listener)
  },
  onChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: PanelWindowState) => listener(state)
    ipcRenderer.on('panel-window:changed', handler)
    return () => ipcRenderer.removeListener('panel-window:changed', handler)
  }
}
contextBridge.exposeInMainWorld('panelWindow', api)
