import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveNewContents, parsePatch } from './codexPatch'
import { parseFilePatch, planFilePatch } from './filePatch'
import codexPatchSpec from './codexPatchSpec.json'

interface ReferenceCase {
  name: string
  patch: string
  sources: Record<string, string>
  expected: unknown
}
const reference = JSON.parse(readFileSync(resolve('src/main/test-fixtures/codex-patch.json'), 'utf8')) as {
  revision: string; toolSpec: unknown; cases: ReferenceCase[]
}

function evaluate({ patch, sources }: ReferenceCase): unknown {
  try {
    const parsed = parsePatch(patch)
    const updates = parsed.hunks.flatMap<{ path: string; content?: string; error?: string }>((hunk) => {
      if (hunk.type !== 'update' || sources[hunk.path] === undefined) return []
      try { return [{ path: hunk.path, content: deriveNewContents(sources[hunk.path], hunk.chunks, hunk.path) }] }
      catch (error) { return [{ path: hunk.path, error: (error as Error).message }] }
    })
    return { parsed, updates }
  } catch (error) { return { error: (error as Error).message } }
}

describe(`Codex Rust reference ${reference.revision}`, () => {
  it('ships the upstream freeform description and Lark grammar verbatim', () => {
    expect(codexPatchSpec).toEqual(reference.toolSpec)
  })
  it.each(reference.cases)('$name', (entry) => {
    expect(evaluate(entry)).toEqual(entry.expected)
  })

  it('preserves upstream edit semantics through the Anas transaction adapter', () => {
    for (const entry of reference.cases) {
      if (!('parsed' in (entry.expected as object)) || !(entry.expected as { updates: unknown[] }).updates.length) continue
      if ((entry.expected as { parsed: { environmentId?: string } }).parsed.environmentId !== undefined) continue
      const plan = parseFilePatch({ patch: entry.patch })
      const updates = [...(entry.expected as { updates: Array<{ path: string; content?: string; error?: string }> }).updates]
      for (const operation of plan.operations) {
        if (!('chunks' in operation) || entry.sources[operation.path] === undefined) continue
        const upstream = updates.shift()!
        const path = resolve(operation.path)
        const snapshots = new Map<string, string | null>([[path, entry.sources[operation.path]]])
        const resolved = { ...operation, path }
        if (resolved.type === 'move') {
          resolved.destination = resolve(resolved.destination)
          snapshots.set(resolved.destination, null)
        }
        const apply = () => planFilePatch({ operations: [resolved] }, snapshots).at(-1)!.afterText
        if (upstream.error) expect(apply, entry.name).toThrow()
        else expect(apply(), entry.name).toBe(upstream.content)
      }
    }
  })
})
