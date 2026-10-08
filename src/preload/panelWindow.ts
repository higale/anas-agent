import { contextBridge, ipcRenderer } from 'electron'
import type { PanelWindowApi, PanelWindowState } from '@shared/panels'

const api: PanelWindowApi = {
  getState: () => ipcRenderer.invoke('panel-window:state'),
  getLanguageResources: () => ipcRenderer.invoke('panel-window:languages'),
  moveToSidebar: () => ipcRenderer.invoke('panel-window:move'),
  invokeToolbarAction: id => ipcRenderer.invoke('panel-window:action', id),
  setLayout: bounds => ipcRenderer.invoke('panel-window:layout', bounds),
  setTooltip: value => ipcRenderer.invoke('panel-window:tooltip', value),
  onChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: PanelWindowState) => listener(state)
    ipcRenderer.on('panel-window:changed', handler)
    return () => ipcRenderer.removeListener('panel-window:changed', handler)
  }
}
contextBridge.exposeInMainWorld('panelWindow', api)
