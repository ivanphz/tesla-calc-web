// 电价相关的纯计算逻辑：把"分时电价配置文本"解析成结构化时段，
// 以及给定一段"从几点开始、持续多久"的用电，算出这段用电横跨了哪些电价时段、总共要花多少钱。
// 这一层完全不知道"充电"是什么，只知道"钟点"和"电价"，所以可以被 calculator.js 之外的任何场景复用。

// 把类似
//   22:00-07:00=0.3783
//   07:00-11:00=0.5783
// 这样的多行文本，解析成 [{start, end, price}, ...]。
// 跨天的时段（比如 22:00-07:00）会被物理拆成当天的两段（22:00-24:00 和 0:00-07:00），
// 后面 calculateCost 就完全不用关心"跨不跨天"这件事了。
export function parseTariffs(tariffStr) {
    if (!tariffStr) return [];
    const tariffs = [];
    const periods = tariffStr.replace(/\n/g, ',').split(',');

    for (const p of periods) {
        if (!p.trim()) continue;
        const [timeRange, priceStr] = p.split('=');
        if (!timeRange || !priceStr) continue;

        const [startStr, endStr] = timeRange.split('-');
        const price = parseFloat(priceStr);

        const startHour = parseInt(startStr.split(':')[0]) + parseInt(startStr.split(':')[1] || 0) / 60;
        let endHour = parseInt(endStr.split(':')[0]) + parseInt(endStr.split(':')[1] || 0) / 60;

        // 时间或价格解析失败的行整行跳过。尤其是价格：一个 NaN 价格乘进总价里，
        // 会把整个计费结果污染成 NaN，比"这一行没生效"糟糕得多。
        if (Number.isNaN(startHour) || Number.isNaN(endHour) || Number.isNaN(price)) continue;

        // start === end 是无效时段（不是"整整24小时"），直接跳过，避免误算成全天覆盖
        if (endHour === startHour) continue;

        if (endHour < startHour) {
            tariffs.push({ start: startHour, end: 24, price });
            tariffs.push({ start: 0, end: endHour, price });
        } else {
            tariffs.push({ start: startHour, end: endHour, price });
        }
    }
    return tariffs;
}

// 给定从 startHour 开始、持续 durationHours 的用电（功率恒定为 gridPowerKw），
// 按 tariffs 里的分时电价算出总花费。支持任意长度（包括跨越多个 24 小时周期）。
export function calculateCost(startHour, durationHours, gridPowerKw, tariffs) {
    if (!tariffs || tariffs.length === 0) return 0;

    let totalCost = 0;
    let remainingDuration = durationHours;
    let currentStart = startHour % 24;

    // 逐"天"推进：每一轮只处理到当天 24:00 为止，剩余的部分留到下一轮从 0:00 开始算
    while (remainingDuration > 0.0001) {
        const currentEnd = Math.min(currentStart + remainingDuration, 24);
        const stepDuration = currentEnd - currentStart;

        for (const t of tariffs) {
            const intersectStart = Math.max(currentStart, t.start);
            const intersectEnd = Math.min(currentEnd, t.end);

            if (intersectStart < intersectEnd) {
                const overlapHours = intersectEnd - intersectStart;
                totalCost += overlapHours * gridPowerKw * t.price;
            }
        }

        remainingDuration -= stepDuration;
        currentStart = 0;
    }

    return Number(totalCost.toFixed(2));
}
