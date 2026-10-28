import { createHash } from 'node:crypto'
import { z } from 'zod/v3'
import { codeReviewReportSchema, codeReviewSnapshotSchema, reviewLocations, type CodeReviewSnapshot, type CodeReviewReport } from '../shared/codeReview'
import { toolJsonSchema } from './toolSchema'

export const codeReviewToolName = 'anas_code_review_report'

export function codeReviewToolDeclaration(scopeId: string) {
  const parameters = { ...toolJsonSchema(codeReviewReportSchema.extend({ scope_id: z.literal(scopeId) })),
    type: 'object', additionalProperties: false, title: codeReviewToolName,
    description: 'Complete the review of the explicitly captured changes.' }
  return { type: 'function' as const, function: {
    name: codeReviewToolName, description: parameters.description, parameters
  } }
}

export type ReviewCall = { id?: string; name: string; args: unknown }
export type ReviewReportResult =
  | { kind: 'investigate' }
  | { kind: 'retry'; calls: ReviewCall[]; error: string }
  | { kind: 'complete'; call: ReviewCall; report: CodeReviewReport }

/** Report generation is a model response, not an external tool effect. */
export function parseCodeReviewReport(scopeId: string, calls: readonly ReviewCall[]): ReviewReportResult {
  const reports = calls.filter(call => call.name === codeReviewToolName)
  if (!reports.length) return { kind: 'investigate' }
  if (reports.some(call => !call.id)) throw new Error('Tool call ID is required to handle review output.')
  if (reports.length > 1) return { kind: 'retry', calls: reports,
    error: `The model has called multiple tools: ${reports.map(call => call.name).join(', ')} to return a structured output. This is not supported. Please provide a single structured output.` }
  const parsed = codeReviewReportSchema.extend({ scope_id: z.literal(scopeId) }).safeParse(reports[0].args)
  if (!parsed.success) return { kind: 'retry', calls: reports,
    error: `Failed to parse structured output for tool '${codeReviewToolName}':\n${parsed.error.message}` }
  if (calls.length !== 1) throw new Error('The review report must be returned separately from investigation tool calls. No completed review is available.')
  return { kind: 'complete', call: reports[0], report: parsed.data }
}

export const maximumReviewBytes = 120_000
export function codeReviewSnapshotId(value: Omit<CodeReviewSnapshot, 'id'>): string {
  return createHash('sha256').update(JSON.stringify(codeReviewSnapshotSchema.omit({ id: true }).parse(value))).digest('hex')
}

export function validateCodeReviewSnapshot(value: unknown): CodeReviewSnapshot {
  const snapshot = codeReviewSnapshotSchema.parse(value)
  const { id, ...content } = snapshot
  if (codeReviewSnapshotId(content) !== id) throw new Error('Code review snapshot identity is invalid.')
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > maximumReviewBytes) throw new Error('Code review snapshot exceeds its input budget.')
  return snapshot
}

export function codeReviewReportText(report: CodeReviewReport, snapshot: CodeReviewSnapshot): string {
  const locations = reviewLocations(snapshot, report)
  return [report.summary, ...report.findings.map((finding, index) => {
    const file = snapshot.files.find((entry) => entry.id === finding.file_id)
    return `[${finding.priority}] ${finding.title}\n${file?.path ?? finding.file_id} (${finding.side}:${finding.start_line}-${finding.end_line})${locations[index].valid ? '' : ` — Unverified location: ${locations[index].reason}`}\n${finding.condition}\n${finding.impact}\n${finding.evidence}`
  }), ...snapshot.limitations, ...report.limitations].join('\n\n')
}

export function codeReviewPresentation(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const snapshot = validateCodeReviewSnapshot(candidate.snapshot)
  const report = codeReviewReportSchema.parse(candidate.report)
  if (report.scope_id !== snapshot.id) throw new Error('Stored code review report does not match its scope.')
  return { snapshot, report, locations: reviewLocations(snapshot, report) }
}
