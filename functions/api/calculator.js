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
        
        // 核心修改：将跨天的时段物理拆分为当天的两个独立区间，抹平跨天计算的心智负担
        if (endHour <= startHour) {
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

export function calculateCharge(inputs) {
    const params = { ...DEFAULTS, ...inputs };
    const model = CHARGING_MODELS.quadratic;
    const tariffs = parseTariffs(params.tariff_config);

    if (params.start_percentage >= params.target_percentage) {
        return { error: "错误：目标电量必须大于起始电量" };
    }

    const energy_needed = params.capacity * (params.target_percentage - params.start_percentage) / 100;
    const power_effective_max_kw = model.getEffectivePowerKw(params.max_current, params);
    const grid_power_max_kw = params.max_current * params.Vs / 1000;
    const max_charging_time_hours = energy_needed / power_effective_max_kw;

    const start_time_hours = params.start_hour + params.start_minute / 60;
    const end_time_hours = params.end_hour + params.end_minute / 60;
    const current_time_hours = params.current_hour + params.current_minute / 60;

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

            solutions.push({
                type: '优选', color: 'var(--primary)',
                title: `提前至 ${formatTime(early_start)} 预约开始`,
                desc: `(利用倒推，明早 ${formatTime(end_time_hours)} 准时断电) 充满预估：<strong style="color: #10b981;">¥${cost_early}</strong>`
            });
            solutions.push({
                type: '备选', color: '#6b7280',
                title: `死守 ${formatTime(start_time_hours)} 开始，延后至 ${formatTime(late_end)} 结束`,
                desc: `(占用早晨峰电) 充满预估：<strong style="color: #10b981;">¥${cost_late}</strong>`
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
            
            // 修复的时空碰撞进位 Bug
            let extra_hours = max_charging_time_hours - now_to_end;
            let extra_total_minutes = Math.round(extra_hours * 60);
            let extra_h = Math.floor(extra_total_minutes / 60);
            let extra_m = extra_total_minutes % 60;
            let extra_str = extra_h > 0 ? `${extra_h}小时${extra_m}分` : `${extra_m}分`;

            fallback_stats = {
                label: `💡 妥协：现在立刻开充，到明早 ${formatTime(end_time_hours)} 准时拔枪:`,
                percent: percent_at_end,
                energy: energy_now_to_end,
                cost: cost_to_end
            };

            solutions.push({
                type: '强迫症必选', color: '#f59e0b',
                title: `现在立刻开充，延后至 ${formatTime(late_end)} 结束`,
                desc: `(必须突破时段限制，额外多充 <strong style="color: #dc2626;">${extra_str}</strong> 才能充满) 总预估：<strong style="color: #10b981;">¥${total_cost}</strong>`
            });
        }

        return {
            error: "需要用户介入决策",
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
    if (optimal_current === null) return { error: "错误：无法计算" };

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
