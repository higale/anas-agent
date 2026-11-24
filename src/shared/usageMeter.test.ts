import { expect, it } from 'vitest'
import { changeUsageEndpoint, normalizeUsageSettings, usageEndpoint } from './usageMeter'
import templates from '../../data/config/model-templates.json'

const supported = 'https://api.deepseek.com/v1'
it('supports every bundled Bailian protocol and plan template', () => {
  const urls: string[] = []
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return
    if ('base_url' in value && typeof value.base_url === 'string' && /aliyuncs\.com/.test(value.base_url)) urls.push(value.base_url)
    for (const child of Object.values(value)) visit(child)
  }
  visit(templates)
  expect(urls).toHaveLength(6)
  for (const url of urls) {
    expect(usageEndpoint(url)?.provider).toBe('bailian')
    expect(normalizeUsageSettings(undefined, url).enabled).toBe(true)
  }
})
it('defaults supported endpoints on and unsupported endpoints off without dropping credentials', () => {
  expect(normalizeUsageSettings(undefined, supported).enabled).toBe(true)
  expect(normalizeUsageSettings(undefined, supported).bailianShowBalance).toBe(false)
  expect(normalizeUsageSettings(undefined, supported).tencentShowBalance).toBe(true)
  expect(normalizeUsageSettings({ tencentShowBalance: false }, supported).tencentShowBalance).toBe(false)
  expect(normalizeUsageSettings({ bailianShowBalance: false }, supported).bailianShowBalance).toBe(false)
  expect(normalizeUsageSettings(undefined, 'invalid').enabled).toBe(false)
  expect(normalizeUsageSettings({ enabled: true, tencentSecretId: 'saved' }, 'https://unsupported.test/v1')).toMatchObject({ enabled: false, tencentSecretId: 'saved' })
  expect(normalizeUsageSettings({ enabled: false }, supported).enabled).toBe(false)
})
it('resets the switch when support changes and preserves a manual choice within the same type', () => {
  const off = normalizeUsageSettings({ enabled: false }, supported)
  expect(changeUsageEndpoint(off, supported, 'https://api.deepseek.com').enabled).toBe(false)
  const unsupported = changeUsageEndpoint({ ...off, enabled: true }, supported, 'https://custom.test')
  expect(unsupported.enabled).toBe(false)
  expect(changeUsageEndpoint(unsupported, 'https://custom.test', supported).enabled).toBe(true)
  expect(changeUsageEndpoint(off, supported, 'https://api.minimaxi.com/anthropic').enabled).toBe(true)
})
it('distinguishes provider paths and regions without guessing proxy URLs', () => {
  expect(usageEndpoint('https://open.bigmodel.cn/api/paas/v4')?.kind).toBe('balance')
  expect(usageEndpoint('https://open.bigmodel.cn/api/coding/paas/v4')?.kind).toBe('plan')
  expect(usageEndpoint('https://api.z.ai/api/paas/v4')).toBeUndefined()
  expect(usageEndpoint('https://tokenhub-intl.tencentmaas.com/plan/v3')).toMatchObject({ region: 'ap-singapore', personalPlans: false })
  for (const url of ['https://api.deepseek.com.evil.test/v1', 'https://proxy.test/deepseek/v1', 'file:///v1', 'https://api.deepseek.com/unknown']) expect(usageEndpoint(url)).toBeUndefined()
})
it('rejects invalid settings while preserving false, empty fields and display preferences', () => {
  expect(normalizeUsageSettings({ enabled: false, displayMode: 'detailed', bailianAccessKeySecret: '' }, supported)).toMatchObject({ enabled: false, displayMode: 'detailed', bailianAccessKeySecret: '' })
  for (const value of [null, [], { enabled: 0 }, { tencentSecretKey: 123 }, { displayMode: 'other' }, { bailianShowBalance: 'true' }, { tencentShowBalance: 0 }]) expect(() => normalizeUsageSettings(value, supported)).toThrow()
})
