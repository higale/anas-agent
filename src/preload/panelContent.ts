import { contextBridge, ipcRenderer } from 'electron'
import type { PanelContentApi, PanelWindowState } from '@shared/panels'
import { contentServices } from './contentServices'
import { panelToolbarApi } from './panelToolbar'

const api: PanelContentApi = {
  ...panelToolbarApi,
  getState: () => ipcRenderer.invoke('panel-content:state'),
  getLanguageResources: () => ipcRenderer.invoke('panel-content:languages'),
  onChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: PanelWindowState) => listener(state)
    ipcRenderer.on('panel-content:changed', handler)
    return () => ipcRenderer.removeListener('panel-content:changed', handler)
  },
  open: panel => ipcRenderer.invoke('panel-content:open', panel),
  updatePreferences: preferences => ipcRenderer.invoke('panel-content:preferences', preferences),
  escape: () => ipcRenderer.invoke('panel-content:escape'),
  review: request => ipcRenderer.invoke('agent:panels:review', request),
  services: contentServices
}
contextBridge.exposeInMainWorld('panelContent', api)
