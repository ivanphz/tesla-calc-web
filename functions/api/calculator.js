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
        if (timeOfDay < 0) timeOfDay += 24; // 处理负数时间（如倒退到前一天）
        
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

    let window_duration = end_time_hours - start_time_hours;
    if (window_duration <= 0) window_duration += 24;

    // === 核心逻辑：时空碰撞引擎 ===
    // 判断当前时间是否在预约的时段内
    let is_inside_window = false;
    if (start_time_hours < end_time_hours) {
        is_inside_window = current_time_hours >= start_time_hours && current_time_hours < end_time_hours;
    } else {
        is_inside_window = current_time_hours >= start_time_hours || current_time_hours < end_time_hours;
    }

    let effective_start_hours = start_time_hours;
    let available_duration = window_duration;
    let time_lost = false;

    // 如果选了"从现在开始" 或者 迟到了(当前在时段内)
    if (params.use_now || is_inside_window) {
        effective_start_hours = current_time_hours;
        let end_val = end_time_hours;
        if (end_val < current_time_hours) end_val += 24; 
        available_duration = end_val - current_time_hours;
        time_lost = true; 
    }

    const formatTime = (totalHours) => {
        let h = Math.floor(totalHours) % 24;
        if (h < 0) h += 24;
        let m = Math.round((totalHours - Math.floor(totalHours)) * 60);
        if (m === 60) { h = (h + 1) % 24; m = 0; }
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // === 充不满，需要给出智能方案 ===
    if (max_charging_time_hours > available_duration) {
        const energy_possible = power_effective_max_kw * available_duration;
        const reachable_percentage = Math.min(100, params.start_percentage + (energy_possible / params.capacity) * 100);
        const maxLossKw = (params.R * (params.max_current ** 2)) / 1000;
        const maxCost = calculateCost(effective_start_hours, available_duration, grid_power_max_kw, tariffs);
        
        const solutions = [];

        if (!time_lost) {
            // 场景 1：还没到预约时间，来得及提前
            let early_start = end_time_hours - max_charging_time_hours;
            solutions.push({
                type: '优选', color: 'var(--primary)',
                title: `提前至 ${formatTime(early_start)} 预约开始`,
                desc: `(到点自动断电。提前的时段已计入实时电价) 充满总费用：<strong style="color: #10b981;">¥${calculateCost(early_start, max_charging_time_hours, grid_power_max_kw, tariffs)}</strong>`
            });
            let late_end = effective_start_hours + max_charging_time_hours;
            solutions.push({
                type: '备选', color: '#6b7280',
                title: `延后至 ${formatTime(late_end)} 结束`,
                desc: `(保持预约时间不变，早晨不拔枪) 充满总费用：<strong style="color: #10b981;">¥${calculateCost(effective_start_hours, max_charging_time_hours, grid_power_max_kw, tariffs)}</strong>`
            });
        } else {
            // 场景 2：已经迟到 或 选了现在开始。时间不能倒流，只能往后顺延。
            let late_end = effective_start_hours + max_charging_time_hours;
            solutions.push({
                type: '唯一方案', color: 'var(--primary)',
                title: `持续满载充电至 ${formatTime(late_end)} 结束`,
                desc: `(当前时间无法提前，已包含后续跨越时段的电价) 充满总费用：<strong style="color: #10b981;">¥${calculateCost(effective_start_hours, max_charging_time_hours, grid_power_max_kw, tariffs)}</strong>`
            });
        }

        return {
            error: "无法在设定时间内达成目标",
            reachable_percentage: Number(reachable_percentage.toFixed(1)),
            solutions: solutions,
            fallback_stats: {
                current: params.max_current,
                power_kw: Number(power_effective_max_kw.toFixed(2)),
                loss_percentage: Number(((maxLossKw / grid_power_max_kw) * 100).toFixed(2)),
                cost: maxCost,
                energy_added: Number(energy_possible.toFixed(2))
            }
        };
    }

    // === 正常充得满的情况 ===
    const optimal_current = model.calculateCurrent(energy_needed, available_duration, params);
    if (optimal_current === null) return { error: "错误：无法计算" };

    const optimal_grid_power_kw = optimal_current * params.Vs / 1000;
    const current_power_effective_kw = model.getEffectivePowerKw(optimal_current, params);
    const power_loss_kw = (params.R * (optimal_current ** 2)) / 1000;
    const optimalCost = calculateCost(effective_start_hours, available_duration, optimal_grid_power_kw, tariffs);

    return {
        optimal_current: Number(optimal_current.toFixed(2)),
        charging_duration: Number(available_duration.toFixed(2)),
        effective_power_kw: Number(current_power_effective_kw.toFixed(2)),
        loss_percentage: Number(((power_loss_kw / optimal_grid_power_kw) * 100).toFixed(2)),
        energy_added: Number(energy_needed.toFixed(2)),
        cost: optimalCost
    };
}
