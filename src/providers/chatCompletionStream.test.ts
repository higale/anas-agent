import type OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { collectChatCompletion } from './chatCompletionStream'
import { IncompleteModelResponseError } from '../runtime/errors'

async function *frames(choices: unknown[], usage?: OpenAI.CompletionUsage): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
  for (const choice of choices) yield {
    id: 'chat_fixture', object: 'chat.completion.chunk', model: 'fixture', created: 1,
    choices: Array.isArray(choice) ? choice : [choice]
  } as OpenAI.Chat.ChatCompletionChunk
  if (usage) yield { id: 'chat_fixture', object: 'chat.completion.chunk', model: 'fixture', created: 1,
    choices: [], usage } as OpenAI.Chat.ChatCompletionChunk
}

describe('native Chat Completions aggregation', () => {
  it('assembles text, reasoning, tool arguments and usage without losing initial call metadata', async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }
    const response = await collectChatCompletion(frames([
      { index: 0, delta: { content: 'Hello', reasoning_content: 'First', tool_calls: [
        { index: 0, id: 'call_a', type: 'function', function: { name: 'look', arguments: '{"path":' } }
      ] }, finish_reason: null },
      { index: 0, delta: { content: ' world', reasoning_content: ' next', tool_calls: [
        { index: 0, id: '', function: { name: 'up', arguments: '"a"}' } }
      ] }, finish_reason: 'tool_calls' }
    ], usage))
    expect(response).toMatchObject({ id: 'chat_fixture', object: 'chat.completion', usage, choices: [{
      index: 0, finish_reason: 'tool_calls', message: { content: 'Hello world', reasoning_content: 'First next', tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"path":"a"}' } }
      ] }
    }] })
    expect(response.choices[0].message.tool_calls?.[0]).not.toHaveProperty('index')
  })

  it('keeps interleaved choices and tool positions independent', async () => {
    const response = await collectChatCompletion(frames([
      [{ index: 1, delta: { content: 'B' }, finish_reason: null }, { index: 0, delta: { content: 'A' }, finish_reason: null }],
      [{ index: 0, delta: { content: '1' }, finish_reason: 'stop' }, { index: 1, delta: { content: '2' }, finish_reason: 'length' }]
    ]))
    expect(response.choices.map(choice => [choice.index, choice.message.content, choice.finish_reason]))
      .toEqual([[0, 'A1', 'stop'], [1, 'B2', 'length']])
  })

  it('retains refusal, audio fragments and native log probabilities', async () => {
    const response = await collectChatCompletion(frames([
      { index: 0, delta: { refusal: 'Cannot ', audio: { id: 'audio_1', data: 'YW', transcript: 'Hello ' } }, logprobs: { content: [{ token: 'a' }] } },
      { index: 0, delta: { refusal: 'do it', audio: { data: 'Jj', transcript: 'world', expires_at: 123 } },
        logprobs: { content: [{ token: 'b' }] }, finish_reason: 'stop' }
    ]))
    expect(response.choices[0]).toMatchObject({ message: { refusal: 'Cannot do it',
      audio: { id: 'audio_1', data: 'YWJj', transcript: 'Hello world', expires_at: 123 } },
      logprobs: { content: [{ token: 'a' }, { token: 'b' }] } })
  })

  it('preserves freeform calls while leaving invalid function JSON for the execution boundary to reject', async () => {
    const response = await collectChatCompletion(frames([
      { index: 0, delta: { tool_calls: [
        { index: 1, id: 'free', type: 'custom', custom: { name: 'patch', input: 'line 1' } },
        { index: 0, type: 'function', function: { name: 'broken', arguments: '{' } }
      ] } },
      { index: 0, delta: { tool_calls: [{ index: 1, custom: { input: '\nline 2' } }] }, finish_reason: 'tool_calls' }
    ]))
    expect(response.choices[0].message.tool_calls).toEqual([
      { type: 'function', function: { name: 'broken', arguments: '{' } },
      { id: 'free', type: 'custom', custom: { name: 'patch', input: 'line 1\nline 2' } }
    ])
  })

  it.each([[], [{ index: 0, delta: { content: 'Partial' }, finish_reason: null }],
    [{ index: 0, delta: {}, finish_reason: 'stop' }, { index: 1, delta: { content: 'unfinished' } }]].map(input => ({ input })))(
    'rejects incomplete output instead of returning completed tool calls (%#)', async ({ input }) => {
      await expect(collectChatCompletion(frames(input))).rejects.toBeInstanceOf(IncompleteModelResponseError)
    }
  )

  it('closes its source when a progress consumer fails', async () => {
    const closed = vi.fn()
    const source = async function *() {
      try { yield* frames([{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }]) }
      finally { closed() }
    }
    const failure = new Error('Consumer failed')
    await expect(collectChatCompletion(source(), () => { throw failure })).rejects.toBe(failure)
    expect(closed).toHaveBeenCalledOnce()
  })
})
