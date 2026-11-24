import { createHash, createHmac } from 'node:crypto';
// Cloud API credentials identify a cloud account, independently of the model API key.
// https://cloud.tencent.com/document/api/555/20253
// https://cloud.tencent.com/document/api/1823/132340
// https://cloud.tencent.com/document/api/1823/140967
const personalProducts: any = ['personal', 'personal-hunyuan'];
function monthStart(now: any = Date.now()): any {
    // Request calendar months in China Standard Time in both regions.
    return new Date(now + 8 * 3600000).toISOString().slice(0, 7) + '-01T00:00:00+08:00';
}
function usageWindows(start: any, end: any): any {
    const today: any = new Date(Date.parse(end) + 8 * 3600000).toISOString().slice(0, 10) + 'T00:00:00+08:00';
    const days: any = (Date.parse(today) - Date.parse(start)) / 86400000;
    const windows: any = [];
    // Coarse aggregates can omit the current day. Never query today's usage through
    // the monthly/day-level rollup, even when it returns a successful zero response.
    if (days > 0)
        windows.push({ StartTime: start, EndTime: today, Period: days <= 1 ? 60 : days <= 5 ? 300 : days <= 10 ? 3600 : 86400 });
    if (Date.parse(end) > Date.parse(today))
        windows.push({ StartTime: today, EndTime: end, Period: 60 });
    return windows;
}
function signedRequest(service: any, version: any, action: any, params: any, auth: any, region: any, now: any = Date.now()): any {
    const host: any = `${service}.tencentcloudapi.com`;
    const timestamp: any = Math.floor(now / 1000);
    const date: any = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const body: any = JSON.stringify(params);
    const hash: any = (value: any) => createHash('sha256').update(value).digest('hex');
    const hmac: any = (key: any, value: any) => createHmac('sha256', key).update(value).digest();
    const signedHeaders: any = 'content-type;host;x-tc-action';
    const canonicalHeaders: any = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const canonicalRequest: any = ['POST', '/', '', canonicalHeaders, signedHeaders, hash(body)].join('\n');
    const scope: any = `${date}/${service}/tc3_request`;
    const stringToSign: any = ['TC3-HMAC-SHA256', timestamp, scope, hash(canonicalRequest)].join('\n');
    const signingKey: any = hmac(hmac(hmac(`TC3${auth.key}`, date), service), 'tc3_request');
    const signature: any = hmac(signingKey, stringToSign).toString('hex');
    return { url: `https://${host}/`, options: { method: 'POST', body, headers: {
                'Content-Type': 'application/json; charset=utf-8', 'X-TC-Action': action, 'X-TC-Version': version,
                'X-TC-Timestamp': String(timestamp), ...(region ? { 'X-TC-Region': region } : {}),
                Authorization: `TC3-HMAC-SHA256 Credential=${auth.id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
            } } };
}
function response(payload: any): any {
    const data: any = payload?.Response;
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('response');
    if (data.Error) {
        const code: any = data.Error.Code;
        if (typeof code !== 'string')
            throw new Error('response');
        // Never propagate the upstream message, which may contain request information.
        throw new Error(code.startsWith('AuthFailure') ? 'tencent_auth'
            : code.startsWith('UnauthorizedOperation') ? 'tencent_permission'
                : code.startsWith('RequestLimitExceeded') ? 'rate' : 'response');
    }
    return data;
}
function validBalance(data: any): any {
    if (typeof data.RealBalance !== 'number' || !Number.isFinite(data.RealBalance))
        throw new Error('response');
    const result: any = { RealBalance: data.RealBalance };
    for (const key of ['CashAccountBalance', 'IncomeIntoAccountBalance', 'PresentAccountBalance', 'FreezeAmount', 'OweAmount']) {
        if (data[key] == null)
            continue;
        if (typeof data[key] !== 'number' || !Number.isFinite(data[key]))
            throw new Error('response');
        result[key] = data[key];
    }
    return result;
}
function validUsage(data: any): any {
    const stats: any = data.TotalStats;
    if (!stats || !Number.isSafeInteger(stats.TotalToken) || stats.TotalToken < 0)
        throw new Error('response');
    const result: any = { TotalToken: stats.TotalToken };
    for (const key of ['InputTotalToken', 'OutputTotalToken', 'CacheTotalToken']) {
        if (stats[key] == null)
            continue;
        if (!Number.isSafeInteger(stats[key]) || stats[key] < 0)
            throw new Error('response');
        result[key] = stats[key];
    }
    return result;
}
function planDate(value: any): any {
    if (typeof value !== 'string')
        throw new Error('response');
    // Date-only cycle ends have no reset time. Preserve their precision; timezone-
    // less timestamps returned by the Guangzhou API are China Standard Time.
    const dateOnly: any = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const normalized: any = value.replace(' ', 'T');
    const local: any = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized);
    if (!dateOnly && !local && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized))
        throw new Error('response');
    if (!dateOnly && (Number(normalized.slice(11, 13)) > 23 || Number(normalized.slice(14, 16)) > 59 || Number(normalized.slice(17, 19)) > 59))
        throw new Error('response');
    const time: any = Date.parse(dateOnly ? value + 'T00:00:00+08:00' : local ? normalized + '+08:00' : normalized);
    const calendarDay: any = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(time) || !Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== value.slice(0, 10))
        throw new Error('response');
    return { value: dateOnly ? value : new Date(time).toISOString(), time, dateOnly };
}
function validPlan(data: any, product: any): any {
    const status: any = typeof data.PackageStatus === 'string' ? data.PackageStatus.toLowerCase() : '';
    if (data.ProductType !== product || !['active', 'processing', 'failed', 'isolated', 'destroyed', 'used_up', 'stopped', 'unpurchased'].includes(status))
        throw new Error('response');
    const result: any = { status };
    if (status === 'unpurchased')
        return result;
    for (const key of ['TotalCredits', 'TotalUsed', 'CycleCredits']) {
        const value: any = data[key];
        if (value == null && (status !== 'active' || key === 'CycleCredits'))
            continue;
        if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > Number.MAX_SAFE_INTEGER)
            throw new Error('response');
        result[key] = Number(value);
    }
    for (const key of ['InputToken', 'OutputToken', 'CacheToken', 'TotalCycles', 'CurrentCycle', 'RemainCycles']) {
        if (data[key] == null)
            continue;
        if (!Number.isSafeInteger(data[key]) || data[key] < 0)
            throw new Error('response');
        result[key] = data[key];
    }
    for (const key of ['StartTime', 'ExpireTime', 'PeriodEndDate']) {
        if (data[key] == null)
            continue;
        result[key] = planDate(data[key]);
    }
    if (result.StartTime && result.ExpireTime && result.ExpireTime.time <= result.StartTime.time)
        throw new Error('response');
    if (data.AutoRenewFlag != null) {
        if (![0, 1].includes(data.AutoRenewFlag))
            throw new Error('response');
        result.AutoRenewFlag = data.AutoRenewFlag;
    }
    return result;
}
async function query(provider: any, auth: any, requestJson: any, signal: any): Promise<any> {
    const now: any = Date.now(), start: any = monthStart(now), end: any = new Date(Math.floor(now / 60000) * 60000).toISOString();
    const read: any = async (service: any, version: any, action: any, params: any, region: any) => {
        const request: any = signedRequest(service, version, action, params, auth, region, now);
        return response(await requestJson(request.url, { ...request.options, signal, redirect: 'error' }));
    };
    const requests: any = [];
    if (provider.showBalance)
        requests.push({ name: 'balance', read: async () => validBalance(await read('billing', '2018-07-09', 'DescribeAccountBalance', {})) });
    if (provider.personalPlans)
        for (const product of personalProducts)
            requests.push({ name: product,
                read: async () => validPlan(await read('tokenhub', '2026-03-22', 'DescribeTokenPlanPersonalPackage', { ProductType: product }, provider.region), product) });
    if (provider.usage)
        requests.push({ name: 'usage', read: async () => {
                const windows: any = usageWindows(start, end);
                if (!windows.length)
                    throw new Error('tencent_pending');
                const results: any = await Promise.allSettled(windows.map(async (window: any) => validUsage(await read('tokenhub', '2026-03-22', 'DescribeUsageRankList', { Dimension: 'model', MetricType: 'tokens', ...window, ShowAll: true }, provider.region))));
                // Wait for every segment, so cancellation and the shared timeout still cover
                // outstanding requests. A failed segment must not become a partial monthly sum.
                const failure: any = results.find((result: any) => result.status === 'rejected');
                if (failure)
                    throw failure.reason;
                const total: any = {};
                for (const key of ['TotalToken', 'InputTotalToken', 'OutputTotalToken', 'CacheTotalToken']) {
                    if (!results.every((result: any) => result.value[key] !== undefined))
                        continue;
                    total[key] = results.reduce((sum: any, result: any) => sum + result.value[key], 0);
                }
                return validUsage({ TotalStats: total });
            } });
    const results: any = await Promise.all(requests.map(async (item: any) => {
        try {
            const data: any = await item.read();
            return [item.name, { data }];
        }
        catch (error: any) {
            const code: any = error.message === 'auth' ? 'tencent_auth' : ['tencent_auth', 'tencent_permission', 'tencent_pending', 'rate', 'response', 'network'].includes(error.message) ? error.message : 'network';
            return [item.name, { error: code }];
        }
    }));
    signal.throwIfAborted();
    const data: any = Object.fromEntries(results);
    if (results.length && results.every(([, item]: any) => item.error))
        throw new Error(results[0][1].error);
    return { ...data, personalPlans: provider.personalPlans === true, region: provider.region, start, end };
}
const errors: any = {
    zh: { tencent_config: '请在用量仪表的模型设置中填写腾讯 SecretId 和 SecretKey。',
        tencent_auth: '请检查模型设置中的腾讯 SecretId 和 SecretKey。',
        tencent_pending: '当月用量统计尚未生成，请稍后刷新。',
        tencent_permission: '腾讯查询凭据缺少此项查询权限。', rate: '查询受到限流，请稍后刷新。',
        response: '腾讯接口未返回可识别的数据。', network: '腾讯查询失败，请稍后刷新。' },
    en: { tencent_config: 'Enter Tencent SecretId and SecretKey in Usage Meter model settings.',
        tencent_auth: 'Check Tencent SecretId and SecretKey in model settings.',
        tencent_pending: 'Monthly usage statistics are not available yet. Refresh shortly.',
        tencent_permission: 'The Tencent credentials lack permission for this query.', rate: 'Rate limited. Try again later.',
        response: 'Unrecognized Tencent response.', network: 'Tencent query failed. Try again later.' }
};
function parse(data: any, language: any, now: any = Date.now()): any {
    const zh: any = language.startsWith('zh'), lines: any = [], detailGroups: any = [], failures: any = [];
    const format: any = (value: any) => new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(value);
    const money: any = (value: any) => new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value / 100);
    const accountLabel: any = zh ? '云账户可用余额' : 'Cloud account available balance';
    if (data.balance?.data) {
        const balance: any = validBalance(data.balance.data);
        lines.push({ label: accountLabel, compactLabel: 'CNY', value: money(balance.RealBalance), breakdown: [
                ['CashAccountBalance', zh ? '现金余额' : 'Cash balance'], ['IncomeIntoAccountBalance', zh ? '收益转入' : 'Income transferred'],
                ['PresentAccountBalance', zh ? '赠送余额' : 'Gift balance'], ['FreezeAmount', zh ? '冻结金额' : 'Frozen funds'], ['OweAmount', zh ? '欠费金额' : 'Amount owed']
            ].filter(([key]: any) => balance[key] !== undefined).map(([key, label]: any) => ({ label, value: `CNY ${money(balance[key])}` })) });
    }
    else if (data.balance?.error)
        failures.push(`${accountLabel}: ${errors[zh ? 'zh' : 'en'][data.balance.error]}`);
    const usageLabel: any = zh ? '本月用量' : 'Usage this month';
    if (data.usage?.data) {
        const usage: any = validUsage({ TotalStats: data.usage.data });
        lines.push({ label: usageLabel, compactLabel: zh ? '本月' : 'Month', value: `${format(usage.TotalToken)} tokens`, breakdown: [
                ['InputTotalToken', zh ? '输入' : 'Input'], ['OutputTotalToken', zh ? '输出' : 'Output'], ['CacheTotalToken', zh ? '缓存命中' : 'Cache reads']
            ].filter(([key]: any) => usage[key] !== undefined).map(([key, label]: any) => ({ label, value: `${format(usage[key])} tokens` })) });
        detailGroups.push({ summary: usageLabel, text: [
                `${zh ? '地域' : 'Region'}: ${data.region}`,
                `${new Date(data.start).toLocaleString(language)} – ${new Date(data.end).toLocaleString(language)}`,
                zh ? '当天按分钟统计，历史用量以腾讯汇总为准。' : 'Today uses minute-level statistics; historical usage follows Tencent rollups.'
            ].join('\n') });
    }
    else if (data.usage?.error)
        failures.push(`${usageLabel}: ${errors[zh ? 'zh' : 'en'][data.usage.error]}`);
    if (data.personalPlans)
        for (const product of personalProducts) {
            const label: any = product === 'personal' ? (zh ? '通用 Token Plan' : 'General Token Plan') : 'Hy Token Plan';
            const item: any = data[product];
            if (item?.error) {
                failures.push(`${label}: ${errors[zh ? 'zh' : 'en'][item.error]}`);
                continue;
            }
            const plan: any = item?.data;
            if (!plan)
                continue;
            const states: any = zh
                ? { active: '生效中', processing: '处理中', failed: '创建失败', isolated: '已隔离／欠费', destroyed: '已销毁', used_up: '额度用尽', stopped: '已停止', unpurchased: '未购买' }
                : { active: 'Active', processing: 'Processing', failed: 'Creation failed', isolated: 'Isolated / overdue', destroyed: 'Destroyed', used_up: 'Quota exhausted', stopped: 'Stopped', unpurchased: 'Not purchased' };
            const date: any = (value: any) => value.dateOnly ? value.value : new Date(value.time).toLocaleString(language);
            const today: any = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
            const past: any = (value: any) => value && (value.dateOnly ? value.value < today : value.time <= now);
            const ended: any = past(plan.ExpireTime), cycleEnded: any = past(plan.PeriodEndDate);
            const state: any = ended ? (zh ? '已到期，请刷新' : 'Expired; refresh to check') : states[plan.status];
            if (plan.status === 'unpurchased') {
                detailGroups.push({ summary: label, text: `${zh ? '状态' : 'Status'}: ${state}` });
                continue;
            }
            const remaining: any = plan.TotalCredits !== undefined && plan.TotalUsed !== undefined ? Math.max(0, plan.TotalCredits - plan.TotalUsed) : undefined;
            const available: any = plan.status === 'active' && !ended && !cycleEnded;
            const progress: any = available && plan.TotalCredits > 0 ? remaining / plan.TotalCredits : undefined;
            const credits: any = (value: any) => `${format(value)} ${zh ? '积分' : 'Credits'}`;
            const breakdown: any = [
                ['TotalCredits', zh ? '总额度' : 'Total quota'], ['TotalUsed', zh ? '已用' : 'Used']
            ].filter(([key]: any) => plan[key] !== undefined).map(([key, name]: any) => ({ label: name, value: credits(plan[key]) }));
            if (remaining !== undefined)
                breakdown.push({ label: zh ? '剩余额度' : 'Remaining credits', value: credits(remaining) });
            for (const [key, name] of [['InputToken', zh ? '输入' : 'Input'], ['OutputToken', zh ? '输出' : 'Output'], ['CacheToken', zh ? '缓存命中' : 'Cache reads']]) {
                if (plan[key] !== undefined)
                    breakdown.push({ label: name, value: `${format(plan[key])} tokens` });
            }
            if (plan.CycleCredits !== undefined && plan.CycleCredits !== plan.TotalCredits)
                breakdown.push({ label: zh ? '单周期额度' : 'Quota per cycle', value: credits(plan.CycleCredits) });
            if (plan.TotalCycles > 1)
                for (const [key, name] of [['TotalCycles', zh ? '总周期数' : 'Total cycles'], ['CurrentCycle', zh ? '当前周期' : 'Current cycle'], ['RemainCycles', zh ? '剩余周期数' : 'Remaining cycles']]) {
                    if (plan[key] !== undefined)
                        breakdown.push({ label: name, value: format(plan[key]) });
                }
            for (const [key, name] of [['StartTime', zh ? '套餐生效' : 'Plan starts'], ['ExpireTime', zh ? '套餐到期' : 'Plan expires']]) {
                if (plan[key])
                    breakdown.push({ label: name, value: date(plan[key]) });
            }
            if (plan.AutoRenewFlag !== undefined)
                breakdown.push({ label: zh ? '自动续费' : 'Auto-renew', value: plan.AutoRenewFlag ? (zh ? '开启' : 'On') : (zh ? '关闭' : 'Off') });
            lines.push({ label, compactLabel: product === 'personal' ? (zh ? '通用' : 'General') : 'Hy', progress, breakdown,
                value: available ? (progress === undefined ? credits(remaining) : `${Number((progress * 100).toFixed(2))}%`)
                    : cycleEnded && !ended && plan.status === 'active' ? (zh ? '周期已结束，请刷新' : 'Period ended; refresh to check') : state,
                description: plan.PeriodEndDate ? `${zh ? '周期结束' : 'Period ends'}: ${date(plan.PeriodEndDate)}` : undefined });
        }
    if (data.personalPlans && personalProducts.every((product: any) => data[product]?.data?.status === 'active'))
        detailGroups.push({
            summary: zh ? '套餐抵扣顺序' : 'Plan deduction order',
            text: zh ? '同一模型被两种套餐支持时，腾讯优先抵扣本计费周期内较早到期的套餐包。'
                : 'For models supported by both plans, Tencent first debits the package that expires earlier in the current billing cycle.'
        });
    detailGroups.unshift({ summary: zh ? '查询范围' : 'Query scope', text: zh
            ? data.personalPlans ? '查询凭据对应云账户的余额及广州个人版通用、Hy Token Plan，未与当前模型 API Key 核对；云账户余额与套餐积分分别显示。'
                : '模型设置中查询凭据对应的云账户。余额不含 Token Plan 套餐额度，用量仅含所选地域的普通 TokenHub API，不是当前模型密钥或对话的用量。'
            : data.personalPlans ? 'Cloud account balance and Guangzhou personal General / Hy Token Plans identified by query credentials, not matched to the current model API key. Cash balance and plan Credits are shown separately.'
                : 'Cloud account identified by the credentials in model settings. Balance excludes Token Plan quota; usage covers ordinary TokenHub API calls in the selected region, not the current model key or conversation.' });
    return { lines, detailGroups, ...(failures.length ? { error: failures.join('\n') } : {}) };
}
export { query, parse, monthStart, errors };
