import { describe, expect, it } from 'vitest'
import { z } from 'zod/v3'
import { builtinToolCatalog } from '@shared/toolRegistry'
import { commandShellMetadata } from '@shared/commandShell'
import { canonicalToolEffectJson } from '../../runtime/toolEffects'
import { defineContentTool } from '../../runtime/toolDefinition'
import { builtinToolEffectPolicies, classifyAgentToolEffect } from './toolEffectClassification'

function mcpTool(annotations?: Record<string, unknown>) {
  return { name: 'mcp_fixture', metadata: { annotations } }
}

describe('native tool effect classification and identity', () => {
  it('keeps the builtin catalog exhaustive and excludes previews', () => {
    expect(Object.keys(builtinToolEffectPolicies).sort()).toEqual(
      builtinToolCatalog.map((entry) => entry.id).filter((name) => name !== 'run_shell').sort()
    )
    expect(classifyAgentToolEffect('read_file', { path: 'a' })).toBeUndefined()
    expect(classifyAgentToolEffect('write_call', { action: { type: 'text', text: 'yes\r' } })).toEqual({ recoveryMode: 'confirm' })
    expect(classifyAgentToolEffect('write_call', { action: { type: 'resize', columns: 100, rows: 30 } })).toEqual({ recoveryMode: 'idempotent' })
    expect(classifyAgentToolEffect('apply_patch', { dry_run: true })).toBeUndefined()
    expect(classifyAgentToolEffect('restore_file_edit', { dry_run: true })).toBeUndefined()
    expect(classifyAgentToolEffect('apply_patch', { dry_run: false })).toEqual({
      recoveryMode: 'confirm'
    })
  })

it('classifies a concretely named command shell by stable tool metadata', () => {
    const shell = defineContentTool({
      name: 'pwsh',
      description: 'Run PowerShell.',
      execute: async () => 'ok',
      metadata: commandShellMetadata(),
      inputSchema: z.object({ command: z.string() })
    })

    expect(classifyAgentToolEffect('pwsh', { command: 'Get-Date' }, shell))
      .toEqual({ recoveryMode: 'confirm' })
  })

it('uses HTTP and MCP idempotency hints without treating missing MCP annotations as read-only', () => {
    expect(classifyAgentToolEffect('http_request', { url: 'https://example.test' }))
      .toBeUndefined()
    expect(classifyAgentToolEffect('http_request', {
      url: 'https://example.test',
      method: 'POST'
    })).toEqual({ recoveryMode: 'confirm' })
    expect(classifyAgentToolEffect('http_request', {
      url: 'https://example.test',
      method: 'POST',
      headers: { 'Idempotency-Key': 'request-1' }
    })).toEqual({ recoveryMode: 'idempotent' })

    expect(classifyAgentToolEffect('mcp_alpha_ping', {}, mcpTool()))
      .toEqual({ recoveryMode: 'confirm' })
    expect(classifyAgentToolEffect('mcp_alpha_read', {}, mcpTool({ readOnlyHint: true })))
      .toBeUndefined()
    expect(classifyAgentToolEffect('mcp_alpha_put', {}, mcpTool({ idempotentHint: true })))
      .toEqual({ recoveryMode: 'idempotent' })
  })

it('rejects cyclic objects and arrays before they can become unstable keys', () => {
    const object: Record<string, unknown> = {}
    object.self = object
    const array: unknown[] = []
    array.push(array)
    expect(() => canonicalToolEffectJson(object)).toThrow('must not contain cycles')
    expect(() => canonicalToolEffectJson(array)).toThrow('must not contain cycles')
  })

it('preserves prototype-named own properties in canonical identities', () => {
    const input = JSON.parse(
      '{"__proto__":{"resource":"A"},"constructor":"B","prototype":"C"}'
    ) as Record<string, unknown>
    const canonical = canonicalToolEffectJson(input)
    expect(canonical).toBe(
      '{"__proto__":{"resource":"A"},"constructor":"B","prototype":"C"}'
    )
    expect(canonical).not.toBe(canonicalToolEffectJson({}))
  })
})
