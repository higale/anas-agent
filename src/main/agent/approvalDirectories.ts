import { app } from 'electron'
import { tmpdir } from 'node:os'
import { getTempDir } from '../config/dataDir'
import type { AgentAccessMode } from '../../shared/agentTypes'

export interface ApprovalDirectories {
  temporary: string[]
  personal: string[]
}

export function applicationApprovalDirectories(): ApprovalDirectories {
  return { temporary: [getTempDir(), tmpdir()],
    personal: app ? ['desktop', 'downloads', 'documents', 'pictures'].map(name => app.getPath(name as 'desktop' | 'downloads' | 'documents' | 'pictures')) : [] }
}

export function safeApprovalFolders(projects: readonly string[], mode: AgentAccessMode, directories?: ApprovalDirectories): string[] {
  return [...new Set([...projects, ...(directories?.temporary ?? []), ...(mode === 'smart_approval' ? directories?.personal ?? [] : [])])]
}
