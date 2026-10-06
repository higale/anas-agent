import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('anasPluginTransport', {
  invoke: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke('plugin:invoke', method, params)
})
