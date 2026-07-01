import { calculateCharge } from './calculator.js';
import { DEFAULTS } from './config.js';

// 【修复】原来用 `parseInt(x) || 默认值` 会把合法的 0 (比如 00:00 整点) 当成"没传"而吃掉，
// 这里改成显式判断"缺失/非法"再回退默认值，0 会被正常保留。
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

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const searchParams = url.searchParams;

    const inputs = {
        start_percentage: parseFloatOr(searchParams.get("start"), 0),
        target_percentage: parseFloatOr(searchParams.get("target"), DEFAULTS.target_percentage),
        start_hour: parseIntOr(searchParams.get("start_hour"), 22),
        start_minute: parseIntOr(searchParams.get("start_minute"), 0),
        end_hour: parseIntOr(searchParams.get("end_hour"), 7),
        end_minute: parseIntOr(searchParams.get("end_minute"), 0),
        current_hour: parseIntOr(searchParams.get("current_hour"), 0),
        current_minute: parseIntOr(searchParams.get("current_minute"), 0),
        tariff_config: searchParams.get("tariff") || ""
    };

    if (!searchParams.has("start")) {
        return new Response(JSON.stringify({ error: "缺少 start 参数", error_code: "MISSING_START_PARAM" }), { status: 400 });
    }

    const result = calculateCharge(inputs);

    return new Response(JSON.stringify({ inputs, result }), {
        headers: { "Content-Type": "application/json;charset=UTF-8" }
    });
}
