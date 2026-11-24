function timestamp(value: any): any {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8.64e15 ? value : undefined;
}
function resetDescription(end: any, zh: any, now: any): any {
    const remaining: any = end - now;
    if (remaining <= 0)
        return zh ? '周期已结束，待刷新' : 'Window ended; awaiting refresh';
    if (remaining < 60000)
        return zh ? '不到 1 分钟后重置' : 'Resets in <1m';
    const minutes: any = Math.ceil(remaining / 60000);
    const days: any = Math.floor(minutes / 1440), hours: any = Math.floor(minutes % 1440 / 60), mins: any = minutes % 60;
    const parts: any = days ? [[days, '天', 'd'], [hours, '小时', 'h']] : [[hours, '小时', 'h'], [mins, '分钟', 'm']];
    const duration: any = parts.filter(([value]: any) => value).map(([value, cn, en]: any) => zh ? `${value} ${cn}` : `${value}${en}`).join(' ');
    return zh ? `约 ${duration}后重置` : `Resets in ${duration}`;
}
function parseQuota(payload: any, language: any, now: any = Date.now()): any {
    const status: any = payload?.base_resp?.status_code;
    if (status !== 0)
        throw new Error(status === 1004 || status === 2049 ? 'auth' : status === 1002 ? 'rate' : 'response');
    if (!Array.isArray(payload.model_remains))
        throw new Error('response');
    const rows: any = payload.model_remains.filter((row: any) => row && typeof row.model_name === 'string');
    // Token Plan is an account quota. "model_name" identifies quota buckets,
    // not the selected chat model. Older plans name the shared bucket MiniMax-M*.
    const row: any = rows.find((row: any) => row.model_name.toLowerCase() === 'general')
        ?? rows.find((row: any) => row.model_name.toLowerCase() === 'minimax-m*');
    if (!row)
        throw new Error('quota');
    if (row.current_interval_status === 3 && row.current_weekly_status === 3
        && row.current_interval_total_count === 0 && row.current_weekly_total_count === 0)
        throw new Error('quota');
    const zh: any = language.startsWith('zh');
    const lines: any = [], detailGroups: any = [];
    const formatPercent: any = (value: any) => `${Number(value.toFixed(2))}%`;
    // These are plan quota categories. A response can describe a shorter current
    // interval (for example 20:00–00:00); its bounds only determine reset timing.
    for (const [period, endKey, label, compactLabel] of [
        ['interval', 'end_time', zh ? '5h 限额' : '5h limit', '5h'],
        ['weekly', 'weekly_end_time', zh ? '周限额' : 'Weekly limit', zh ? '周' : '1w']
    ]) {
        const prefix: any = `current_${period}_`;
        if (row[prefix + 'status'] === 3) {
            lines.push({ label, compactLabel, value: zh ? '不限' : 'Unlimited' });
            continue;
        }
        const explicit: any = row[prefix + 'remaining_percent'];
        const total: any = row[prefix + 'total_count'], reported: any = row[prefix + 'usage_count'];
        let percent: any;
        // The explicit remaining percentage is authoritative. Legacy count-only
        // responses report remaining counts despite the name "usage_count".
        if (explicit !== undefined && explicit !== null) {
            if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit < 0 || explicit > 100)
                throw new Error('response');
            percent = explicit;
        }
        else if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
            if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0 || reported > total)
                throw new Error('response');
            percent = reported / total * 100;
        }
        else if (total === 0 || total === undefined)
            continue;
        else
            throw new Error('response');
        const end: any = timestamp(row[endKey]);
        const timing: any = end ? {
            description: resetDescription(end, zh, now),
            detail: `${zh ? '重置时间' : 'Resets'}: ${new Date(end).toLocaleString(language)}`
        } : {};
        const boost: any = period === 'weekly' ? (row.weekly_boost_permille ?? 1000) : 1000;
        if (typeof boost !== 'number' || !Number.isFinite(boost) || boost <= 0)
            throw new Error('response');
        // Show remaining quota in base-plan units, including weekly boosts.
        // The progress bar expresses remaining / total, so it never exceeds 100%.
        const remaining: any = percent * (boost / 1000);
        const used: any = (100 - percent) * (boost / 1000);
        if (!Number.isFinite(remaining) || !Number.isFinite(used))
            throw new Error('response');
        lines.push({ label, compactLabel, value: formatPercent(remaining), progress: percent / 100, ...timing });
        detailGroups.push({ summary: label, text: [
                `${zh ? '总额度' : 'Total quota'}: ${formatPercent(boost / 10)}`,
                `${zh ? '已用' : 'Used'}: ${formatPercent(used)}`,
                ...(boost !== 1000 ? [zh ? '含套餐加成，基础额度为 100%。' : 'Includes a plan boost.\nBase quota = 100%.'] : [])
            ].join('\n') });
    }
    if (!lines.length)
        throw new Error('response');
    return { lines, detailGroups };
}
function parseGlmQuota(payload: any, language: any, now: any = Date.now()): any {
    if (payload?.code !== 200 || payload.success === false) {
        if ([401, 403, 1001, 1002, 1003].includes(payload?.code))
            throw new Error('auth');
        if (payload?.code === 429)
            throw new Error('rate');
        if (typeof payload?.msg === 'string' && /不存在\s*coding\s*plan|(?:no|not have|not exist).*coding\s*plan|coding\s*plan.*(?:not exist|not found)/i.test(payload.msg))
            throw new Error('glm_plan');
        throw new Error('response');
    }
    const limits: any = payload.data?.limits;
    if (!Array.isArray(limits))
        throw new Error('response');
    const zh: any = language.startsWith('zh'), lines: any = [], detailGroups: any = [];
    // Match the official console: credit plans use CREDIT_LIMIT, older plans use
    // TOKENS_LIMIT and a separate monthly MCP allowance. Percentage means used.
    const creditPlan: any = limits.some((row: any) => row?.type === 'CREDIT_LIMIT');
    const planType: any = creditPlan ? 'CREDIT_LIMIT' : 'TOKENS_LIMIT';
    for (const [type, unit, number, label, compactLabel] of [
        [planType, 3, 5, zh ? '5 小时额度剩余' : '5-hour quota remaining', '5h'],
        [planType, 6, 1, zh ? '每周额度剩余' : 'Weekly quota remaining', zh ? '周' : '1w'],
        ...(!creditPlan ? [['TIME_LIMIT', 5, 1, zh ? 'MCP 每月额度剩余' : 'MCP monthly quota remaining', 'MCP']] : [])
    ]) {
        const matches: any = limits.filter((row: any) => row?.type === type && row.unit === unit);
        if (!matches.length)
            continue;
        const row: any = matches[0];
        if (matches.length !== 1 || (row.number != null && row.number !== number)
            || typeof row.percentage !== 'number' || !Number.isFinite(row.percentage) || row.percentage < 0 || row.percentage > 100)
            throw new Error('response');
        const remaining: any = 100 - row.percentage;
        const end: any = timestamp(row.nextResetTime);
        lines.push({ label, compactLabel, value: `${Number(remaining.toFixed(1))}%`, progress: remaining / 100,
            ...(end ? { description: resetDescription(end, zh, now) } : {}) });
        if (end)
            detailGroups.push({ summary: label, text: `${zh ? '重置时间' : 'Resets'}: ${new Date(end).toLocaleString(language)}` });
    }
    if (!lines.length)
        throw new Error('glm_quota');
    return { lines, detailGroups };
}
function parseBalance(payload: any, language: any): any {
    if (typeof payload?.is_available !== 'boolean' || !Array.isArray(payload.balance_infos))
        throw new Error('response');
    const zh: any = language.startsWith('zh');
    const currencies: any = new Set();
    const lines: any = payload.balance_infos.map((row: any) => {
        if (!row || !['CNY', 'USD'].includes(row.currency) || currencies.has(row.currency))
            throw new Error('response');
        currencies.add(row.currency);
        for (const key of ['total_balance', 'granted_balance', 'topped_up_balance']) {
            // Keep decimal strings intact: small balances must not round down to zero.
            if (typeof row[key] !== 'string' || row[key].length > 128 || !/^-?\d+(?:\.\d+)?$/.test(row[key]))
                throw new Error('response');
        }
        return { label: `${row.currency} ${zh ? '可用余额' : 'available'}`, compactLabel: row.currency, value: row.total_balance,
            breakdown: [
                { label: zh ? '赠金余额' : 'Granted balance', value: row.granted_balance },
                { label: zh ? '充值余额' : 'Topped-up balance', value: row.topped_up_balance }
            ] };
    });
    if (!lines.length && payload.is_available)
        throw new Error('response');
    return { lines, notice: payload.is_available ? undefined : (zh ? '余额不足，暂不可调用 API。' : 'Insufficient balance for API calls.') };
}
function numberText(value: any): any {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('response');
    return String(value);
}
function mimoMoney(value: any): any {
    if (typeof value !== 'string' || value.length > 128 || !/^-?\d+\.\d{2}$/.test(value))
        throw new Error('response');
    return BigInt(value.replace('.', ''));
}
function parseMimoBalance(payload: any, language: any): any {
    if (payload?.object !== 'balance' || typeof payload.is_available !== 'boolean'
        || !Array.isArray(payload.balance_infos) || payload.balance_infos.length !== 1)
        throw new Error('response');
    const row: any = payload.balance_infos[0], zh: any = language.startsWith('zh');
    if (!row || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency))
        throw new Error('response');
    const fields: any = [
        ['total_available', zh ? '总余额（含冻结）' : 'Total balance (including frozen)'],
        ['cash_balance', zh ? '现金余额' : 'Cash balance'],
        ['gift_balance', zh ? '赠金余额' : 'Gift balance'],
        ['frozen_balance', zh ? '冻结金额' : 'Frozen balance'],
        ['credit_limit', zh ? '授信额度' : 'Credit limit'],
        ['credit_available', zh ? '可用授信额度' : 'Available credit']
    ];
    const amounts: any = Object.fromEntries(fields.map(([key]: any) => [key, mimoMoney(row[key])]));
    if (amounts.frozen_balance < 0n)
        throw new Error('response');
    // MiMo total_available includes the frozen amount. Subtract in integer cents
    // so the spendable balance stays exact, including large and negative values.
    const available: any = amounts.total_available - amounts.frozen_balance;
    const absolute: any = available < 0n ? -available : available;
    const value: any = `${available < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
    return { lines: [{ label: `${row.currency} ${zh ? '可用余额' : 'available'}`, compactLabel: row.currency, value,
                breakdown: fields.map(([key, label]: any) => ({ label, value: `${row.currency} ${row[key]}` })) }],
        notice: payload.is_available ? undefined : (zh ? '余额不足，暂不可调用 API。' : 'Insufficient balance for API calls.') };
}
function mimoPeriodTime(value: any): any {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))
        throw new Error('response');
    const iso: any = value.replace(' ', 'T') + '.000Z';
    const time: any = Date.parse(iso);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== iso)
        throw new Error('response');
    return time;
}
function parseMimoQuota(payload: any, language: any, now: any = Date.now()): any {
    if (payload?.object !== 'token_plan' || typeof payload.plan_code !== 'string' || !payload.plan_code
        || typeof payload.auto_renew !== 'boolean' || typeof payload.claw_enabled !== 'boolean')
        throw new Error('response');
    const quota: any = payload.quota, zh: any = language.startsWith('zh');
    if (!quota || !['total_credits', 'used_credits', 'remaining_credits'].every((key: any) => Number.isSafeInteger(quota[key]) && quota[key] >= 0)
        || quota.remaining_credits !== Math.max(0, quota.total_credits - quota.used_credits))
        throw new Error('response');
    const start: any = mimoPeriodTime(payload.period?.start_at), end: any = mimoPeriodTime(payload.period?.end_at);
    if (end <= start)
        throw new Error('response');
    const progress: any = quota.total_credits > 0 ? quota.remaining_credits / quota.total_credits : undefined;
    const credits: any = (value: any) => `${new Intl.NumberFormat(language).format(value)} Credits`;
    return { lines: [{ label: zh ? '套餐额度剩余' : 'Plan quota remaining', compactLabel: zh ? '套餐' : 'Plan',
                value: progress === undefined ? credits(quota.remaining_credits) : `${Number((progress * 100).toFixed(2))}%`, progress,
                description: `${zh ? '周期结束' : 'Period ends'}: ${new Date(end).toLocaleString(language)}`,
                breakdown: [
                    { label: zh ? '总额度' : 'Total quota', value: credits(quota.total_credits) },
                    { label: zh ? '已用' : 'Used', value: credits(quota.used_credits) },
                    { label: zh ? '剩余额度' : 'Remaining credits', value: credits(quota.remaining_credits) }
                ] }], detailGroups: [{ summary: zh ? '个人 Token Plan' : 'Personal Token Plan', text: [
                    `${zh ? '套餐' : 'Plan'}: ${payload.plan_code}`,
                    `${zh ? '周期开始' : 'Period starts'}: ${new Date(start).toLocaleString(language)}`,
                    `${zh ? '自动续费' : 'Auto-renew'}: ${payload.auto_renew ? (zh ? '开启' : 'On') : (zh ? '关闭' : 'Off')}`,
                    `MiMo Claw: ${payload.claw_enabled ? (zh ? '开启' : 'On') : (zh ? '关闭' : 'Off')}`
                ].join('\n') }], notice: end <= now ? (zh ? '当前套餐周期已结束，请刷新查询。' : 'The current plan period has ended. Refresh to check.') : undefined };
}
function parseGlmBalance(payload: any, language: any): any {
    if (payload?.code !== 200 || payload.success === false) {
        if ([401, 403, 1001, 1002, 1003].includes(payload?.code))
            throw new Error('auth');
        if (payload?.code === 429)
            throw new Error('rate');
        throw new Error('response');
    }
    const zh: any = language.startsWith('zh'), data: any = payload.data;
    const available: any = numberText(data?.availableBalance);
    const breakdown: any = [
        ['rechargeAmount', zh ? '累计充值' : 'Total top-ups'],
        ['totalSpendAmount', zh ? '累计消费' : 'All-time spend'],
        ['frozenBalance', zh ? '冻结余额' : 'Frozen balance']
    ].filter(([key]: any) => data[key] != null).map(([key, label]: any) => ({ label, value: `CNY ${numberText(data[key])}` }));
    // Wallet balance does not include resource packages or Coding Plan allowances;
    // zero or negative cash alone cannot establish whether model calls are available.
    return { lines: [{ label: zh ? 'CNY 可用余额' : 'CNY available', compactLabel: 'CNY', value: available, breakdown,
                explanation: zh ? '账户余额，不包含资源包与 Coding Plan 额度。' : 'Account balance; excludes resource packages and Coding Plan quotas.' }] };
}
function parseMoonshot(payload: any, language: any, currency: any): any {
    if (payload?.code !== 0 || payload.status !== true || !payload.data)
        throw new Error('response');
    const zh: any = language.startsWith('zh'), data: any = payload.data;
    const available: any = numberText(data.available_balance), cash: any = numberText(data.cash_balance), voucher: any = numberText(data.voucher_balance);
    if (data.voucher_balance < 0)
        throw new Error('response');
    return { lines: [{ label: `${currency} ${zh ? '可用余额' : 'available'}`, compactLabel: currency, value: available,
                breakdown: [{ label: zh ? '代金券余额' : 'Voucher balance', value: voucher }, { label: zh ? '现金余额' : 'Cash balance', value: cash }] }],
        notice: data.available_balance <= 0 ? (zh ? '余额不足，暂不可调用 API。' : 'Insufficient balance for API calls.') : undefined };
}
function parseOpenRouter(payload: any, language: any): any {
    const data: any = payload?.data, zh: any = language.startsWith('zh');
    if (!data || (data.limit !== null && (typeof data.limit !== 'number' || data.limit < 0)))
        throw new Error('response');
    if (data.limit !== null)
        numberText(data.limit);
    const unlimited: any = data.limit === null;
    if (unlimited && data.limit_remaining !== null)
        throw new Error('response');
    const remaining: any = unlimited ? (zh ? '未设上限' : 'No cap') : `USD ${numberText(data.limit_remaining)}`;
    const breakdown: any = [[zh ? '累计消费' : 'All-time spend', 'usage'], [zh ? '今日消费（UTC）' : 'Daily spend (UTC)', 'usage_daily'],
        [zh ? '本周消费（UTC）' : 'Weekly spend (UTC)', 'usage_weekly'], [zh ? '本月消费（UTC）' : 'Monthly spend (UTC)', 'usage_monthly']]
        .filter(([, key]: any) => key === 'usage' || data[key] !== undefined)
        .map(([label, key]: any) => {
        const value: any = numberText(data[key]);
        if (data[key] < 0)
            throw new Error('response');
        return { label, value: `USD ${value}` };
    });
    if (!unlimited)
        breakdown.unshift({ label: zh ? '密钥额度上限' : 'Key spending cap', value: `USD ${data.limit}` });
    if (data.limit_reset != null) {
        const resets: any = { daily: zh ? '每天' : 'Daily', weekly: zh ? '每周' : 'Weekly', monthly: zh ? '每月' : 'Monthly' };
        if (!Object.hasOwn(resets, data.limit_reset))
            throw new Error('response');
        breakdown.push({ label: zh ? '额度重置周期' : 'Cap reset interval', value: resets[data.limit_reset] });
    }
    if (data.expires_at != null) {
        const expires: any = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN;
        if (!Number.isFinite(expires))
            throw new Error('response');
        breakdown.push({ label: zh ? '密钥到期时间' : 'Key expires', value: new Date(expires).toLocaleString(language) });
    }
    return { lines: [{ label: zh ? '密钥剩余额度' : 'Key remaining credits', compactLabel: zh ? '密钥' : 'Key', value: remaining,
                explanation: zh ? '仅当前 API Key 的额度，不代表账户余额。' : 'Current API key cap; not the account balance.', breakdown }] };
}
export { parseQuota, parseBalance, parseGlmQuota, parseMimoBalance, parseMimoQuota, parseGlmBalance, parseMoonshot, parseOpenRouter };
