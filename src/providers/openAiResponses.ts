import OpenAI, { type ClientOptions } from 'openai'
import { consumeProviderStream } from './providerStream'
import { IncompleteModelResponseError } from '../runtime/errors'
import { collectResponses } from './openAiResponsesOutput'

type ResponseRequest = Omit<OpenAI.Responses.ResponseCreateParams, 'stream'>
type RequestOptions = OpenAI.RequestOptions

/** Native protocol transport. Retry ownership stays with the application runtime. */
export class OpenAiResponses {
  private readonly client: OpenAI

  constructor(options: ClientOptions) {
    this.client = new OpenAI({ ...options, maxRetries: 0 })
  }

  async complete(request: ResponseRequest, options: RequestOptions = {}): Promise<OpenAI.Responses.Response> {
    options.signal?.throwIfAborted()
    const body = { ...request, stream: false as const }
    const transportOptions = { ...options, maxRetries: 0 }
    // Keep structured-output parsing and native output together, including refusals.
    return body.text?.format?.type === 'json_schema'
      ? this.client.responses.parse(body, transportOptions)
      : this.client.responses.create(body, transportOptions)
  }

  async *stream(request: ResponseRequest, options: RequestOptions = {}): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
    options.signal?.throwIfAborted()
    const stream = await this.client.responses.create({ ...request, stream: true }, { ...options, maxRetries: 0 })
    let terminal = false
    for await (const event of consumeProviderStream(stream, options.signal)) {
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) terminal = true
      yield event
    }
    if (!terminal) throw new IncompleteModelResponseError()
  }

  completeStreaming(request: ResponseRequest, options: RequestOptions = {}, onEvent?: (event: OpenAI.Responses.ResponseStreamEvent) => void | Promise<void>) {
    return collectResponses(this.stream(request, options), onEvent)
  }
}
