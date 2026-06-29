// ❌ 删掉这行：const SECRET_TOKEN = "your_secure_token_here"; 

export async function onRequest(context) {
    const { request, env } = context;

    // 1. 处理来自服务器的 POST 推送请求 (写入 KV)
    if (request.method === "POST") {
        try {
            const data = await request.json();
            
            // ✅ 修改这里：改为从 env.SECRET_TOKEN 读取环境变量中的密钥
            if (data.token !== env.SECRET_TOKEN) {
                return new Response("Unauthorized", { status: 401 });
            }
            
            // 校验电量数值有效性
            if (typeof data.battery === "number" && data.battery >= 0 && data.battery <= 100) {
                // 将电量写入绑定的 KV 数据库
                await env.TESLA_KV.put("current_battery", data.battery.toString());
                return new Response(JSON.stringify({ success: true, battery: data.battery }), {
                    headers: { "Content-Type": "application/json" }
                });
            }
            return new Response("Invalid battery data", { status: 400 });
        } catch (e) {
            return new Response("Bad Request", { status: 400 });
        }
    }
    
    // 2. 处理前端网页的 GET 请求 (读取 KV)
    if (request.method === "GET") {
        const battery = await env.TESLA_KV.get("current_battery");
        return new Response(JSON.stringify({ battery: battery ? parseInt(battery) : null }), {
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*" // 允许前端直接访问
            }
        });
    }

    return new Response("Method not allowed", { status: 405 });
}
