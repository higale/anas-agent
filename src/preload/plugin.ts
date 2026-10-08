import { contextBridge, ipcRenderer } from 'electron'
import { panelToolbarApi } from './panelToolbar'

contextBridge.exposeInMainWorld('anasPluginTransport', {
  ...panelToolbarApi,
  invoke: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke('plugin:invoke', method, params),
  onViewChanged: (listener: (view: { instanceId: string; location: 'sidebar' | 'window' }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, view: { instanceId: string; location: 'sidebar' | 'window' }) => listener(view)
    ipcRenderer.on('plugin:viewChanged', handler)
    return () => ipcRenderer.removeListener('plugin:viewChanged', handler)
  }
})
