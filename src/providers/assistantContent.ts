// Content mappings preserve the imported LangChain Core 1.2.10 behavior (MIT).
// Attribution: THIRD_PARTY_NOTICES.md and data/licenses/langchain/LICENSE.
import { inputContentBlocks } from '../runtime/inputContent'

type Fields = Record<string, unknown>
type Call = { id?: string; name: string; args: unknown }

/** Content interpretation only. Native output retained by the caller owns replay. */
export interface AssistantContentSource {
  format: 'portable' | 'openai' | 'anthropic' | 'generic'
  content: string | Fields[]
  calls?: readonly Call[]
  partial?: boolean
  callFragments?: readonly { id?: string; name?: string; args?: string; index?: number }[]
  reasoning?: unknown
  toolOutputs?: unknown
}

function record(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' ? value as Fields : undefined
}

function callBlock(call: Call): Fields {
  return { type: 'tool_call', id: call.id, name: call.name, args: call.args }
}

function responseAnnotation(value: unknown): unknown {
  const item = record(value)
  if (item?.type === 'url_citation') return { type: 'citation', url: item.url, title: item.title,
    startIndex: item.start_index, endIndex: item.end_index }
  if (item?.type === 'file_citation') return { type: 'citation', title: item.filename,
    startIndex: item.index, endIndex: item.index, fileId: item.file_id }
  return value
}

function responseTools(values: unknown): Fields[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((value): Fields[] => {
    const item = record(value)
    if (!item) return []
    const action = record(item.action)
    const outcome = (output: Fields): Fields[] => item.status === 'completed' || item.status === 'failed'
      ? [{ type: 'server_tool_call_result', toolCallId: typeof item.id === 'string' ? item.id : '',
        status: item.status === 'completed' ? 'success' : 'error', output }] : []
    switch (item.type) {
      case 'web_search_call': return [
        { id: item.id, type: 'server_tool_call', name: 'web_search', args: typeof action?.query === 'string' ? { query: action.query } : {} },
        ...outcome(action ? { action } : {})
      ]
      case 'file_search_call': return [
        { id: item.id, type: 'server_tool_call', name: 'file_search', args: { queries: Array.isArray(item.queries) ? item.queries : [] } },
        ...outcome(Array.isArray(item.results) ? { results: item.results } : {})
      ]
      case 'code_interpreter_call': {
        const blocks: Fields[] = typeof item.code === 'string'
          ? [{ id: item.id, type: 'server_tool_call', name: 'code_interpreter', args: { code: item.code } }] : []
        const returnCode = item.status === 'completed' ? 0 : item.status === 'incomplete' ? 127 : item.status === 'failed' ? 1 : undefined
        for (const value of Array.isArray(item.outputs) ? item.outputs : []) {
          const output = record(value)
          if (output?.type !== 'logs') continue
          blocks.push({ type: 'server_tool_call_result', toolCallId: item.id ?? '', status: 'success',
            output: { type: 'code_interpreter_output', returnCode: returnCode ?? 0,
              stderr: returnCode ? String(output.logs) : undefined, stdout: returnCode ? undefined : String(output.logs) } })
        }
        return blocks
      }
      case 'mcp_call': case 'mcp_list_tools':
        return [{ id: item.id, type: 'server_tool_call', name: item.type, args: item.input }]
      case 'tool_search_call': {
        const extras = Object.fromEntries(['execution', 'status', 'call_id'].flatMap(key => typeof item[key] === 'string' ? [[key, item[key]]] : []))
        return [{ id: typeof item.id === 'string' ? item.id : '', type: 'server_tool_call', name: 'tool_search',
          args: { ...record(item.arguments) }, ...(Object.keys(extras).length ? { extras } : {}) }]
      }
      case 'tool_search_output': return [{ type: 'server_tool_call_result', toolCallId: typeof item.id === 'string' ? item.id : '',
        status: item.status === 'failed' ? 'error' : 'success', output: { tools: Array.isArray(item.tools) ? item.tools : [] },
        extras: { name: 'tool_search', ...(typeof item.execution === 'string' ? { execution: item.execution } : {}) } }]
      case 'image_generation_call': return [
        ...(typeof item.result === 'string' ? [{ type: 'image', mimeType: 'image/png', data: item.result,
          id: typeof item.id === 'string' ? item.id : undefined, metadata: { status: typeof item.status === 'string' ? item.status : undefined } }] : []),
        { type: 'non_standard', value }
      ]
      default: return [{ type: 'non_standard', value }]
    }
  })
}

function openAiContent(source: AssistantContentSource): Fields[] {
  if (typeof source.content === 'string') return [
    ...(source.content.length ? [{ type: 'text', text: source.content }] : []), ...(source.calls ?? []).map(callBlock)
  ]
  const reasoning = record(source.reasoning)
  const blocks: Fields[] = Array.isArray(reasoning?.summary) ? [{ type: 'reasoning',
    reasoning: reasoning.summary.flatMap(value => typeof record(value)?.text === 'string' ? [record(value)!.text] : []).join('') }] : []
  for (const block of source.content) {
    if (block.type !== 'text') continue
    const { text, annotations, phase, extras: existingExtras, ...rest } = block
    const extras = { ...record(existingExtras), ...(typeof phase === 'string' ? { phase } : {}) }
    blocks.push({ ...rest, ...(Object.keys(extras).length ? { extras } : {}), type: 'text', text: String(text),
      ...(Array.isArray(annotations) ? { annotations: annotations.map(responseAnnotation) } : {}) })
  }
  return [...blocks, ...(source.calls ?? []).map(callBlock), ...responseTools(source.toolOutputs)]
}

function anthropicAnnotation(value: unknown): Fields | undefined {
  const item = record(value)
  if (!item || typeof item.cited_text !== 'string') return undefined
  const locations: Record<string, [string, string, string]> = {
    char_location: ['char', 'start_char_index', 'end_char_index'],
    page_location: ['page', 'start_page_number', 'end_page_number'],
    content_block_location: ['block', 'start_block_index', 'end_block_index'],
    search_result_location: ['search', 'start_block_index', 'end_block_index']
  }
  const location = locations[String(item.type)]
  if (location) {
    const [source, start, end] = location
    const search = source === 'search'
    const title = search ? item.title : item.document_title
    if (typeof title !== 'string' || typeof item[start] !== 'number' || typeof item[end] !== 'number'
      || search && typeof item.source !== 'string') return undefined
    const rest = Object.fromEntries(Object.entries(item).filter(([key]) => ![search ? 'source' : 'document_title', 'title', start, end, 'cited_text'].includes(key)))
    return { ...rest, type: 'citation', source, ...(search ? { url: item.source } : {}), title,
      startIndex: item[start], endIndex: item[end], citedText: item.cited_text }
  }
  if (item.type === 'web_search_result_location' && typeof item.url === 'string' && typeof item.title === 'string' && typeof item.encrypted_index === 'string') {
    const { url, title, encrypted_index: index, cited_text: citedText, ...rest } = item
    return { ...rest, type: 'citation', source: 'url', url, title, startIndex: Number(index), endIndex: Number(index), citedText }
  }
  return undefined
}

function anthropicArgument(block: Fields, key: string): unknown {
  if (typeof block.input === 'string') return block.input
  const input = record(block.input)
  if (typeof input?.[key] === 'string') return input[key]
  if (typeof block.partial_json === 'string') {
    try { return record(JSON.parse(block.partial_json))?.[key] || '' } catch { /* incomplete input is still displayed */ }
  }
  return ''
}

function anthropicContent(source: AssistantContentSource): Fields[] {
  const blocks = typeof source.content === 'string' ? [{ type: 'text', text: source.content }] : source.content
  return blocks.map((block): Fields => {
    if (block.type === 'text' && typeof block.text === 'string') {
      const { text, citations, ...rest } = block
      return { ...rest, type: 'text', text, ...(Array.isArray(citations) && citations.length
        ? { annotations: citations.flatMap(value => { const citation = anthropicAnnotation(value); return citation ? [citation] : [] }) } : {}) }
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const { thinking, signature, ...rest } = block
      return { ...rest, type: 'reasoning', reasoning: thinking, signature }
    }
    if (block.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
      return { type: 'tool_call', id: block.id, name: block.name, args: block.input }
    }
    if (block.type === 'input_json_delta' && source.partial && source.callFragments?.length) {
      const { id, name, args, index } = source.callFragments[0]
      return { type: 'tool_call_chunk', id, name, args, index }
    }
    if (block.type === 'server_tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
      if (block.name === 'web_search' || block.name === 'code_execution') {
        const key = block.name === 'web_search' ? 'query' : 'code'
        return { id: block.id, type: 'server_tool_call', name: block.name, args: { [key]: anthropicArgument(block, key) } }
      }
    }
    if (block.type === 'web_search_tool_result' && typeof block.tool_use_id === 'string' && Array.isArray(block.content)) {
      return { type: 'server_tool_call_result', name: 'web_search', toolCallId: block.tool_use_id, status: 'success',
        output: { urls: block.content.flatMap(value => record(value)?.type === 'web_search_result' ? [record(value)!.url] : []) } }
    }
    if ((block.type === 'code_execution_tool_result' || block.type === 'mcp_tool_result') && typeof block.tool_use_id === 'string' && record(block.content)) {
      return { type: 'server_tool_call_result', name: block.type === 'mcp_tool_result' ? 'mcp_tool_use' : 'code_execution',
        toolCallId: block.tool_use_id, status: 'success', output: block.content }
    }
    if (block.type === 'mcp_tool_use') return { id: block.id, type: 'server_tool_call', name: 'mcp_tool_use', args: block.input }
    if (block.type === 'container_upload') return { type: 'server_tool_call', name: 'container_upload', args: block.input }
    if (block.type === 'search_result' || block.type === 'tool_result') return { id: block.id, type: 'non_standard', value: block }
    if (block.type === 'image' || block.type === 'document') {
      const media = { type: block.type, source: block.source }
      const converted = inputContentBlocks([media])[0]
      if (converted !== media) return converted as Fields
    }
    return { type: 'non_standard', value: block }
  })
}

export function assistantContentBlocks(source: AssistantContentSource): Fields[] {
  if (source.format === 'portable') {
    if (typeof source.content === 'string') throw new Error('Portable assistant content must contain blocks.')
    return source.content
  }
  if (source.format === 'openai') return openAiContent(source)
  if (source.format === 'anthropic') return anthropicContent(source)
  const blocks = inputContentBlocks(source.content) as Fields[]
  if (!source.partial) return [...blocks, ...(source.calls ?? [])
    .filter(call => !blocks.some(block => block.id === call.id && block.name === call.name)).map(callBlock)]
  for (const call of source.calls ?? []) {
    if (typeof source.content !== 'string' && call.id && !source.content.some(block => block.type === 'tool_call' && block.id === call.id)) {
      blocks.push({ ...call, ...callBlock(call) })
    }
  }
  return blocks
}
