import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import { attachmentImageFailure, modelImageCountFailure, modelImageDataFailure, type ModelImageFailureFormatter } from '@shared/modelImageValidation'
import type { ModelImageLimits } from '@shared/modelImageLimits'
import en from '../../data/lang/en.json'
import zhCN from '../../data/lang/zh-CN.json'
import { modelImageFailureMessage } from '@shared/modelImageFailureMessage'

const data = new Uint8Array(54), header = new DataView(data.buffer)
data.set([0x42, 0x4d])
header.setUint32(14, 40, true)
header.setInt32(18, 8, true)
header.setInt32(22, -6, true)
const base64 = btoa(String.fromCharCode(...data))

describe.each(['en', 'zh-CN'])('image validation messages in %s', language => {
  it.each<{ limits: ModelImageLimits; english: string; chinese: string }>([
    { limits: { minShortSide: 10 }, english: 'Dimensions 8×6 px: short side 6 px is below the minimum of 10 px.',
      chinese: '图片尺寸为 8×6 像素：短边 6 像素，小于 10 像素的下限。' },
    { limits: { maxLongSide: 7 }, english: 'Dimensions 8×6 px: long side 8 px exceeds the maximum of 7 px.',
      chinese: '图片尺寸为 8×6 像素：长边 8 像素，超过 7 像素的上限。' },
    { limits: { maxPixels: 47 }, english: 'Dimensions 8×6 px: 48 pixels exceeds the limit of 47 pixels.',
      chinese: '图片尺寸为 8×6 像素：总像素数为 48，超过 47 的上限。' },
    { limits: { maxAspectRatio: 1.25 }, english: 'Dimensions 8×6 px: aspect ratio 1.3333333333333333 exceeds the limit of 1.25.',
      chinese: '图片尺寸为 8×6 像素：长短边比例为 1.3333333333333333，超过 1.25 的上限。' },
    { limits: { maxBytes: 0 }, english: 'Original size 54 bytes exceeds the limit of 0 bytes.',
      chinese: '原始图片大小为 54 字节，超过 0 字节的上限。' },
    { limits: { maxBytes: 71, byteBasis: 'base64' }, english: 'Base64 size 72 bytes exceeds the limit of 71 bytes.',
      chinese: '图片 Base64 编码后大小为 72 字节，超过 71 字节的上限。' }
  ])('formats the actual failure for $limits', async ({ limits, english, chinese }) => {
    const t = await createInstance().init({ lng: language, resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } } })
    const format: ModelImageFailureFormatter = failure => modelImageFailureMessage(failure, t)
    for (const value of [data, base64]) {
      expect(modelImageDataFailure({ data: value }, limits, format)).toBe(language === 'en' ? english : chinese)
    }
    expect(attachmentImageFailure({ path: '/图片.bmp', name: '图片.bmp', kind: 'image', mimeType: 'image/bmp', size: data.length,
      contextPolicy: 'one_turn', dataUri: `data:image/bmp;base64,${base64}` }, limits, format)).toBe(language === 'en' ? english : chinese)
  })

  it('formats invalid image data, unreadable dimensions, and image counts', async () => {
    const t = await createInstance().init({ lng: language, resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } } })
    const format: ModelImageFailureFormatter = failure => modelImageFailureMessage(failure, t)
    expect(modelImageDataFailure({ data: 'not-base64' }, { minShortSide: 10 }, format)).toBe(language === 'en'
      ? 'Invalid Base64 image data; the configured image rules could not be checked.'
      : '图片的 Base64 数据无效，无法检查已配置的图片限制。')
    expect(modelImageDataFailure({ data: 'AAAA' }, { minShortSide: 10 }, format)).toBe(language === 'en'
      ? 'Image dimensions could not be read from the first 1,048,576 bytes (damaged or unsupported image header); the configured dimension rules could not be checked.'
      : '无法从前 1,048,576 字节读取图片尺寸（图片头损坏或格式不受支持），无法检查已配置的尺寸限制。')
    expect(modelImageCountFailure(2, { maxCount: 1 }, format)).toBe(language === 'en'
      ? 'This request contains 2 embedded images, exceeding the limit of 1.' : '本次请求包含 2 张内嵌图片，超过 1 张的上限。')
    expect(modelImageCountFailure(1, { maxCount: 0 }, format)).toBe(language === 'en'
      ? 'This request contains 1 embedded images, exceeding the limit of 0.' : '本次请求包含 1 张内嵌图片，超过 0 张的上限。')
    expect(modelImageCountFailure(1, { maxCount: 1 }, format)).toBeUndefined()
  })
})
