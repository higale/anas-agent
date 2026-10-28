import { anthropicUsage } from './modelUsage'
import type { AnthropicNativeMessage } from './anthropicStream'
type Fields = Record<string, unknown>

/** Retain the native blocks, including signatures, citations and server tools. */
export function readAnthropicResponse(response: AnthropicNativeMessage) {
  const { content, ...metadata } = response
  const calls: Array<{ id: string; name: string; args: unknown; type: 'tool_call' }> = []
  const invalid: Array<{ id: string; name: string; args: string; error: string; type: 'invalid_tool_call' }> = []
  for (const part of content) if (part.type === 'tool_use') {
    if (part.input !== undefined) calls.push({
      id: part.id, name: part.name, args: part.input, type: 'tool_call' })
    else invalid.push({ id: part.id, name: part.name, args: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
      error: 'Tool input is missing.', type: 'invalid_tool_call' })
  }
  const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const plain = content.length === 1 && content[0].type === 'text' && !content[0].citations?.length
  return { id: response.id, text, content: plain ? text : structuredClone(content), calls, invalidCalls: invalid,
    metadata, usage: anthropicUsage(response.usage) }
}

export function anthropicResponseBlock(block: Fields, index: number, complete: boolean): Fields {
  const extras = (used: string[]) => {
    const fields = Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'type' && !used.includes(key)))
    return Object.keys(fields).length ? { extras: { anthropic: fields } } : {}
  }
  if (block.type === 'text') return { type: 'text', text: block.text ?? '', index,
    ...(Array.isArray(block.citations) ? { annotations: block.citations } : {}), ...extras(['text', 'citations']) }
  if (block.type === 'thinking') return { type: 'reasoning', reasoning: block.thinking ?? '', index,
    ...(block.signature !== undefined ? { signature: block.signature } : {}), ...extras(['thinking', 'signature']) }
  if (block.type === 'tool_use' || block.type === 'server_tool_use') {
    const type = block.type === 'tool_use' ? 'tool_call' : 'server_tool_call'
    if (complete && block.input === undefined) {
      return { type: 'invalid_tool_call', id: block.id, name: block.name, args: String(block.input), error: 'Tool input is missing.' }
    }
    return { type: complete ? type : `${type}_chunk`, id: block.id, name: block.name,
      args: complete ? block.input : block.input && Object.keys(block.input as object).length ? JSON.stringify(block.input) : '', index, ...extras(['id', 'name', 'input']) }
  }
  return { type: 'non_standard', value: { ...block }, index }
}
