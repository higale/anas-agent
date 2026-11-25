import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LanguagePackSummary } from '@shared/types'
import { profileDefaultsFromResources, resolveLanguagePack } from './languageStore'

const languages: LanguagePackSummary[] = [{
  code: 'en',
  name: 'English',
  builtIn: true
}, {
  code: 'zh-CN',
  name: '简体中文',
  builtIn: true
}, {
  code: 'custom',
  name: '自定义语言',
  builtIn: false
}]

describe('languageStore', () => {
  it('reads bundled languages directly, preserves stale copies and loads custom user packs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-languages-'))
    const bundled = join(root, 'bundled'), user = join(root, 'user')
    try {
      await mkdir(bundled)
      for (const code of ['en', 'zh-CN']) await writeFile(join(bundled, `${code}.json`), JSON.stringify({ version: 0, marker: 'current' }))
      vi.resetModules()
      vi.doMock('./config/dataDir', () => ({ getBundledLangDir: () => bundled, getLangDir: () => user }))
      const { getLanguageResources } = await import('./languageStore')
      const fresh = await getLanguageResources()
      expect(fresh.resources.en).toMatchObject({ marker: 'current' })
      expect(await readdir(user)).toEqual([])
      await writeFile(join(user, 'en.json'), '{stale or damaged old copy')
      await writeFile(join(user, 'custom.json'), JSON.stringify({ version: 0, _meta: { name: 'Custom' }, marker: 'user' }))
      const loaded = await getLanguageResources()
      expect(loaded.resources.en).toMatchObject({ marker: 'current' })
      expect(loaded.resources.custom).toMatchObject({ marker: 'user' })
      expect(loaded.languages.find(pack => pack.code === 'en')?.userPath).toBeUndefined()
      expect(loaded.languages.find(pack => pack.code === 'custom')).toMatchObject({ builtIn: false, userPath: join(user, 'custom.json') })
      expect(await readFile(join(user, 'en.json'), 'utf8')).toBe('{stale or damaged old copy')
    } finally {
      vi.doUnmock('./config/dataDir')
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns the configured language-pack code and _meta name', () => {
    expect(resolveLanguagePack('custom', 'en-US', languages)).toMatchObject({
      code: 'custom',
      name: '自定义语言'
    })
  })

  it('resolves the system preference against the available language packs', () => {
    expect(resolveLanguagePack('system', 'zh-CN', languages)).toMatchObject({
      code: 'zh-CN',
      name: '简体中文'
    })
  })

  it('falls back when a configured or system language has no host language pack', () => {
    expect(resolveLanguagePack('fr', 'zh-CN', languages).code).toBe('en')
    expect(resolveLanguagePack('system', 'fr-FR', languages).code).toBe('en')
  })

  it('builds localized profile defaults while leaving user-owned fields empty', () => {
    const profile = profileDefaultsFromResources('zh-CN', {
      en: {
        profile_defaults: {
          assistant: {
            role: 'English role',
          }
        }
      },
      'zh-CN': {
        profile_defaults: {
          assistant: {
            role: '中文角色',
          }
        }
      }
    })

    expect(profile).toEqual({
      assistant: {
        name: 'Ananas',
        role: '中文角色',
        newAvatarPath: ''
      },
      user: {
        preferredName: '',
        personalInfo: ''
      }
    })
  })

  it('falls back individual localized profile defaults to English', () => {
    const profile = profileDefaultsFromResources('custom', {
      en: {
        profile_defaults: {
          assistant: {
            role: 'English role',
          }
        }
      },
      custom: {
        profile_defaults: {
          assistant: { role: 'Custom role' }
        }
      }
    })

    expect(profile.assistant).toEqual({
      name: 'Ananas',
      role: 'Custom role',
      newAvatarPath: ''
    })
  })
})
