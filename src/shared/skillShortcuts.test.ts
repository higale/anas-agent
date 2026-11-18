import { describe, expect, it } from 'vitest'
import { parseSlashSkillInput } from './skillShortcuts'

describe('parseSlashSkillInput', () => {
  it('separates a skill name from its arguments', () => {
    expect(parseSlashSkillInput('/weather Beijing tomorrow')).toEqual({
      name: 'weather',
      args: 'Beijing tomorrow'
    })
  })

  it('parses a qualified source alias', () => {
    expect(parseSlashSkillInput('/proofread@plugin:writing-helper text')).toEqual({ name: 'proofread', sourceAlias: 'plugin:writing-helper', args: 'text' })
    expect(parseSlashSkillInput('/proofread@plugin:../outside text')).toBeUndefined()
    expect(parseSlashSkillInput('/weather@agents Beijing')).toEqual({
      name: 'weather',
      sourceAlias: 'agents',
      args: 'Beijing'
    })
  })

  it('rejects an empty command and invalid names', () => {
    expect(parseSlashSkillInput('/')).toBeUndefined()
    expect(parseSlashSkillInput('/bad.name value')).toBeUndefined()
    expect(parseSlashSkillInput('/weather@ value')).toBeUndefined()
    expect(parseSlashSkillInput('/weather@bad.alias value')).toBeUndefined()
  })

  it.each(['/Users/tester/Desktop/报告 ', 'C:\\Users\\tester\\报告 # %.txt', '\\\\server\\共享目录\\报告.txt'])(
    'preserves native path arguments after a shortcut: %s', path => {
      expect(parseSlashSkillInput(`  /analyze\n${path}`)).toEqual({ name: 'analyze', args: path })
    }
  )

  it('still accepts a shortcut with only whitespace after its name', () => {
    expect(parseSlashSkillInput('  /analyze \n  ')).toEqual({ name: 'analyze', args: '' })
  })
})
