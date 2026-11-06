import type { AgentRunActivity } from '@shared/agentTypes'
import { usePanelState } from './PanelViewState'
import type { DirectoryScope } from './activityDirectoryStore'

const scopeKey = (scope: DirectoryScope) => JSON.stringify([scope.runId, scope.subagentId])
export function scopeIsRunning(run: AgentRunActivity, scope: DirectoryScope): boolean {
  if (run.status !== 'running' && run.status !== 'interrupted') return false
  const child = scope.subagentId && run.subagents.find(item => item.id === scope.subagentId)
  return !scope.subagentId || Boolean(child && (child.status === 'running' || child.status === 'interrupted'))
}
interface Choice { active: boolean; open?: boolean }
interface Choices { running: boolean; values: Record<string, Choice> }
export interface ProcessDisclosurePhase { scope: DirectoryScope; key: string; active: boolean }
export interface ActivityDisclosures {
  open(scope: DirectoryScope, key: string, defaultOpen: boolean): boolean
  set(scope: DirectoryScope, key: string, open: boolean): void
}

/** A process ends at its following reply; a run ends at its terminal status.
 * Reset each choice once at its own boundary, independently of mounted rows. */
export function useActivityDisclosures(owner: string, runs: AgentRunActivity[], groups: ProcessDisclosurePhase[]): ActivityDisclosures {
  const [saved, save] = usePanelState<{ owner: string; scopes: Record<string, Choices> }>(`activity-disclosures:${owner}`, { owner, scopes: {} })
  let scopes = saved.owner === owner ? saved.scopes : {}
  for (const run of runs) for (const subagentId of [undefined, ...run.subagents.map(child => child.id)]) {
    const scope = { runId: run.runId, subagentId }, key = scopeKey(scope), running = scopeIsRunning(run, scope)
    const previous = scopes[key]
    if (previous?.running !== running) scopes = { ...scopes, [key]: { running,
      values: !running && previous ? Object.fromEntries(Object.entries(previous.values)
        .map(([id, choice]) => [id, choice.active ? { active: false } : choice])) : {} } }
  }
  const changedScopes = new Set<string>()
  for (const { scope, key, active } of groups) {
    const id = scopeKey(scope), current = scopes[id]
    if (!current || current.values[key]?.active === active) continue
    if (!changedScopes.has(id)) {
      scopes = { ...scopes, [id]: { ...current, values: { ...current.values } } }
      changedScopes.add(id)
    }
    scopes[id].values[key] = { active }
  }
  if (saved.owner !== owner || scopes !== saved.scopes) save({ owner, scopes })
  return {
    open: (scope, key, defaultOpen) => scopes[scopeKey(scope)]?.values[key]?.open ?? defaultOpen,
    set: (scope, key, open) => save(previous => {
      const id = scopeKey(scope), current = previous.scopes[id] ?? scopes[id]
      return { owner, scopes: { ...previous.scopes, [id]: { ...current, values: { ...current?.values,
        [key]: { active: current?.values[key]?.active ?? current.running, open } } } } }
    })
  }
}
