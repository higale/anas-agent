import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import en from '../../../../../data/lang/en.json'
import zhCN from '../../../../../data/lang/zh-CN.json'
import { modelImageLimitsSummary } from './modelImageLimitsSummary'

describe.each(['en', 'zh-CN'])('model image limit summaries in %s', language => {
  async function translator() {
    return createInstance().init({ lng: language, fallbackLng: 'en', interpolation: { escapeValue: false },
      resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } } })
  }

  it('shows every configured limit with exact values and the Base64 measurement basis', async () => {
    const t = await translator()
    expect(modelImageLimitsSummary({ minShortSide: 10, maxLongSide: 4096, maxPixels: 12_000_000,
      maxAspectRatio: 1.00001, maxBytes: 1_500_000, byteBasis: 'base64', maxCount: 3 }, t)).toBe((language === 'en' ? [
      'Image input limits', 'Minimum short side (px): 10', 'Maximum long side (px): 4,096',
      'Maximum pixels: 12,000,000', 'Maximum aspect ratio: 1.00001',
      'Maximum image size (bytes): 1,500,000 (Base64 encoded)', 'Images per request: 3'
    ] : [
      '图片输入限制', '最小短边（px）：10', '最大长边（px）：4,096', '最大总像素：12,000,000',
      '最大长短边比：1.00001', '单图大小（字节）：1,500,000（Base64 编码后）', '单次请求图片数量：3'
    ]).join('\n'))
  })

  it('keeps zero limits and defaults to original-file bytes', async () => {
    const t = await translator()
    expect(modelImageLimitsSummary({ maxBytes: 0, maxCount: 0 }, t)).toBe(language === 'en'
      ? 'Image input limits\nMaximum image size (bytes): 0 (Original file)\nImages per request: 0'
      : '图片输入限制\n单图大小（字节）：0（原始文件）\n单次请求图片数量：0')
  })

  it('distinguishes unconfigured limits from a provider having no limits', async () => {
    const t = await translator()
    for (const limits of [undefined, {}, { byteBasis: 'base64' as const }]) {
      expect(modelImageLimitsSummary(limits, t)).toBe(language === 'en'
        ? 'Image input limits: not configured' : '图片输入限制：未配置')
    }
  })
})
