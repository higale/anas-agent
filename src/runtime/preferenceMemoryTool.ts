import { z } from 'zod/v3'

export const updateMemoryToolSpec = {
  name: 'update_memory',
  description: 'Replace the complete global or current-project preference Markdown. Use an empty body only to forget all preferences in the chosen scope.',
  inputSchema: z.object({
    scope: z.enum(['global', 'project']),
    content: z.string()
  }).strict()
}
