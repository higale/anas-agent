import { ipcRenderer } from 'electron'
import type { PanelActionRequest, PanelToolbarApi } from '@shared/panelToolbar'

let listener: Parameters<PanelToolbarApi['onToolbarAction']>[0] | undefined
ipcRenderer.on('panel-toolbar:action', async (_event, request: PanelActionRequest) => {
  let failed = false
  try {
    if (!listener) throw new Error('No panel action handler.')
    await listener(request.actionId)
  } catch { failed = true }
  // Closing the page also cancels the host request; a late completion is harmless.
  await ipcRenderer.invoke('panel-toolbar:complete', request.requestId, failed).catch(() => undefined)
})
export const panelToolbarApi: PanelToolbarApi = {
  setToolbar: toolbar => ipcRenderer.invoke('panel-toolbar:set', toolbar),
  onToolbarAction: callback => {
    if (listener) throw new Error('Panel action handler already registered.')
    listener = callback
    return () => { if (listener === callback) listener = undefined }
  }
}
