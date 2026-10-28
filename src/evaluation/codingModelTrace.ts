import type { ConversationModel } from '../main/agent/conversationModel'
import type { ConversationMessage } from '../runtime/conversationMessage'
import type { AgentServerTokenUsage } from '@shared/agentTypes'
import { modelUsageSnapshot, type ModelUsage } from '../runtime/modelUsage'
import { randomUUID } from 'node:crypto'
import { fingerprint } from './codingEvidence'

export interface ModelTraceMessage {
  id?: string
  type: string
  content: unknown
  toolCalls?: readonly { id?: string; name: string; args: unknown }[]
  toolResultFor?: string
}

export interface ModelTraceContext { requestId?: string; requestRole?: string }
interface ObservedSummary { text: string; id?: string; usage?: ModelUsage }

interface MessageEvidence {
  id: string | null
  type: string
  contentFingerprint: string
  toolCalls: Array<{ id: string | null; name: string; argsFingerprint: string }>
  toolResultFor: string | null
}

interface ModelCallEvidence {
  callbackRunId: string
  requestId: string | null
  role: string | null
  status: 'running' | 'completed' | 'failed'
  elapsedMs: number
  inputCount: number
  inputs: MessageEvidence[]
  outputCount: number
  outputs: MessageEvidence[]
  messagesTruncated: boolean
  usage: AgentServerTokenUsage | null
  error?: string
}

export interface CodingModelTrace {
  source: 'model-observers'
  callsTruncated: boolean
  calls: ModelCallEvidence[]
}

export interface CodingTokenUsage {
  source: 'provider-usage'
  coverage: 'complete' | 'partial' | 'unavailable'
  observedCalls: number
  callsWithUsage: number
  totals: { inputTokens: number; outputTokens: number; totalTokens: number } | null
}

function messageEvidence(message: ModelTraceMessage): MessageEvidence {
  return {
    id: message.id ?? null, type: message.type,
    contentFingerprint: fingerprint(message.content),
    toolCalls: (message.toolCalls ?? []).map((call) => ({
      id: call.id ?? null, name: call.name, argsFingerprint: fingerprint(call.args)
    })),
    toolResultFor: message.toolResultFor ?? null
  }
}

function traceMessage(message: ConversationMessage): ModelTraceMessage {
  return { id: message.id, type: message.kind, content: message.content,
    toolCalls: message.calls, toolResultFor: message.resultFor }
}

/** Observes native calls without replacing models, requests or durable state. */
export class CodingModelTraceCollector {
  private readonly calls = new Map<string, { start: number; evidence: ModelCallEvidence }>()
  private callsTruncated = false

  constructor(private readonly limits = { calls: 128, messages: 256 }) {
    if (!Number.isInteger(limits.calls) || limits.calls < 1 || !Number.isInteger(limits.messages) || limits.messages < 1) {
      throw new Error('Model trace limits must be positive integers.')
    }
  }

  observeModel(model: ConversationModel, context: ModelTraceContext = {}): ConversationModel {
    return { invoke: async request => {
      const id = randomUUID()
      this.beginCall(id, context, request.messages.map(traceMessage))
      try {
        const response = await model.invoke(request)
        this.completeCall(id, [traceMessage(response.message)], response.message.usage)
        return response
      } catch (error) {
        this.failCall(id, error)
        throw error
      }
    } }
  }

  beginCall(id: string, context: ModelTraceContext, inputs: readonly ModelTraceMessage[]): boolean {
    if (this.calls.has(id)) return false
    if (this.calls.size >= this.limits.calls) {
      this.callsTruncated = true
      return false
    }
    this.calls.set(id, { start: performance.now(), evidence: {
      callbackRunId: id, requestId: context.requestId ?? null, role: context.requestRole ?? null,
      status: 'running', elapsedMs: 0,
      inputCount: inputs.length, inputs: inputs.slice(-this.limits.messages).map(messageEvidence),
      outputCount: 0, outputs: [], messagesTruncated: inputs.length > this.limits.messages, usage: null
    } })
    return true
  }

  completeCall(id: string, outputs: readonly ModelTraceMessage[], usage?: ModelUsage): void {
    const call = this.calls.get(id)
    if (!call || call.evidence.status !== 'running') return
    Object.assign(call.evidence, {
      status: 'completed', elapsedMs: Math.round(performance.now() - call.start),
      outputCount: outputs.length, outputs: outputs.slice(0, this.limits.messages).map(messageEvidence),
      messagesTruncated: call.evidence.messagesTruncated || outputs.length > this.limits.messages,
      usage: modelUsageSnapshot(usage) ?? null
    })
  }

  failCall(id: string, error: unknown): void {
    const call = this.calls.get(id)
    if (!call || call.evidence.status !== 'running') return
    Object.assign(call.evidence, {
      status: 'failed', elapsedMs: Math.round(performance.now() - call.start),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2000)
    })
  }

  async observeSummary<Response extends ObservedSummary>(context: ModelTraceContext, prompt: string,
    generate: () => Promise<Response>): Promise<Response> {
    const id = randomUUID()
    if (!this.beginCall(id, { ...context, requestRole: context.requestRole ?? 'compression' }, [{ type: 'human', content: prompt }])) return generate()
    try {
      const response = await generate()
      this.completeCall(id, [{ id: response.id, type: 'ai', content: response.text }], response.usage)
      return response
    } catch (error) {
      this.failCall(id, error)
      throw error
    }
  }

  snapshot(): { trace: CodingModelTrace; tokens: CodingTokenUsage } {
    const calls = structuredClone([...this.calls.values()].map(({ evidence }) => evidence))
    const usages = calls.flatMap((call) => call.usage ? [call.usage] : [])
    const totals = usages.length ? usages.reduce((sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      totalTokens: sum.totalTokens + usage.totalTokens
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) : null
    return {
      trace: { source: 'model-observers', callsTruncated: this.callsTruncated, calls },
      tokens: {
        source: 'provider-usage',
        coverage: usages.length === 0 ? 'unavailable'
          : !this.callsTruncated && usages.length === calls.length ? 'complete' : 'partial',
        observedCalls: calls.length, callsWithUsage: usages.length, totals
      }
    }
  }
}
