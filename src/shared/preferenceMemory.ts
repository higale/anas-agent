export type PreferenceScope = { kind: 'global' } | { kind: 'project'; projectId: string }
export type MemoryJobStage = 'pending' | 'extracting' | 'consolidating' | 'publishing' | 'completed' | 'failed' | 'cancelled'
export interface PreferenceDocument {
  scope: PreferenceScope
  content: string
  hash: string
}
export interface PreferenceFile extends PreferenceDocument { path: string }
export interface PreferenceCandidate {
  scope: 'global' | 'project'
  intent: 'remember' | 'correct' | 'forget'
  content: string
  evidence: string
}
export interface MemoryJob {
  id: string
  threadId: string
  projectId: string
  title: string
  sourceRevision: string
  lastRecordId: string
  trigger: string
  stage: MemoryJobStage
  createdAt: string
  updatedAt: string
  modelId?: string
  modelFingerprint?: string
  modelName?: string
  attempts: number
  retryAt?: number
  error?: string
  input: string
  candidates?: PreferenceCandidate[]
  calls: Array<{ phase: 'extract' | 'consolidate'; input: string; output?: string; durationMs?: number; inputTokens?: number; outputTokens?: number }>
  changes: Array<{ scope: PreferenceScope; before: string; after: string }>
}
export interface MemoryActivitySnapshot {
  status: 'foreground' | 'unconfigured' | 'unavailable' | 'idle' | 'pending' | 'running' | 'failed'
  error?: string
  job?: MemoryJob
}
export interface PreferenceMemoryApi {
  clear(): Promise<number>
  read(scope: PreferenceScope): Promise<PreferenceFile>
  activity(): Promise<MemoryActivitySnapshot>
  onChanged(listener: () => void): () => void
  save(scope: PreferenceScope, baseHash: string, content: string): Promise<{ status: 'saved' | 'conflict'; document: PreferenceFile }>
}
