import OpenAI, { type ClientOptions } from 'openai'
import { consumeProviderStream } from './providerStream'
import { collectChatCompletion } from './chatCompletionStream'
import { IncompleteModelResponseError } from '../runtime/errors'

type ChatRequest = Omit<OpenAI.Chat.ChatCompletionCreateParams, 'stream'>

/** Provider-native data only; message persistence and tool dispatch belong to the runtime. */
export class OpenAiChatCompletions {
  private readonly client: OpenAI

  constructor(options: ClientOptions) {
    this.client = new OpenAI({ ...options, maxRetries: 0 })
  }

  async complete(request: ChatRequest, options: OpenAI.RequestOptions = {}): Promise<OpenAI.Chat.ChatCompletion> {
    options.signal?.throwIfAborted()
    const body = { ...request, stream: false as const }
    const transportOptions = { ...options, maxRetries: 0 }
    return body.response_format?.type === 'json_schema'
      ? this.client.chat.completions.parse(body, transportOptions)
      : this.client.chat.completions.create(body, transportOptions)
  }

  async *stream(request: ChatRequest, options: OpenAI.RequestOptions = {}): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
    options.signal?.throwIfAborted()
    const stream = await this.client.chat.completions.create({ ...request, stream: true }, { ...options, maxRetries: 0 })
    const choices = new Map<number, boolean>()
    for await (const chunk of consumeProviderStream(stream, options.signal)) {
      for (const choice of chunk.choices) choices.set(choice.index, Boolean(choice.finish_reason) || choices.get(choice.index) === true)
      yield chunk
    }
    if (!choices.size || [...choices.values()].some(complete => !complete)) throw new IncompleteModelResponseError()
  }

  completeStreaming(
    request: ChatRequest,
    options: OpenAI.RequestOptions = {},
    onChunk?: (chunk: OpenAI.Chat.ChatCompletionChunk) => void | Promise<void>
  ): Promise<OpenAI.Chat.ChatCompletion> {
    return collectChatCompletion(this.stream(request, options), onChunk)
  }
}
