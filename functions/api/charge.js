import { calculateCharge } from './calculator.js';
import { DEFAULTS } from './config.js';

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const searchParams = url.searchParams;

    const inputs = {
        start_percentage: parseFloat(searchParams.get("start")) || 0,
        target_percentage: parseFloat(searchParams.get("target")) || DEFAULTS.target_percentage,
        start_hour: parseInt(searchParams.get("start_hour"), 10) || 22,
        start_minute: parseInt(searchParams.get("start_minute"), 10) || 0,
        end_hour: parseInt(searchParams.get("end_hour"), 10) || 7,
        end_minute: parseInt(searchParams.get("end_minute"), 10) || 0,
        current_hour: parseInt(searchParams.get("current_hour"), 10) || 0,
        current_minute: parseInt(searchParams.get("current_minute"), 10) || 0,
        use_now: searchParams.get("use_now") === "true",
        tariff_config: searchParams.get("tariff") || ""
    };

    if (!searchParams.has("start")) {
        return new Response(JSON.stringify({ error: "缺少 start 参数" }), { status: 400 });
    }

    const result = calculateCharge(inputs);

    return new Response(JSON.stringify({ inputs, result }), {
        headers: { "Content-Type": "application/json;charset=UTF-8" }
    });
}
