import { afterEach, expect, it, vi } from 'vitest'
import { normalizeUsageSettings } from '@shared/usageMeter'
import { queryAliyunBalance, signBalanceRequest } from './aliyunBalance'

const settings = normalizeUsageSettings({ bailianAccessKeyId: 'fixture-id', bailianAccessKeySecret: 'fixture-secret' }, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
afterEach(() => vi.unstubAllGlobals())

it('signs the read-only BSS operation using an independently calculated RPC signature', () => {
  const request = signBalanceRequest('fixture-id', 'fixture-secret', new Date('2026-11-24T00:00:00Z'), 'fixture-nonce')
  const params = new URLSearchParams(String(request.body))
  expect(params.get('Action')).toBe('QueryAccountBalance')
  expect(params.get('Version')).toBe('2017-12-14')
  expect(params.get('Signature')).toBe('BavcKqwhDO4/UiqqP9a0WNzwnkY=')
  expect(JSON.stringify(request)).not.toContain('fixture-secret')
})

it.each(['0.00', '-0.01', '1,692.060001'])('preserves cash amount %s and keeps credit separate', async cash => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ Success: true, Code: '200', Data: {
    Currency: 'CNY', AvailableCashAmount: cash, AvailableAmount: '2,000.00', CreditAmount: '0.00'
  } })))
  expect(await queryAliyunBalance(settings, new AbortController().signal)).toEqual({
    Currency: 'CNY', AvailableCashAmount: cash.replace(/,/g, ''), AvailableAmount: '2000.00', CreditAmount: '0.00'
  })
})

it.each([null, '', 'NaN', '12,34', Infinity])('rejects invalid money rather than inventing zero: %s', async cash => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ Success: true, Code: '200', Data: {
    Currency: 'CNY', AvailableCashAmount: cash, AvailableAmount: '10.00'
  } })))
  await expect(queryAliyunBalance(settings, new AbortController().signal)).rejects.toThrow('bailian_balance_failed')
})

it('classifies denied HTTP access without exposing the response body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('secret upstream message', { status: 403 })))
  await expect(queryAliyunBalance(settings, new AbortController().signal)).rejects.toThrow('bailian_balance_permission')
})
