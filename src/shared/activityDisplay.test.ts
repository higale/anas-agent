import { describe, expect, it } from 'vitest'
import { boundedDisplayRun, displayActivityPage, displayRunSummary, displayEvent } from './activityDisplay'
import { applyRunActivityEvent } from './agentActivityProjection'
import type { AgentRunActivity, AgentRuntimeEvent } from './agentTypes'

function run(): AgentRunActivity {
  return { runId: 'r', operation: 'agent', status: 'completed', createdAt: '', updatedAt: '',
    models: [{ id: 'm', sequence: 0, status: 'completed', text: 'MODEL_BODY', reasoning: 'REASONING_BODY', toolCallIds: ['t'] }],
    tools: [{ call: { id: 't', name: 'probe', args: { body: 'ARGUMENT_BODY', summary: 's'.repeat(1000) } }, sequence: 1, status: 'completed', output: 'OUTPUT_BODY' }],
    subagents: [{ id: 's', sequence: 2, name: 'Child', status: 'completed', result: 'CHILD_BODY' }],
    summaries: [{ id: 'c', sequence: 3, status: 'completed', summaryText: 'SUMMARY_BODY', createdAt: '' }],
    memoryRecalls: [{ id: 'p', sequence: 4, promptText: 'MEMORY_BODY', query: 'QUERY_BODY', memoryCount: 1, createdAt: '' }] }
}

describe('activity display ownership', () => {
  it('keeps only bounded headers and references in pages, without mutating execution records', () => {
    const source = run(), original = structuredClone(source)
    const page = displayActivityPage('thread', source)
    expect(JSON.stringify(page)).not.toContain('_BODY')
    expect(page.models[0]).toMatchObject({ hasText: true, hasReasoning: true, text: '', reasoning: '', detail: { id: 'm', kind: 'model' } })
    expect((page.tools[0].call.args as { summary: string }).summary).toHaveLength(240)
    expect(source).toEqual(original)
  })
  it('retains no completed inner items in a collapsed run summary', () => {
    const summary = displayRunSummary('thread', run())
    expect([summary.models, summary.tools, summary.subagents, summary.memoryRecalls]).toEqual([[], [], [], []])
    expect(JSON.stringify(summary)).not.toContain('_BODY')
    expect(summary.display).toMatchObject({ modelCount: 1, toolCount: 1, subagentCount: 1 })
  })
  it('bounds streaming presentation history and never keeps old tool bodies', () => {
    const source = run()
    source.tools = Array.from({ length: 5000 }, (_, sequence) => ({ ...source.tools[0], sequence, call: { id: String(sequence), name: 'probe', args: 'ARGUMENT_BODY' } }))
    const limited = boundedDisplayRun('thread', source)
    expect(limited.tools.length).toBeLessThanOrEqual(500)
    expect(JSON.stringify(limited)).not.toContain('_BODY')
  })
  it('does not retain streamed text or full completion bodies in event replay', () => {
    expect(displayEvent({ type: 'model_delta', threadId: 'thread', runId: 'r', modelId: 'm', delta: { type: 'reasoning', text: 'REASONING_BODY' } }))
      .toMatchObject({ delta: { text: '' } })
    expect(JSON.stringify(displayEvent({ type: 'model_completed', threadId: 'thread', runId: 'r', model: run().models[0] }))).not.toContain('_BODY')
  })
  it('preserves visible text across replay projections and original spacing in raw deltas', () => {
    const source = run()
    source.models[0] = { ...source.models[0], status: 'running', text: '' }
    let raw = source, projected = displayActivityPage('thread', source)
    for (const [text, visible] of [[' \n', false], ['  reply', true], ['\t', true]] as const) {
      const event: AgentRuntimeEvent = { type: 'model_delta', threadId: 'thread', runId: 'r', modelId: 'm', delta: { type: 'text', text } }
      raw = applyRunActivityEvent(raw, event)
      projected = applyRunActivityEvent(projected, displayEvent(displayEvent(event)))
      expect(projected.models[0]).toMatchObject({ hasText: visible, text: '' })
      expect(displayActivityPage('thread', raw).models[0].hasText).toBe(visible)
    }
    expect(raw.models[0].text).toBe(' \n  reply\t')
  })
  it('keeps total counts through eviction without recounting replayed completions', () => {
    let current = boundedDisplayRun('thread', { ...run(), models: [], tools: [], subagents: [], summaries: [], memoryRecalls: [] })
    for (let sequence = 0; sequence < 700; sequence++) current = boundedDisplayRun('thread', applyRunActivityEvent(current,
      { type: 'tool_started', threadId: 'thread', runId: 'r', sequence, call: { id: String(sequence), name: 'probe', args: 'BODY' } }))
    expect(current.tools).toHaveLength(500)
    expect(current.display?.toolCount).toBe(700)
    current = boundedDisplayRun('thread', applyRunActivityEvent(current,
      { type: 'tool_completed', threadId: 'thread', runId: 'r', sequence: 0, call: { id: '0', name: 'probe', args: 'BODY' }, output: 'RESULT' }))
    expect(current.display?.toolCount).toBe(700)
    expect(current.tools).toHaveLength(500)
  })

  it.each(['text', 'reasoning'] as const)('does not republish unchanged %s visibility for every streamed token', channel => {
    const source = run()
    source.models[0] = { ...source.models[0], status: 'running', text: '', reasoning: '' }
    const empty = displayActivityPage('thread', source)
    const event: AgentRuntimeEvent = { type: 'model_delta', threadId: 'thread', runId: 'r', modelId: 'm',
      delta: { type: channel, text: 'first' } }
    const visible = applyRunActivityEvent(empty, displayEvent(event))
    expect(visible).not.toBe(empty)
    expect(visible.models[0][channel === 'text' ? 'hasText' : 'hasReasoning']).toBe(true)
    for (let index = 0; index < 1000; index++) expect(applyRunActivityEvent(visible, displayEvent(event))).toBe(visible)
    expect(applyRunActivityEvent(source, event).models[0][channel]).toBe('first')
    expect(applyRunActivityEvent(visible, { ...event, subagentId: 'other' })).toBe(visible)
    const completed = { ...visible, models: visible.models.map(model => ({ ...model, status: 'completed' as const })) }
    expect(applyRunActivityEvent(completed, event)).toBe(completed)
  })

})
