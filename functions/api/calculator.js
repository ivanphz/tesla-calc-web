import { DEFAULTS, CHARGING_MODELS } from './config.js';

function parseTariffs(tariffStr) {
    if (!tariffStr) return [];
    const tariffs = [];
    const periods = tariffStr.replace(/\n/g, ',').split(',');
    
    for (const p of periods) {
        if (!p.trim()) continue;
        const [timeRange, priceStr] = p.split('=');
        if (!timeRange || !priceStr) continue;
        
        const [startStr, endStr] = timeRange.split('-');
        const price = parseFloat(priceStr);
        
        const startHour = parseInt(startStr.split(':')[0]) + parseInt(startStr.split(':')[1]||0)/60;
        let endHour = parseInt(endStr.split(':')[0]) + parseInt(endStr.split(':')[1]||0)/60;
        
        // 【修复】start===end 是无效时段（不是"整整24小时"），直接跳过，避免误算成全天覆盖
        if (endHour === startHour) continue;
        
        // 核心修改：将跨天的时段物理拆分为当天的两个独立区间，抹平跨天计算的心智负担
        if (endHour < startHour) {
            tariffs.push({ start: startHour, end: 24, price: price });
            tariffs.push({ start: 0, end: endHour, price: price });
        } else {
            tariffs.push({ start: startHour, end: endHour, price: price });
        }
    }
    return tariffs;
}

function calculateCost(startHour, durationHours, gridPowerKw, tariffs) {
    if (!tariffs || tariffs.length === 0) return 0;
    
    let totalCost = 0;
    let remainingDuration = durationHours;
    let currentStart = startHour % 24; 
    
    // 处理单次充电时间极长，可能跨越多个 24 小时周期的情况
    while (remainingDuration > 0.0001) { 
        // 划定当前这“一天”内的计算窗口，最长算到 24:00
        const currentEnd = Math.min(currentStart + remainingDuration, 24);
        const stepDuration = currentEnd - currentStart;
        
        // 遍历所有当天电价区间，求线段交集
        for (const t of tariffs) {
            const intersectStart = Math.max(currentStart, t.start);
            const intersectEnd = Math.min(currentEnd, t.end);
            
            if (intersectStart < intersectEnd) {
                const overlapHours = intersectEnd - intersectStart;
                totalCost += overlapHours * gridPowerKw * t.price;
            }
        }
        
        remainingDuration -= stepDuration;
        currentStart = 0; // 如果还有剩余时长，说明跨入了第二天，第二天从 00:00 开始算
    }
    
    return Number(totalCost.toFixed(2));
}

const formatTime = (totalHours) => {
    // 转换为纯整数分钟进行运算，规避所有浮点数残留和进位缺失
    let totalMinutes = Math.round(totalHours * 60);
    // 抹平负数跨天和超长跨天的模运算
    totalMinutes = ((totalMinutes % 1440) + 1440) % 1440;
    
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const formatDuration = (hours) => {
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return h > 0 ? `${h}小时${m}分` : `${m}分`;
};

export function calculateCharge(inputs) {
    const params = {
        ...DEFAULTS,
        ...inputs,
        // 【修复】env_factors/battery_health 不能直接被 inputs 里的同名字段整体覆盖(浅合并)，
        // 否则以后只传部分字段(比如只传 sentry_mode_on)，缺的字段(比如 base_power_w)会变成 undefined，级联出 NaN。
        env_factors: { ...DEFAULTS.env_factors, ...(inputs.env_factors || {}) },
        battery_health: { ...DEFAULTS.battery_health, ...(inputs.battery_health || {}) }
    };
    // 预留接口：以后要切换到更复杂的算法模型，只需要传 model_name，这里不用改
    const model = CHARGING_MODELS[params.model_name] || CHARGING_MODELS.quadratic;
    const tariffs = parseTariffs(params.tariff_config);

    // 【修复】补回原 Python 脚本里就有、网页版丢掉的边界校验
    if (params.start_percentage < 0 || params.start_percentage > 100 || params.target_percentage < 0 || params.target_percentage > 100) {
        return { error: "错误：电量百分比必须在0-100之间", error_code: "PERCENTAGE_OUT_OF_RANGE" };
    }

    if (params.start_percentage >= params.target_percentage) {
        return { error: "错误：目标电量必须大于起始电量", error_code: "START_GTE_TARGET" };
    }

    const energy_needed = params.capacity * (params.target_percentage - params.start_percentage) / 100;
    const power_effective_max_kw = model.getEffectivePowerKw(params.max_current, params);
    const grid_power_max_kw = params.max_current * params.Vs * params.phases / 1000; // 【修复】漏乘了 phases
    const max_charging_time_hours = energy_needed / power_effective_max_kw;

    const start_time_hours = params.start_hour + params.start_minute / 60;
    const end_time_hours = params.end_hour + params.end_minute / 60;
    const current_time_hours = params.current_hour + params.current_minute / 60;

    // 【修复】开始和结束时间相同是非法输入(不是"整整24小时")，直接拒绝，而不是静默按24小时窗口计算
    if (start_time_hours === end_time_hours) {
        return { error: "错误：充电开始和结束时间不能相同", error_code: "INVALID_TIME_WINDOW" };
    }

    let standard_window = end_time_hours - start_time_hours;
    if (standard_window <= 0) standard_window += 24;

    let now_to_end = end_time_hours - current_time_hours;
    if (now_to_end <= 0) now_to_end += 24;

    // === 核心逻辑：时空碰撞引擎 ===
    if (max_charging_time_hours > standard_window || max_charging_time_hours > now_to_end) {
        const solutions = [];
        let fallback_stats = null;

        if (now_to_end >= max_charging_time_hours) {
            let early_start = end_time_hours - max_charging_time_hours;
            if (early_start < 0) early_start += 24;

            let cost_early = calculateCost(early_start, max_charging_time_hours, grid_power_max_kw, tariffs);
            let cost_late = calculateCost(start_time_hours, max_charging_time_hours, grid_power_max_kw, tariffs);
            let late_end = start_time_hours + max_charging_time_hours;

            // 电价表已经加载了，"提前/延后的这部分到底贵不贵"不是一件说不准的事，直接算出来展示金额，
            // 不再用"不一定是谷电价"这种含糊的措辞。
            // 提前的这段、延后的这段，本质上是同一个"多出来的时长"（只是被安排在标准时段的两侧），
            // 用 max_charging_time_hours - standard_window 统一计算，不用再分别对着 early_start/late_end 减来减去——
            // 减法容易在时段跨天(比如 22:00-07:00)时把"今天的这个点"和"明天的这个点"搞混，用这个差值就完全绕开了这个坑。
            const extra_segment_hours = max_charging_time_hours - standard_window;
            const early_segment_cost = calculateCost(early_start, extra_segment_hours, grid_power_max_kw, tariffs);
            const late_segment_cost = calculateCost(end_time_hours, extra_segment_hours, grid_power_max_kw, tariffs);

            solutions.push({
                type: '优选', color: 'var(--primary)',
                title: `提前至 ${formatTime(early_start)} 预约开始`,
                desc: `(比标准开始时间提前 ${formatDuration(extra_segment_hours)}，这部分预计花费 ¥${early_segment_cost}) 充满预估：<strong style="color: #10b981;">¥${cost_early}</strong>`
            });

            // "死守 start_time_hours 开始"里的这个时刻，指的是它"下一次出现"的那个点：
            // 今天还没到就是今天这个点，今天已经过了就是明天同一时刻——这是有意为之的设计。
            solutions.push({
                type: '备选', color: '#6b7280',
                title: `死守 ${formatTime(start_time_hours)} 开始，延后至 ${formatTime(late_end)} 结束`,
                desc: `(比标准结束时间延后 ${formatDuration(extra_segment_hours)}，这部分预计花费 ¥${late_segment_cost}) 充满预估：<strong style="color: #10b981;">¥${cost_late}</strong>`
            });

            const energy_in_window = power_effective_max_kw * standard_window;
            fallback_stats = {
                label: `💡 若坚守 ${formatTime(start_time_hours)}-${formatTime(end_time_hours)} 不提前不延后:`,
                percent: Math.min(100, params.start_percentage + (energy_in_window / params.capacity) * 100),
                energy: energy_in_window,
                cost: calculateCost(start_time_hours, standard_window, grid_power_max_kw, tariffs)
            };
        } else {
            const energy_now_to_end = power_effective_max_kw * now_to_end;
            const percent_at_end = Math.min(100, params.start_percentage + (energy_now_to_end / params.capacity) * 100);
            const cost_to_end = calculateCost(current_time_hours, now_to_end, grid_power_max_kw, tariffs);
            
            const total_cost = calculateCost(current_time_hours, max_charging_time_hours, grid_power_max_kw, tariffs);
            const late_end = current_time_hours + max_charging_time_hours;
            const extra_hours = max_charging_time_hours - now_to_end;

            fallback_stats = {
                label: `💡 妥协：现在立刻开充，到 ${formatTime(end_time_hours)} 准时拔枪:`,
                percent: percent_at_end,
                energy: energy_now_to_end,
                cost: cost_to_end
            };

            solutions.push({
                type: '强迫症必选', color: '#f59e0b',
                title: `现在立刻开充，延后至 ${formatTime(late_end)} 结束`,
                desc: `(必须突破时段限制，额外多充 <strong style="color: #dc2626;">${formatDuration(extra_hours)}</strong> 才能充满) 总预估：<strong style="color: #10b981;">¥${total_cost}</strong>`
            });
        }

        return {
            error: "需要用户介入决策",
            error_code: "UNREACHABLE_IN_WINDOW",
            solutions: solutions,
            fallback_stats: fallback_stats
        };
    }

    // === 正常充得满的情况 ===
    let is_inside_window = false;
    if (start_time_hours < end_time_hours) {
        is_inside_window = (current_time_hours >= start_time_hours && current_time_hours < end_time_hours);
    } else {
        is_inside_window = (current_time_hours >= start_time_hours || current_time_hours < end_time_hours);
    }

    let effective_start_hours = start_time_hours;
    let available_duration = standard_window; 

    if (is_inside_window) {
        effective_start_hours = current_time_hours;
        available_duration = now_to_end; 
    }

    const optimal_current = model.calculateCurrent(energy_needed, available_duration, params);
    if (optimal_current === null) return { error: "错误：无法计算", error_code: "SOLVE_FAILED" };

    const current_power_effective_kw = model.getEffectivePowerKw(optimal_current, params);
    
    // 【核心修改点】：如果触发了 5A 底线，会导致充电提前结束，必须重新推算实际耗时
    let actual_duration = available_duration;
    if (optimal_current === params.min_current) {
        actual_duration = energy_needed / current_power_effective_kw;
    }

    // 引入三相电相数因子
    const optimal_grid_power_kw = (optimal_current * params.Vs * params.phases) / 1000;
    const power_loss_kw = (params.R * (optimal_current ** 2) * params.phases) / 1000;
    
    // 计费时，严格使用重算后的 actual_duration，避免 5A 场景下电费虚高
    const optimalCost = calculateCost(effective_start_hours, actual_duration, optimal_grid_power_kw, tariffs);

    return {
        optimal_current: Number(optimal_current.toFixed(2)),
        charging_duration: Number(actual_duration.toFixed(2)),
        effective_power_kw: Number(current_power_effective_kw.toFixed(2)),
        loss_percentage: Number(((power_loss_kw / optimal_grid_power_kw) * 100).toFixed(2)),
        energy_added: Number(energy_needed.toFixed(2)),
        cost: optimalCost
    };
}
