import { calculateCharge } from './calculator.js';
import { DEFAULTS } from './config.js';

// GET /api/charge：把 URL 查询参数解析成 calculateCharge 需要的输入，调用后把 {inputs, result} 返回。
// 无论成功还是失败，返回的都是同一个信封结构 {inputs, result}，错误信息永远在 result.error / result.error_code 里
// —— 调用方（网页前端、iOS 捷径等）只需要解析一种结构。

// 用 parseIntOr/parseFloatOr 而不是 `parseInt(x) || 默认值`，是因为 `||` 会把合法的 0（比如 00:00 整点）
// 当成"没传"而吃掉，这里显式判断"缺失/非法"再回退默认值，0 会被正常保留。
function parseIntOr(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
}
function parseFloatOr(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = parseFloat(value);
    return Number.isNaN(n) ? fallback : n;
}

// 按 DEFAULTS.timezone 取服务器端的"现在几点"。
// 只在请求没显式传 current_hour/current_minute 时兜底用：原来的兜底是静默落到 00:00，
// 而凌晨 0 点恰好在默认的 22:00-07:00 时段内，会让"在不在时段内/来不来得及"的判断整个错位。
// 网页前端总是显式传（要支持沙盒时间），这个兜底是给直连 API 的调用方（iOS 捷径等）准备的。
function getServerNow(timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
    return { hour: get('hour'), minute: get('minute') };
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json;charset=UTF-8" }
    });
}

export async function onRequest(context) {
    const { request } = context;
    const searchParams = new URL(request.url).searchParams;

    // start 是唯一必填参数：缺失或不是数字都直接拒绝，不做静默兜底
    const startRaw = searchParams.get("start");
    if (startRaw === null || startRaw === '' || Number.isNaN(parseFloat(startRaw))) {
        return jsonResponse({
            inputs: null,
            result: { error: "缺少或非法的 start 参数", error_code: "MISSING_START_PARAM" }
        }, 400);
    }

    const hasCurrent = searchParams.has("current_hour") || searchParams.has("current_minute");
    const serverNow = hasCurrent ? null : getServerNow(DEFAULTS.timezone);

    // 手动微调电流（可选）：传了就按这个电流算，不传则求解最优。非法值明确拒绝，不静默忽略。
    const forcedRaw = searchParams.get("forced_current");
    let forced_current = null;
    if (forcedRaw !== null && forcedRaw !== '') {
        forced_current = parseFloat(forcedRaw);
        if (Number.isNaN(forced_current)) {
            return jsonResponse({
                inputs: null,
                result: { error: "非法的 forced_current 参数", error_code: "CURRENT_OUT_OF_RANGE" }
            }, 400);
        }
    }

    const inputs = {
        start_percentage: parseFloat(startRaw),
        target_percentage: parseFloatOr(searchParams.get("target"), DEFAULTS.target_percentage),
        start_hour: parseIntOr(searchParams.get("start_hour"), DEFAULTS.start_hour),
        start_minute: parseIntOr(searchParams.get("start_minute"), DEFAULTS.start_minute),
        end_hour: parseIntOr(searchParams.get("end_hour"), DEFAULTS.end_hour),
        end_minute: parseIntOr(searchParams.get("end_minute"), DEFAULTS.end_minute),
        current_hour: serverNow ? serverNow.hour : parseIntOr(searchParams.get("current_hour"), 0),
        current_minute: serverNow ? serverNow.minute : parseIntOr(searchParams.get("current_minute"), 0),
        // ?? 而不是 ||：不传参数(null)时用 config.js 的默认电价；显式传空串则保留"不计费"的语义
        tariff_config: searchParams.get("tariff") ?? DEFAULTS.tariff_config,
        forced_current
    };

    const result = calculateCharge(inputs);

    // inputs 原样回显：调用方能看到服务器实际采用的参数（包括兜底出来的"现在几点"）
    return jsonResponse({ inputs, result });
}
