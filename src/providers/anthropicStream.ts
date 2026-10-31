import type Anthropic from '@anthropic-ai/sdk'
import { IncompleteModelResponseError, InvalidModelToolCallError, ModelOutputLimitError } from '../runtime/errors'
import { annotateModelFailure } from '../runtime/modelRecoveryDiagnostics'

export type AnthropicNativeMessage = Anthropic.Message | Anthropic.Beta.BetaMessage
export type AnthropicNativeEvent = Anthropic.MessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent
type Fields = Record<string, unknown>

/** One inference response, retaining provider data rather than framework chunks. */
export class AnthropicResponseAccumulator {
  private value?: Fields & { content: Fields[]; usage?: Fields }
  private readonly inputs = new Map<number, string>()
  private readonly openBlocks = new Set<number>()
  private complete = false
  private readonly malformedInputs = new Set<number>()

  get message(): AnthropicNativeMessage | undefined { return this.value as unknown as AnthropicNativeMessage | undefined }
  inputText(index: number): string | undefined { return this.inputs.get(index) }
  hasMalformedInput(index: number): boolean { return this.malformedInputs.has(index) }

  accept(event: AnthropicNativeEvent): void {
    if (this.complete) throw new Error('Anthropic sent data after the message completed.')
    if (event.type === 'message_start') {
      if (this.value) throw new Error('Anthropic started a second message in one response.')
      this.value = structuredClone(event.message) as unknown as typeof this.value
      return
    }
    if (!this.value) throw new Error('Anthropic stream has no initial message.')
    const message = this.value
    if (event.type === 'content_block_start') {
      if (message.content[event.index] !== undefined) throw new Error('Anthropic restarted an existing content block.')
      message.content[event.index] = structuredClone(event.content_block) as unknown as Fields
      this.openBlocks.add(event.index)
    } else if (event.type === 'content_block_delta') {
      const block = message.content[event.index]
      if (!block || !this.openBlocks.has(event.index)) throw new Error('Anthropic delta has no active content block.')
      const delta = event.delta as unknown as Fields
      switch (delta.type) {
        case 'text_delta': block.text = String(block.text ?? '') + String(delta.text ?? ''); break
        case 'thinking_delta': block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? ''); break
        case 'signature_delta': block.signature = delta.signature; break
        case 'input_json_delta': {
          const input = (this.inputs.get(event.index) ?? '') + String(delta.partial_json ?? '')
          this.inputs.set(event.index, input)
          break
        }
        case 'citations_delta': block.citations = [...Array.isArray(block.citations) ? block.citations : [], structuredClone(delta.citation)]; break
        case 'compaction_delta': block.content = String(block.content ?? '') + String(delta.content ?? ''); break
        default: throw new Error(`Unsupported Anthropic content delta: ${String(delta.type)}`)
      }
    } else if (event.type === 'content_block_stop') {
      const block = message.content[event.index]
      if (!block || !this.openBlocks.delete(event.index)) throw new Error('Anthropic closed an inactive content block.')
      const input = this.inputs.get(event.index)
      if (input !== undefined) {
        // A parsed string is a real input value; malformed JSON is a protocol
        // failure and must not be turned into a different, valid string value.
        try { block.input = JSON.parse(input) } catch { this.malformedInputs.add(event.index); block.input = input }
        this.inputs.delete(event.index)
      }
    } else if (event.type === 'message_delta') {
      Object.assign(message, structuredClone(event.delta))
      if (event.usage !== undefined) Object.assign(message.usage ??= {}, structuredClone(event.usage))
    } else if (event.type === 'message_stop') {
      if (this.openBlocks.size) throw annotateModelFailure(new IncompleteModelResponseError(), { response: this.value, inputs: [...this.inputs] })
      this.complete = true
    }
  }

  result(): AnthropicNativeMessage {
    if (!this.complete || !this.value) throw annotateModelFailure(new IncompleteModelResponseError(), { response: this.value, inputs: [...this.inputs] })
    if (this.malformedInputs.size) {
      const error = this.value.stop_reason === 'max_tokens' ? new ModelOutputLimitError() : new InvalidModelToolCallError('Anthropic returned malformed tool input JSON.')
      throw annotateModelFailure(error, { response: this.value })
    }
    return this.value as unknown as AnthropicNativeMessage
  }
}

export async function collectAnthropicMessage(source: AsyncIterable<AnthropicNativeEvent>, onEvent?: (event: AnthropicNativeEvent) => void | Promise<void>): Promise<AnthropicNativeMessage> {
  const response = new AnthropicResponseAccumulator()
  for await (const event of source) {
    response.accept(event)
    await onEvent?.(event)
  }
  return response.result()
}
