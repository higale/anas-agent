import { z } from 'zod/v3'
import { describe, expect, it } from 'vitest'
import { commandShellMetadata } from '@shared/commandShell'
import { serializeToolDefinition } from './toolSchemaSerialization'
import { defineContentTool } from '../runtime/toolDefinition'
import { fileToolDefinitions } from './llm/fileTools'
import { modelToolDeclaration } from './agent/modelToolDeclarations'
import codexPatchSpec from './codexPatchSpec.json'

describe('tool schema serialization', () => {
  it('previews both patch formats using the actual model declarations', () => {
    const patch = fileToolDefinitions({ primaryFolder: process.cwd(), maxReadBytes: 1000 }).find(tool => tool.name === 'apply_patch')!
    const preview = serializeToolDefinition(patch)
    expect(preview.definitionVariants).toEqual([
      { format: 'json', definition: modelToolDeclaration(patch, 'openai_chat_completions') },
      { format: 'freeform', definition: modelToolDeclaration(patch, 'openai_responses') }
    ])
    expect(preview.definitionVariants![0].definition).toMatchObject({ type: 'function', function: {
      name: 'apply_patch', parameters: { required: ['patch'], additionalProperties: false }
    } })
    expect(preview.definitionVariants![1].definition).toEqual(codexPatchSpec)
    expect(serializeToolDefinition({ ...patch, metadata: undefined }).definitionVariants).toBeUndefined()
  })

  it('describes native inputs without executing transforms or business handlers', () => {
    let invoked = false
    const definition = defineContentTool({
      name: 'native_settings', description: 'Native tool.',
      inputSchema: z.object({ count: z.number().default(0), enabled: z.boolean().default(false),
        value: z.string().transform(() => { throw new Error('Description must not transform input.') }) }),
      execute: () => { invoked = true }
    })
    const description = serializeToolDefinition(definition)
    expect(description.inputSchema).toMatchObject({ properties: { count: { default: 0 }, enabled: { default: false } }, required: ['value'] })
    expect(invoked).toBe(false)
  })

  it('reports unsupported descriptions rather than sending executable schema objects to the renderer', () => {
    expect(() => serializeToolDefinition({ name: 'unsupported', description: '', inputSchema: {
      '~standard': { vendor: 'other', version: 1, validate: () => ({ value: {} }) }
    } })).toThrow('Schema does not provide a JSON input description')
  })

  it('maps only verified command-shell metadata to the stable capability ID', () => {
    const shell = defineContentTool({
      name: 'pwsh',
      description: 'Run PowerShell.',
      metadata: commandShellMetadata(),
      execute: async () => 'ok',
      inputSchema: z.object({ command: z.string() })
    })
    const unrelated = defineContentTool({
      name: 'external_tool',
      description: 'External tool.',
      metadata: { anasCapabilityId: 'run_shell' },
      execute: async () => 'ok',
      inputSchema: z.object({})
    })

    expect(serializeToolDefinition(shell).capabilityId).toBe('run_shell')
    expect(serializeToolDefinition(unrelated).capabilityId).toBeUndefined()
  })
})
