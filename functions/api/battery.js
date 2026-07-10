// 写入/读取车机状态到 KV。POST 由外部程序(比如 Node-RED)推送，GET 给前端页面拉取。
// SECRET_TOKEN 从 Cloudflare 的环境变量/密钥里读取，不写死在代码里。

export async function onRequest(context) {
    const { request, env } = context;

    // 1. 处理来自外部程序的 POST 推送请求 (写入 KV)
    if (request.method === "POST") {
        try {
            const data = await request.json();

            // SECRET_TOKEN 未配置时 env.SECRET_TOKEN 是 undefined，若请求也不带 token，
            // 两边都是 undefined 会被判定"相等"——所以这里显式要求密钥必须已配置，否则一律拒绝。
            if (!env.SECRET_TOKEN || data.token !== env.SECRET_TOKEN) {
                return new Response("Unauthorized", { status: 401 });
            }

            // battery 和 charge_limit 各自独立、都是可选的，哪个字段有效就写哪个 KV key，
            // 这样只推 battery 的旧流程不用改，以后再单独推 charge_limit 也不影响 battery。
            const result = {};
            let wroteAny = false;

            if (typeof data.battery === "number" && data.battery >= 0 && data.battery <= 100) {
                await env.TESLA_KV.put("current_battery", data.battery.toString());
                result.battery = data.battery;
                wroteAny = true;
            }

            if (typeof data.charge_limit === "number" && data.charge_limit >= 0 && data.charge_limit <= 100) {
                await env.TESLA_KV.put("target_charge_limit", data.charge_limit.toString());
                result.charge_limit = data.charge_limit;
                wroteAny = true;
            }

            if (wroteAny) {
                return new Response(JSON.stringify({ success: true, ...result }), {
                    headers: { "Content-Type": "application/json" }
                });
            }
            return new Response("Invalid data: need a valid 'battery' and/or 'charge_limit' (0-100)", { status: 400 });
        } catch (e) {
            return new Response("Bad Request", { status: 400 });
        }
    }
    
    // 2. 处理前端网页的 GET 请求 (读取 KV)
    // 注意：GET 不做鉴权，知道 URL 的任何人都能读到电量/目标电量这两个数值。
    // 前端和这个 API 在同一个 Pages 项目下（同源），所以不需要也不设置 CORS 头——
    // 不主动邀请其它网站的页面跨域来读。若以后在意 GET 的公开可读性，可以参照 POST 加 token。
    if (request.method === "GET") {
        const [battery, chargeLimit] = await Promise.all([
            env.TESLA_KV.get("current_battery"),
            env.TESLA_KV.get("target_charge_limit")
        ]);
        return new Response(JSON.stringify({
            battery: battery ? parseInt(battery) : null,
            charge_limit: chargeLimit ? parseInt(chargeLimit) : null
        }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    return new Response("Method not allowed", { status: 405 });
}
