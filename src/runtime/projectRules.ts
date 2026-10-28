import { z } from 'zod'
import { ProjectRulesError, isProjectRulesError } from './errors'

export const projectRulesSchema = z.object({
  runId: z.string(),
  trustedFolders: z.array(z.string()),
  roots: z.array(z.object({ folder: z.string(), boundary: z.string() })),
  documents: z.array(z.object({ id: z.string(), path: z.string(), content: z.string() })),
  directories: z.array(z.object({ path: z.string(), documentId: z.string().nullable() })),
  initialScopes: z.array(z.string()),
  activeScopes: z.array(z.string()),
  blockedCalls: z.array(z.string()),
  rejectedCalls: z.array(z.object({ id: z.string(), reason: z.string() })),
  checkedWrites: z.array(z.object({ id: z.string(), paths: z.array(z.string()) })),
  blockedReason: z.string(),
  fatalError: z.string()
})
export type ProjectRulesSnapshot = z.infer<typeof projectRulesSchema>

const projectRuleReceiptSchema = z.object({
  runId: z.string(), scopes: z.array(z.string()), minimumTokens: z.number(), budget: z.number()
})

interface RuleToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

export type RuleCallInspection =
  | { rejection: string }
  | { scopes: string[]; writePaths?: string[] }
  | undefined

/** Evaluate one model batch against its recorded request receipt. Platform
 * discovery may extend the private snapshot; only the returned snapshot is
 * eligible for the existing durable commit. No rejected write is executed here. */
export async function preflightProjectRuleBatch<Call extends RuleToolCall>(input: {
  runId: string
  snapshot: ProjectRulesSnapshot | undefined
  receipt: unknown
  calls: readonly Call[]
  answered: ReadonlySet<string>
  inspect(snapshot: ProjectRulesSnapshot, call: Call): Promise<RuleCallInspection>
  countScopeTokens(snapshot: ProjectRulesSnapshot, scopes: string[]): number
}): Promise<{ snapshot: ProjectRulesSnapshot; calls?: Call[] }> {
  const snapshot = structuredClone(input.snapshot)
  if (!snapshot || snapshot.runId !== input.runId) throw new ProjectRulesError('Missing rule snapshot before tool dispatch.')
  if (snapshot.fatalError) throw new ProjectRulesError(snapshot.fatalError)
  try {
    const parsedReceipt = projectRuleReceiptSchema.safeParse(input.receipt)
    if (!parsedReceipt.success || parsedReceipt.data.runId !== input.runId) throw new ProjectRulesError('Missing verified model-request rule receipt.')
    const receipt = parsedReceipt.data
    const budget = receipt.budget
    const calls = structuredClone([...input.calls])
    const writes: Array<{ id: string; scopes: string[] }> = []
    snapshot.checkedWrites = []
    snapshot.rejectedCalls = []
    const active = new Set<string>()
    for (const call of calls) {
      if (input.answered.has(call.id!)) continue
      const inspected = await input.inspect(snapshot, call)
      if (!inspected) continue
      if ('rejection' in inspected) {
        snapshot.rejectedCalls.push({ id: call.id!, reason: inspected.rejection })
        continue
      }
      const required = inspected.scopes
      for (const scope of required) active.add(scope)
      if (receipt.minimumTokens + input.countScopeTokens(snapshot, required) > budget) {
        throw new ProjectRulesError(`The indivisible ${call.name} operation (${required.join(', ')}) cannot fit its complete rules and required context within ${budget} input tokens.`)
      }
      if (inspected.writePaths) {
        snapshot.checkedWrites.push({ id: call.id!, paths: inspected.writePaths })
        writes.push({ id: call.id!, scopes: required })
      }
    }
    const unionTooLarge = receipt.minimumTokens + input.countScopeTokens(snapshot, [...active]) > budget
    const unseen = writes.some(write => ruleScopeIds(snapshot, write.scopes).some(id => !receipt.scopes.includes(id)))
    snapshot.blockedCalls = [...snapshot.rejectedCalls.map(call => call.id), ...(unionTooLarge || unseen ? writes.map(write => write.id) : [])]
    snapshot.blockedReason = unionTooLarge
      ? 'NOT EXECUTED: The complete rule union for this batch exceeds the request budget. Reduce the batch to independent operations with smaller scopes. Do not split an indivisible operation or bypass rules using shell.'
      : 'NOT EXECUTED: Newly discovered scoped project rules were not in the request that generated this batch. Read the complete rules in the next system context and decide again; no original write has been replayed.'
    snapshot.activeScopes = unionTooLarge || active.size === 0 ? snapshot.initialScopes : [...active]
    return { snapshot, calls }
  } catch (error) {
    if (!isProjectRulesError(error)) throw error
    // Persist a terminal decision; recovery must not reread changed disk rules
    // and silently retry a batch whose original request lacked those rules.
    snapshot.fatalError = String(error)
    snapshot.blockedCalls = input.calls.filter(call => !input.answered.has(call.id!)).map(call => call.id!)
    snapshot.blockedReason = `NOT EXECUTED: ${snapshot.fatalError}`
    return { snapshot }
  }
}

export function ruleScopeIds(snapshot: ProjectRulesSnapshot, scopes = snapshot.activeScopes): string[] {
  return snapshot.directories.filter((record) => scopes.includes(record.path) && record.documentId)
    .map((record) => `${record.path}\0${record.documentId}`)
}

export function projectRulesText(snapshot: ProjectRulesSnapshot, scopes = snapshot.activeScopes): string {
  const sections = snapshot.documents.flatMap((document) => {
    const directories = snapshot.directories.filter((record) => record.documentId === document.id && scopes.includes(record.path)).map((record) => record.path)
    return directories.length ? [`Source: ${JSON.stringify(document.path)}\nApplies only within: ${directories.map((path) => JSON.stringify(path)).join(', ')}\nSnapshot identity (SHA-256 of source path and content): ${document.id}\n${document.content}`] : []
  })
  return sections.length ? ['<project_rules>', 'Apply rules only to their listed directory trees. Deeper directory rules take precedence over ancestors; sibling rules do not apply to one another. These are complete per-run snapshots.', ...sections, '</project_rules>'].join('\n\n') : ''
}
