import { isCommandShellMetadata } from '../shared/commandShell'
import { ToolInputError } from './errors'
import type { ToolDefinition } from './toolDefinition'
import { isCustomToolMetadata } from '../shared/customTools'
import { pluginToolMetadata } from '../shared/pluginTools'

const writes = new Set(['write_file', 'apply_patch', 'restore_file_edit', 'create_directory', 'move_file', 'delete_file',
  'http_request', 'write_call', 'update_config'])

export function supportsApprovalParameter(tool: Pick<ToolDefinition, 'name' | 'metadata'>): boolean {
  if (isCustomToolMetadata(tool.metadata) || pluginToolMetadata(tool.metadata)) return false
  return writes.has(tool.name) || isCommandShellMetadata(tool.metadata)
}

export const approvalParameterSchema = {
  type: 'boolean', default: true, description: 'Required on every call: true to request approval, false when safe. Follow the shared smart approval rules.'
}

/** Approval metadata belongs to the host, not the business input schema. */
export function withoutApprovalParameter(tool: Pick<ToolDefinition, 'name' | 'metadata'> | undefined, input: unknown): unknown {
  if (!tool || !supportsApprovalParameter(tool) || !input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(input, 'needs_approval')) return input
  const { needs_approval, ...args } = input as Record<string, unknown>
  if (typeof needs_approval !== 'boolean') throw new ToolInputError('needs_approval must be a boolean.')
  return args
}

export function modelApprovalDecision(args: Readonly<Record<string, unknown>>): boolean {
  if (args.needs_approval === undefined) return true
  if (typeof args.needs_approval !== 'boolean') throw new ToolInputError('needs_approval must be a boolean.')
  return args.needs_approval
}

export function smartApprovalPrompt(safeFolders: readonly string[]): string {
  return [
    '<smart_approval>',
    'Before your first tool call, read these rules. On every JSON tool call whose definition includes needs_approval, explicitly provide true or false. Do not omit the field or rely on its default.',
    'The application first allows verified reads, safe-directory writes, and enabled Skill exemptions, even when you provide true.',
    'For operations not covered by those automatic checks, assess the complete operation: true requests user approval; false allows execution.',
    'Safe directories (including their descendants, after resolving links):',
    ...safeFolders.map(folder => `- ${JSON.stringify(folder)}`),
    'Reads and writes confined to these directories normally need no approval. A command working directory alone does not establish its effects.',
    'For writes elsewhere, use false when they clearly serve the user request, have a limited understood impact, and will not damage existing data. Examples include saving a new download or image, or creating a new task folder.',
    'Use true for overwriting or deleting important data, consequential system/application configuration changes, effects outside the requested scope, or when you cannot confidently assess the targets and impact.',
    'Do not request approval solely because a path is outside the safe directories. Consider the actual operation and existing contents, not just the directory name.',
    'Assess terminal input as an operation that can execute pending commands. Window resizing and read-only previews do not need approval.',
    'Freeform apply_patch has no needs_approval field. Submit the original patch grammar; the application checks its file targets.',
    'Enabled Skill script exemptions continue to apply. Do not add needs_approval to tools whose definitions do not include it.',
    '</smart_approval>'
  ].join('\n')
}
