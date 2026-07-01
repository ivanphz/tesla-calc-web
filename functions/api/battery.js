// ❌ 删掉这行：const SECRET_TOKEN = "your_secure_token_here"; 

export async function onRequest(context) {
    const { request, env } = context;

    // 1. 处理来自服务器的 POST 推送请求 (写入 KV)
    if (request.method === "POST") {
        try {
            const data = await request.json();
            
            // ✅ 修改这里：改为从 env.SECRET_TOKEN 读取环境变量中的密钥
            // 【修复】原来 data.token !== env.SECRET_TOKEN 在 SECRET_TOKEN 没配置时 (两边都是 undefined) 会判定为"相等"，
            // 鉴权直接被跳过。这里显式要求密钥必须已配置，否则一律拒绝。
            if (!env.SECRET_TOKEN || data.token !== env.SECRET_TOKEN) {
                return new Response("Unauthorized", { status: 401 });
            }

            // 【新增】battery 和 charge_limit 各自独立、都是可选的，哪个字段有效就写哪个，
            // 这样你现有只推 battery 的 node-red 流程完全不用改，以后另开一个流程单独推 charge_limit 也行。
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
    if (request.method === "GET") {
        const [battery, chargeLimit] = await Promise.all([
            env.TESLA_KV.get("current_battery"),
            env.TESLA_KV.get("target_charge_limit")
        ]);
        return new Response(JSON.stringify({
            battery: battery ? parseInt(battery) : null,
            charge_limit: chargeLimit ? parseInt(chargeLimit) : null
        }), {
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*" // 允许前端直接访问
            }
        });
    }

    return new Response("Method not allowed", { status: 405 });
}
