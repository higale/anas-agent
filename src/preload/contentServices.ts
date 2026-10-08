import { ipcRenderer } from 'electron'
import type { ContentServices } from '@shared/panels'
import { subscribeAgentRuntimeEvents } from './agentEventSubscription'

/** The same read-only bridge is used by main and built-in content renderers. */
export const contentServices: ContentServices = {
  app: {
    readHelp: id => ipcRenderer.invoke('app:readHelp', id),
    openExternalUrl: url => ipcRenderer.invoke('app:openExternalUrl', url)
  },
  files: {
    readAttachmentPreview: (path, options) => ipcRenderer.invoke('files:readAttachmentPreview', path, options),
    showItemInFolder: path => ipcRenderer.invoke('files:showItemInFolder', path),
    readFileIcon: (path, size) => ipcRenderer.invoke('files:readFileIcon', path, size)
  },
  agent: {
    changes: {
      gitContents: (input, requestId) => ipcRenderer.invoke('agent:changes:gitContents', input, requestId),
      gitReferences: (input, requestId) => ipcRenderer.invoke('agent:changes:gitReferences', input, requestId),
      rounds: (input, requestId) => ipcRenderer.invoke('agent:changes:rounds', input, requestId),
      roundFiles: (input, requestId) => ipcRenderer.invoke('agent:changes:roundFiles', input, requestId),
      roundContents: (input, requestId) => ipcRenderer.invoke('agent:changes:roundContents', input, requestId),
      cancelRead: requestId => ipcRenderer.invoke('agent:changes:cancelRead', requestId),
      git: (input, requestId) => ipcRenderer.invoke('agent:changes:git', input, requestId)
    },
    threads: { get: threadId => ipcRenderer.invoke('agent:threads:get', threadId) },
    activities: {
      get: input => ipcRenderer.invoke('agent:activities:get', input),
      loadEarlier: input => ipcRenderer.invoke('agent:activities:loadEarlier', input),
      subagent: input => ipcRenderer.invoke('agent:activities:subagent', input)
    },
    onEvent: (listener, synchronize, onError) => subscribeAgentRuntimeEvents(ipcRenderer, listener, { synchronize, onError })
  }
}
