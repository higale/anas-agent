import type { FilePatchPlan } from './filePatch'

// Transaction fixtures describe expected operations, then enter through the
// same text-patch protocol as model calls before resolving their targets.
export function asPatchInput({ operations, ...options }: Omit<FilePatchPlan, 'operations'> & {
  operations: Array<
    | { type: 'create'; path: string; content: string }
    | { type: 'delete'; path: string }
    | { type: 'update'; path: string; patch: string }
    | { type: 'move'; path: string; destination: string; patch: string }
  >
}) {
  const lines = ['*** Begin Patch']
  for (const operation of operations) {
    if (operation.type === 'create') {
      lines.push(`*** Add File: ${operation.path}`)
      if (operation.content !== '') {
        const contentLines = operation.content.split('\n')
        const finalNewline = operation.content.endsWith('\n')
        if (finalNewline) contentLines.pop()
        lines.push(...contentLines.map((line) => `+${line}`))
      }
    } else if (operation.type === 'delete') {
      lines.push(`*** Delete File: ${operation.path}`)
    } else {
      lines.push(`*** Update File: ${operation.path}`)
      if (operation.type === 'move') lines.push(`*** Move to: ${operation.destination}`)
      if (operation.patch !== undefined) {
        const patchLines = operation.patch.split('\n')
        if (patchLines.at(-1) === '') patchLines.pop()
        lines.push(...patchLines)
      }
    }
  }
  lines.push('*** End Patch')
  return { ...options, patch: lines.join('\n') }
}
