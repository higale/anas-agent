import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { Stream } from '@anthropic-ai/sdk/core/streaming'
import { consumeProviderStream } from './providerStream'
import { IncompleteModelResponseError } from '../runtime/errors'

type MessageRequest = Omit<Anthropic.Messages.MessageCreateParams, 'stream'> & {
  betas?: string[]
}
type NativeMessage = Anthropic.Message | Anthropic.Beta.BetaMessage
type NativeEvent = Anthropic.MessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent

/** Native Messages transport; invocation policy and execution state belong to the runtime. */
export class AnthropicMessages {
  private readonly client: Anthropic

  constructor(options: ClientOptions) {
    this.client = new Anthropic({ ...options, maxRetries: 0 })
  }

  async complete(request: MessageRequest, options: Anthropic.RequestOptions = {}): Promise<NativeMessage> {
    options.signal?.throwIfAborted()
    const { betas, ...body } = request
    return betas?.length
      ? this.client.beta.messages.create({ ...body, betas, stream: false }, { ...options, maxRetries: 0 })
      : this.client.messages.create({ ...body, stream: false }, { ...options, maxRetries: 0 })
  }

  async openStream(request: MessageRequest, options: Anthropic.RequestOptions = {}): Promise<Stream<NativeEvent>> {
    options.signal?.throwIfAborted()
    const { betas, ...body } = request
    const source = betas?.length
      ? await this.client.beta.messages.create({ ...body, betas, stream: true }, { ...options, maxRetries: 0 })
      : await this.client.messages.create({ ...body, stream: true }, { ...options, maxRetries: 0 })
    // Return an SDK stream for current native consumers, while checking normal EOF
    // and releasing the response on cancellation or early iterator return.
    return new Stream(async function *() {
      let complete = false
      for await (const event of consumeProviderStream<NativeEvent>(source, options.signal)) {
        if (event.type === 'message_stop') complete = true
        yield event
      }
      if (!complete) throw new IncompleteModelResponseError()
    }, source.controller)
  }
}
