import type OpenAI from 'openai'
import type { AnthropicNativeMessage } from './anthropicStream'

import type { ModelUsage } from '../runtime/modelUsage'

type Fields = Record<string, unknown>
function record(value: unknown): Fields { return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {} }

export function openAiChatUsage(response: OpenAI.Chat.ChatCompletion | OpenAI.Chat.ChatCompletionChunk): ModelUsage | undefined {
  const usage = response.usage ?? record((response as unknown as Fields).x_groq).usage as OpenAI.CompletionUsage | undefined
  if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') return undefined
  const input = record(usage.prompt_tokens_details), output = record(usage.completion_tokens_details)
  return { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens,
    input_token_details: Object.fromEntries([['audio', input.audio_tokens], ['cache_read', input.cached_tokens], ['cache_creation', input.cache_write_tokens]].filter(([, value]) => value != null)),
    output_token_details: Object.fromEntries([['audio', output.audio_tokens], ['reasoning', output.reasoning_tokens]].filter(([, value]) => value != null)) }
}

export function anthropicUsage(usage: AnthropicNativeMessage['usage'] | undefined): ModelUsage | undefined {
  // Compatible endpoints may omit usage. Missing evidence must stay unknown.
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined
  const creation = usage.cache_creation_input_tokens ?? 0, read = usage.cache_read_input_tokens ?? 0
  const input = usage.input_tokens + creation + read
  return { input_tokens: input, output_tokens: usage.output_tokens, total_tokens: input + usage.output_tokens,
    input_token_details: { cache_creation: creation, cache_read: read } }
}
