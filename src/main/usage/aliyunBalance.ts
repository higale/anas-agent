import { createHmac, randomUUID } from 'node:crypto'
import type { UsageLine, UsageSettings } from '@shared/usageMeter'
import { requestJson } from './http'

export interface AliyunBalance {
  Currency: string
  AvailableAmount: string
  AvailableCashAmount: string
  CreditAmount?: string
  MybankCreditAmount?: string
}

export function signBalanceRequest(id: string, secret: string, now = new Date(), nonce: string = randomUUID()): RequestInit {
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
  const parameters: Record<string, string> = {
    Action: 'QueryAccountBalance', Version: '2017-12-14', Format: 'JSON', AccessKeyId: id,
    SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', SignatureNonce: nonce,
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  const canonical = Object.keys(parameters).sort().map(key => `${encode(key)}=${encode(parameters[key])}`).join('&')
  const signature = createHmac('sha1', secret + '&').update(`POST&%2F&${encode(canonical)}`).digest('base64')
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${canonical}&Signature=${encode(signature)}` }
}

export async function queryAliyunBalance(settings: UsageSettings, signal: AbortSignal): Promise<AliyunBalance> {
  const id = settings.bailianAccessKeyId.trim(), secret = settings.bailianAccessKeySecret.trim()
  if (!id || !secret) throw new Error('bailian_config')
  try {
    const response = await requestJson('https://business.aliyuncs.com/', { ...signBalanceRequest(id, secret), signal })
    if (response?.Success !== true || String(response.Code) !== '200') {
      throw new Error(/NoPermission|Forbidden|NotAuthorized|AccessDenied|InvalidAccessKey|Signature/i.test(String(response?.Code))
        ? 'bailian_balance_permission' : 'bailian_balance_failed')
    }
    const data = response.Data
    if (!data || !['CNY', 'USD', 'JPY'].includes(data.Currency)) throw new Error('bailian_balance_failed')
    const result: AliyunBalance = { Currency: data.Currency, AvailableAmount: '', AvailableCashAmount: '' }
    for (const key of ['AvailableAmount', 'AvailableCashAmount', 'CreditAmount', 'MybankCreditAmount'] as const) {
      const value = data[key]
      if (value === undefined && (key === 'CreditAmount' || key === 'MybankCreditAmount')) continue
      // BSS amounts may contain thousands separators. Preserve decimal precision and negative balances.
      if (typeof value !== 'string' || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value.replace(/,/g, '')))) {
        throw new Error('bailian_balance_failed')
      }
      result[key] = value.replace(/,/g, '')
    }
    return result
  } catch (error) {
    if (signal.aborted) throw new Error('bailian_balance_timeout')
    if (error instanceof Error && error.message === 'auth') throw new Error('bailian_balance_permission')
    if (error instanceof Error && error.message.startsWith('bailian_balance_')) throw error
    throw new Error('bailian_balance_failed')
  }
}

export function aliyunBalanceLine(balance: AliyunBalance, language: string): UsageLine {
  const zh = language.startsWith('zh')
  return {
    label: zh ? '阿里云账户余额' : 'Alibaba Cloud account balance', compactLabel: balance.Currency, value: balance.AvailableCashAmount,
    detail: zh ? 'RAM 凭据对应的云账户现金余额' : 'Cloud account cash balance identified by the RAM credentials',
    breakdown: [
      { label: zh ? '可用额度' : 'Available credit', value: `${balance.Currency} ${balance.AvailableAmount}` },
      ...(balance.CreditAmount === undefined ? [] : [{ label: zh ? '信控余额' : 'Credit balance', value: `${balance.Currency} ${balance.CreditAmount}` }]),
      ...(balance.MybankCreditAmount === undefined ? [] : [{ label: zh ? '网商银行信用额度' : 'MYbank credit', value: `${balance.Currency} ${balance.MybankCreditAmount}` }])
    ]
  }
}
