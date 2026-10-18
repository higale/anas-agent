import { mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

async function loadApiKeysWithEnv(content: string) {
  vi.resetModules()
  const dir = await mkdtemp(join(tmpdir(), 'anas-api-keys-'))
  tempDirs.push(dir)
  const envPath = join(dir, '.env')
  await writeFile(envPath, content, 'utf8')
  vi.doMock('./dataDir', () => ({
    getBundledEnvFile: () => join(dir, 'missing-bundled.env'),
    getEnvFile: () => envPath
  }))
  return {
    apiKeys: await import('./apiKeys'),
    envPath
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.doUnmock('./dataDir')
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('environment values', () => {
  it('keeps reporting a failed .env reload instead of using a system credential, and recovers after repair', async () => {
    vi.stubEnv('ANAS_RELOAD_KEY', 'system-key')
    const { apiKeys, envPath } = await loadApiKeysWithEnv('ANAS_RELOAD_KEY=local-key\n')
    const model = { apiKey: '${ANAS_RELOAD_KEY}' }
    expect(apiKeys.resolveModelApiKey(model)).toBe('local-key')
    await unlink(envPath)
    await mkdir(envPath)
    expect(() => apiKeys.listApiKeyEnvironmentVariables()).toThrow()
    expect(() => apiKeys.resolveModelApiKey(model)).toThrow()
    await rmdir(envPath)
    await writeFile(envPath, 'ANAS_RELOAD_KEY=repaired-key\n')
    expect(apiKeys.resolveModelApiKey(model)).toBe('repaired-key')
  })

  it('discovers and resolves OS names exactly, including whitespace, Unicode, punctuation, and leading digits', async () => {
    const names = [' ANAS_SPACE_KEY', 'ANAS_SPACE_KEY ', 'ANAS_SPACE_KEY', '9ANAS-TOKEN', 'ANAS.KEY', 'ANAS_中文_SECRET']
    names.forEach((name, index) => vi.stubEnv(name, `system-${index}`))
    const { apiKeys } = await loadApiKeysWithEnv(' ANAS_SPACE_KEY =local-normal-name\n')
    const variables = apiKeys.listApiKeyEnvironmentVariables()
    for (const [index, name] of names.entries()) {
      const source = name === 'ANAS_SPACE_KEY' ? 'envFile' : 'system'
      expect(variables).toContainEqual({ name, source, hasValue: true })
      expect(apiKeys.resolveModelApiKey({ apiKey: '${' + name + '}' }))
        .toBe(source === 'envFile' ? 'local-normal-name' : `system-${index}`)
    }
    vi.stubEnv(names[0], undefined)
    expect(() => apiKeys.resolveModelApiKey({ apiKey: '${' + names[0] + '}' }))
      .toThrow(`variable ${names[0]} is missing or empty`)
  })

  it('resolves explicit references, prefers non-empty .env values, and observes saved changes without altering the reference', async () => {
    vi.stubEnv('ANAS_REF_KEY', 'system-secret')
    vi.stubEnv('ANAS_REF_EMPTY_TOKEN', 'system-token')
    const { apiKeys } = await loadApiKeysWithEnv('ANAS_REF_KEY=local-secret\nANAS_REF_EMPTY_TOKEN= \nCUSTOM_CREDENTIAL=manual-secret\n')
    const model = { apiKey: '${ANAS_REF_KEY}' }
    expect(apiKeys.resolveModelApiKey(model)).toBe('local-secret')
    expect(apiKeys.resolveModelApiKey({ apiKey: '${ANAS_REF_EMPTY_TOKEN}' })).toBe('system-token')
    expect(apiKeys.resolveModelApiKey({ apiKey: ' ${CUSTOM_CREDENTIAL} ' })).toBe('manual-secret')
    apiKeys.writeDataEnvFile('ANAS_REF_KEY=new-local\nCUSTOM_CREDENTIAL=${ANOTHER_KEY}\n')
    expect(apiKeys.resolveModelApiKey(model)).toBe('new-local')
    expect(model.apiKey).toBe('${ANAS_REF_KEY}')
    expect(apiKeys.resolveModelApiKey({ apiKey: '${CUSTOM_CREDENTIAL}' })).toBe('${ANOTHER_KEY}')
    expect(apiKeys.resolveModelApiKey({ apiKey: 'sk-${literal}' })).toBe('sk-${literal}')
  })

  it('rejects missing, empty, or malformed references without falling back to an SDK default key', async () => {
    vi.stubEnv('ANAS_REF_MISSING', undefined)
    vi.stubEnv('ANAS_REF_EMPTY', undefined)
    vi.stubEnv('toString', undefined)
    const { apiKeys } = await loadApiKeysWithEnv('ANAS_REF_EMPTY= \n')
    for (const name of ['ANAS_REF_MISSING', 'ANAS_REF_EMPTY', 'toString']) {
      expect(() => apiKeys.resolveModelApiKey({ apiKey: '${' + name + '}' })).toThrow(`variable ${name} is missing or empty`)
    }
    for (const key of ['${}', '${A=B}', '${NAME', '${A}${B}', '${A\0B}', '${A\nB}']) {
      expect(() => apiKeys.resolveModelApiKey({ apiKey: key })).toThrow('Invalid API key environment reference')
    }
  })

  it('lists only suggested variable metadata, merges equal names by actual precedence, and rereads .env', async () => {
    vi.stubEnv('ANAS_SUGGESTED_KEY', 'system-secret')
    vi.stubEnv('ANAS_SUGGESTED_emptyToken', 'system-fallback')
    vi.stubEnv('ANAS_SUGGESTED_sysSecret', 'system-only')
    vi.stubEnv('ANAS_SUGGESTED_EMPTYKEY', '')
    vi.stubEnv('ANAS_SUGGESTED_DIRECTORY', 'not-a-key')
    const { apiKeys, envPath } = await loadApiKeysWithEnv('ANAS_SUGGESTED_KEY=local-secret\nANAS_SUGGESTED_emptyToken=\nANAS_SUGGESTED_apiKey=local-only\nBAD{KEY=bad\n')
    const variables = apiKeys.listApiKeyEnvironmentVariables().filter(item => item.name.startsWith('ANAS_SUGGESTED_'))
    expect(variables).toEqual(expect.arrayContaining([
      { name: 'ANAS_SUGGESTED_KEY', source: 'envFile', hasValue: true },
      { name: 'ANAS_SUGGESTED_apiKey', source: 'envFile', hasValue: true },
      { name: 'ANAS_SUGGESTED_emptyToken', source: 'system', hasValue: true },
      { name: 'ANAS_SUGGESTED_sysSecret', source: 'system', hasValue: true },
      { name: 'ANAS_SUGGESTED_EMPTYKEY', source: 'system', hasValue: false }
    ]))
    expect(variables).toHaveLength(5)
    expect(apiKeys.listApiKeyEnvironmentVariables().some(item => item.name === 'BAD{KEY')).toBe(false)
    await writeFile(envPath, 'ANAS_SUGGESTED_NEW_TOKEN=updated\n')
    const updated = apiKeys.listApiKeyEnvironmentVariables()
    expect(updated).toContainEqual({ name: 'ANAS_SUGGESTED_NEW_TOKEN', source: 'envFile', hasValue: true })
    expect(updated).toContainEqual({ name: 'ANAS_SUGGESTED_KEY', source: 'system', hasValue: true })
    expect(updated.some(item => item.name === 'ANAS_SUGGESTED_apiKey')).toBe(false)
  })

  it('resolves model credentials only from the provider configuration', async () => {
    const openAiKey = process.env.OPENAI_API_KEY
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = 'system-openai-secret'
    process.env.ANTHROPIC_API_KEY = 'system-anthropic-secret'
    const { apiKeys } = await loadApiKeysWithEnv(
      'OPENAI_API_KEY=data-openai-secret\nANTHROPIC_API_KEY=data-anthropic-secret\n'
    )

    try {
      apiKeys.loadDataEnv()
      expect(apiKeys.resolveModelApiKey({ apiKey: ' configured-secret ' })).toBe('configured-secret')
      expect(apiKeys.resolveModelApiKey({ apiKey: '' })).toBeUndefined()
      expect(apiKeys.resolveModelApiKey({})).toBeUndefined()
    } finally {
      if (openAiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = openAiKey
      if (anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = anthropicKey
    }
  })

  it('reports only keys missing from both the data file and system environment', async () => {
    const localKey = 'ANAS_TEST_LOCAL_ENV_SOURCE'
    const systemKey = 'ANAS_TEST_SYSTEM_ENV_SOURCE'
    const missingKey = 'ANAS_TEST_MISSING_ENV_SOURCE'
    const previousLocal = process.env[localKey]
    const previousSystem = process.env[systemKey]
    const previousMissing = process.env[missingKey]
    process.env[localKey] = 'system-local'
    process.env[systemKey] = 'system-only'
    delete process.env[missingKey]

    try {
      const { apiKeys } = await loadApiKeysWithEnv(`${localKey}=local-value\n`)
      expect(apiKeys.missingDataEnvKeys([localKey, systemKey, missingKey, missingKey]))
        .toEqual([missingKey])
      expect(apiKeys.resolveDataEnvValue(localKey)).toBe('local-value')
      expect(apiKeys.resolveDataEnvValue(systemKey)).toBe('system-only')
    } finally {
      if (previousLocal === undefined) delete process.env[localKey]
      else process.env[localKey] = previousLocal
      if (previousSystem === undefined) delete process.env[systemKey]
      else process.env[systemKey] = previousSystem
      if (previousMissing === undefined) delete process.env[missingKey]
      else process.env[missingKey] = previousMissing
    }
  })

  it('falls back to the system value when the local assignment is empty', async () => {
    const key = 'ANAS_TEST_EMPTY_LOCAL_ENV_SOURCE'
    const previous = process.env[key]
    process.env[key] = 'system-value'

    try {
      const { apiKeys } = await loadApiKeysWithEnv(`${key}=\n`)
      expect(apiKeys.missingDataEnvKeys([key])).toEqual([])
      expect(apiKeys.resolveDataEnvValue(key)).toBe('system-value')
      expect(process.env[key]).toBe('system-value')
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it('isolates enabled and disabled execution environments without mutating the host', async () => {
    const overriddenKey = 'ANAS_TEST_TOGGLED_ENV_SOURCE'
    const localOnlyKey = 'ANAS_TEST_TOGGLED_LOCAL_ONLY'
    const previousOverridden = process.env[overriddenKey]
    const previousLocalOnly = process.env[localOnlyKey]
    process.env[overriddenKey] = 'system-value'
    delete process.env[localOnlyKey]

    try {
      const { apiKeys } = await loadApiKeysWithEnv(
        `${overriddenKey}=local-value\n${localOnlyKey}=local-only\n`
      )
      expect(apiKeys.resolveDataEnvValue(overriddenKey)).toBe('local-value')
      expect(apiKeys.processEnvironment(true)[localOnlyKey]).toBe('local-only')
      const enabledEnvironment = apiKeys.processEnvironment(true)
      expect(apiKeys.processEnvironment(false)[overriddenKey]).toBe('system-value')
      expect(apiKeys.processEnvironment(false)[localOnlyKey]).toBeUndefined()
      expect(process.env[overriddenKey]).toBe('system-value')
      expect(process.env[localOnlyKey]).toBeUndefined()

      apiKeys.writeDataEnvFile(`${overriddenKey}=updated-local\n${localOnlyKey}=updated-only\n`)
      expect(enabledEnvironment[overriddenKey]).toBe('local-value')
      expect(apiKeys.processEnvironment(false)[overriddenKey]).toBe('system-value')
      expect(apiKeys.resolveDataEnvValue(overriddenKey)).toBe('updated-local')
      expect(apiKeys.resolveDataEnvValue(localOnlyKey)).toBe('updated-only')
    } finally {
      if (previousOverridden === undefined) delete process.env[overriddenKey]
      else process.env[overriddenKey] = previousOverridden
      if (previousLocalOnly === undefined) delete process.env[localOnlyKey]
      else process.env[localOnlyKey] = previousLocalOnly
    }
  })
})
