import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { commandShellMetadata } from '../shared/commandShell'
import { modelApprovalDecision, supportsApprovalParameter } from './smartApproval'
import { validateCapabilityInput } from './toolInput'
import { invokeCapability } from './toolInvocation'

describe('host approval metadata', () => {
  it('defaults to requesting approval and accepts only explicit booleans', () => {
    expect(modelApprovalDecision({})).toBe(true)
    expect(modelApprovalDecision({ needs_approval: true })).toBe(true)
    expect(modelApprovalDecision({ needs_approval: false })).toBe(false)
    for (const value of [null, 'false', 0]) expect(() => modelApprovalDecision({ needs_approval: value })).toThrow('boolean')
  })
  it('keeps the original intent and removes metadata only for business validation and invocation', async () => {
    const execute = vi.fn(() => ({ content: 'written' }))
    const tool = { name: 'write_file', description: '', inputSchema: z.object({ path: z.string() }).strict(), execute }
    const args = Object.freeze({ path: 'new.txt', needs_approval: false })
    await validateCapabilityInput(tool, args)
    await invokeCapability(tool, args, {})
    expect(execute).toHaveBeenCalledWith({ path: 'new.txt' }, {})
    expect(args).toEqual({ path: 'new.txt', needs_approval: false })
    const omitted = Object.freeze({ path: 'omitted.txt' })
    await validateCapabilityInput(tool, omitted)
    expect(modelApprovalDecision(omitted)).toBe(true)
    await invokeCapability(tool, omitted, {})
    expect(execute).toHaveBeenLastCalledWith(omitted, {})
    await expect(validateCapabilityInput(tool, { needs_approval: false })).rejects.toThrow()
    await expect(validateCapabilityInput(tool, { path: 'new.txt', needs_approval: 'false' })).rejects.toThrow('boolean')
  })
  it('leaves read, management and external tool contracts alone', () => {
    for (const name of ['read_file', 'sleep', 'cancel_call', 'write_todos', 'mcp__files__write_file']) expect(supportsApprovalParameter({ name })).toBe(false)
    expect(supportsApprovalParameter({ name: 'zsh', metadata: commandShellMetadata() })).toBe(true)
    expect(supportsApprovalParameter({ name: 'write_file', metadata: { anasCustomToolId: 'external' } })).toBe(false)
  })
})
