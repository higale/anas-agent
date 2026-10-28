import { describe, expect, it } from 'vitest'
import { toolEffectArtifactPurposes, type ToolEffectArtifactIdentity } from '../../runtime/toolEffectIdentity'
import { canRestartUnpublishedEffectArtifact, currentAgentToolEffectArtifactId,
  hasCurrentAgentToolEffectScope, runWithCurrentAgentToolEffect, runWithoutCurrentAgentToolEffect } from './toolEffectScope'

describe('effect resource ownership', () => {
  it('uses supplied application identities and isolates nested execution without graph keys', async () => {
    const identity: ToolEffectArtifactIdentity = { runId: 'run', artifacts: Object.fromEntries(
      toolEffectArtifactPurposes.map(purpose => [purpose, `saved:${purpose}`])
    ) as ToolEffectArtifactIdentity['artifacts'] }
    let unarmed = true
    await runWithCurrentAgentToolEffect({ identity, isUnarmed: () => unarmed, arm: () => {} }, async () => {
      for (const purpose of toolEffectArtifactPurposes) expect(currentAgentToolEffectArtifactId(purpose)).toBe(`saved:${purpose}`)
      expect(canRestartUnpublishedEffectArtifact('run', 'saved:file_edit', 'file_edit')).toBe(true)
      expect(canRestartUnpublishedEffectArtifact('another-run', 'saved:file_edit', 'file_edit')).toBe(false)
      expect(canRestartUnpublishedEffectArtifact('run', 'saved:file_edit', 'file_restore')).toBe(false)
      unarmed = false
      expect(canRestartUnpublishedEffectArtifact('run', 'saved:file_edit', 'file_edit')).toBe(false)
      await runWithoutCurrentAgentToolEffect(async () => {
        await Promise.resolve()
        expect(currentAgentToolEffectArtifactId('managed-call')).toBeUndefined()
        expect(hasCurrentAgentToolEffectScope()).toBe(false)
      })
      await runWithCurrentAgentToolEffect({ arm: () => {} }, async () => {
        await Promise.resolve()
        expect(hasCurrentAgentToolEffectScope()).toBe(true)
        expect(currentAgentToolEffectArtifactId('file_edit')).toBeUndefined()
      })
      expect(currentAgentToolEffectArtifactId('subagent')).toBe('saved:subagent')
    })
    expect(currentAgentToolEffectArtifactId('file_edit')).toBeUndefined()
    expect(hasCurrentAgentToolEffectScope()).toBe(false)
  })

})
