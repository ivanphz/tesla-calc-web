import { calculateCharge } from './calculator.js';
import { DEFAULTS } from './config.js';

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const searchParams = url.searchParams;

    const useNow = searchParams.get("use_now") === "true";
    let start_hour = 22; 
    let start_minute = 0;

    if (useNow) {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: DEFAULTS.timezone,
            hour: "numeric", minute: "numeric", hour12: false
        });
        const parts = formatter.formatToParts(new Date());
        start_hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
        start_minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    } else {
        start_hour = searchParams.has("start_hour") ? parseInt(searchParams.get("start_hour"), 10) : 22;
        start_minute = searchParams.has("start_minute") ? parseInt(searchParams.get("start_minute"), 10) : 0;
    }

    const inputs = {
        start_percentage: parseFloat(searchParams.get("start")) || 0,
        target_percentage: parseFloat(searchParams.get("target")) || DEFAULTS.target_percentage,
        start_hour: start_hour,
        start_minute: start_minute,
        end_hour: searchParams.has("end_hour") ? parseInt(searchParams.get("end_hour"), 10) : DEFAULTS.end_hour,
        end_minute: searchParams.has("end_minute") ? parseInt(searchParams.get("end_minute"), 10) : DEFAULTS.end_minute,
        
        current_hour: parseInt(searchParams.get("current_hour") || 0, 10),     // 新增
        current_minute: parseInt(searchParams.get("current_minute") || 0, 10), // 新增
        
        tariff_config: searchParams.get("tariff") || ""
    };

    if (!searchParams.has("start")) {
        return new Response(JSON.stringify({ error: "缺少 start 参数" }), { status: 400 });
    }

    const result = calculateCharge(inputs);

    return new Response(JSON.stringify({ inputs, result }), {
        headers: { 
            "Content-Type": "application/json;charset=UTF-8"
        }
    });
}
