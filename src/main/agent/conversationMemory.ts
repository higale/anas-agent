import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getBundledMemoryDir } from '../config/dataDir'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { contentText } from '../../runtime/inputContent'
import { conversationContentBlocks } from '../../providers/conversationInput'
import type { PreferenceDocument, PreferenceScope } from '../../shared/preferenceMemory'

export async function buildMemoryRulesPrompt(): Promise<string> {
  const content = (await readFile(join(getBundledMemoryDir(), 'MEMORY_RULES.md'), 'utf8'))
    .replace(/^\uFEFF/, '').trim()
  if (!content) throw new Error('Bundled memory rules are missing: MEMORY_RULES.md')
  return `<memory_rules>\n${content}\n</memory_rules>`
}

export interface MemoryRecallDetails {
  query: string
  promptText: string
  memoryCount: number
}
export interface MemoryRecallOptions {
  enabled: boolean
  store: { preferences?: { read(scope: PreferenceScope): PreferenceDocument } }
  projectId: string
  onRecall?(details: MemoryRecallDetails): void
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Read the completed Markdown snapshot on every request, including tool rounds.
 * Pending candidates are never injected. History remains unchanged. */
export function createConversationMemoryProjector(options: MemoryRecallOptions) {
  let observed = ''
  return async (system: ConversationMessage, _messages: readonly ConversationMessage[],
    onRead?: (hashes: { global: string; project: string }) => void): Promise<ConversationMessage> => {
    if (!options.enabled || !options.store.preferences) return system
    const global = options.store.preferences.read({ kind: 'global' })
    const project = options.store.preferences.read({ kind: 'project', projectId: options.projectId })
    onRead?.({ global: global.hash, project: project.hash })
    const documents = [global, project].filter(document => document.content.trim())
    if (!documents.length) return system
    const promptText = [
      '<user_preferences>',
      'Saved user preferences. Preserve their scope and conditions; current explicit user instructions take precedence.',
      ...documents.map(document => [
        `<memory scope="${document.scope.kind}">`,
        xmlText(document.content), '</memory>'
      ].join('\n')),
      '</user_preferences>'
    ].join('\n')
    if (observed !== promptText) { observed = promptText; options.onRecall?.({ query: 'Global and project preferences', promptText, memoryCount: documents.length }) }
    return { kind: 'system', content: `${contentText(conversationContentBlocks(system))}\n\n${promptText}` }
  }
}
