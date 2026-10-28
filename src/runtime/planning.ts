import { z } from 'zod/v3'
import { planningToolDescription } from './planningDescription'

export const todoListSchema = z.array(z.object({
  content: z.string().describe('Content of the todo item'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('Status of the todo')
}))

export const planningToolSpec = {
  name: 'write_todos',
  description: planningToolDescription,
  inputSchema: z.object({ todos: todoListSchema.describe('List of todo items to update') })
}

export function planningUpdate(todos: z.infer<typeof todoListSchema>) {
  return { todos, content: `Updated todo list to ${JSON.stringify(todos)}` }
}

export const conflictingPlanUpdatesError = 'Error: The `write_todos` tool should never be called multiple times in parallel. Please call it only once per model invocation to update the todo list.'

/** A plan replaces the whole list. Reject every unresolved competing update,
 * while keeping already answered calls and unrelated capabilities untouched. */
export function conflictingPlanUpdates<Call extends { id?: string; name: string }>(calls: readonly Call[], answeredIds: ReadonlySet<string>): Call[] {
  const updates = calls.filter(call => call.name === planningToolSpec.name && !answeredIds.has(call.id!))
  return updates.length > 1 ? updates : []
}
