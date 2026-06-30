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
        if (endHour === 0 && startHour > 0) endHour = 24; 
        
        tariffs.push({ start: startHour, end: endHour, price: price });
    }
    return tariffs;
}

function calculateCost(startHour, durationHours, gridPowerKw, tariffs) {
    if (!tariffs || tariffs.length === 0) return 0;
    
    let totalCost = 0;
    let currentHour = startHour;
    let remainingHours = durationHours;
    const step = 1 / 60; 
    
    while (remainingHours > 0.001) {
        let timeOfDay = currentHour % 24;
        if (timeOfDay < 0) timeOfDay += 24; 
        
        let currentPrice = 0;
        for (const t of tariffs) {
            if (t.start < t.end) {
                if (timeOfDay >= t.start && timeOfDay < t.end) currentPrice = t.price;
            } else {
                if (timeOfDay >= t.start || timeOfDay < t.end) currentPrice = t.price;
            }
        }
        
        const calcStep = Math.min(step, remainingHours);
        const energyInStep = gridPowerKw * calcStep;
        totalCost += energyInStep * currentPrice;
        
        currentHour += calcStep;
        remainingHours -= calcStep;
    }
    
    return Number(totalCost.toFixed(2));
}

const formatTime = (totalHours) => {
    let h = Math.floor(totalHours) % 24;
    if (h < 0) h += 24;
    let m = Math.round((totalHours - Math.floor(totalHours)) * 60);
    if (m === 60) { h = (h + 1) % 24; m = 0; }
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
            // 场景 1：时间充裕，还没到倒推的最佳启动时间
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
            // 场景 2：已经迟到（或者时间根本不够用）
            const energy_now_to_end = power_effective_max_kw * now_to_end;
            const percent_at_end = Math.min(100, params.start_percentage + (energy_now_to_end / params.capacity) * 100);
            const cost_to_end = calculateCost(current_time_hours, now_to_end, grid_power_max_kw, tariffs);
            
            const total_cost = calculateCost(current_time_hours, max_charging_time_hours, grid_power_max_kw, tariffs);
            const late_end = current_time_hours + max_charging_time_hours;
            
            let extra_hours = max_charging_time_hours - now_to_end;
            let extra_h = Math.floor(extra_hours);
            let extra_m = Math.round((extra_hours - extra_h) * 60);
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
    const optimal_current = model.calculateCurrent(energy_needed, available_duration, params);
    if (optimal_current === null) return { error: "错误：无法计算" };

    const optimal_grid_power_kw = optimal_current * params.Vs / 1000;
    const current_power_effective_kw = model.getEffectivePowerKw(optimal_current, params);
    
    // 【修正核心点】根据降流后的真实有效功率，重新计算实际所需的充电时长
    const actual_charging_duration = energy_needed / current_power_effective_kw;
    
    const power_loss_kw = (params.R * (optimal_current ** 2)) / 1000;
    
    // 用真实的充电时长，计算真实的电费
    const optimalCost = calculateCost(effective_start_hours, actual_charging_duration, optimal_grid_power_kw, tariffs);

    return {
        optimal_current: Number(optimal_current.toFixed(2)),
        charging_duration: Number(actual_charging_duration.toFixed(2)), // 更新为被拉长的真实时长
        effective_power_kw: Number(current_power_effective_kw.toFixed(2)),
        loss_percentage: Number(((power_loss_kw / optimal_grid_power_kw) * 100).toFixed(2)),
        energy_added: Number(energy_needed.toFixed(2)),
        cost: optimalCost
    };
}
