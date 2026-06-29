import { DEFAULTS, CHARGING_MODELS } from './config.js';

// 解析时段电价字符串 (支持 22:00-08:00 这种跨天格式)
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

// 核心电费计算器 (按分钟切片跨越不同电价区间，高精度计算)
function calculateCost(startHour, durationHours, gridPowerKw, tariffs) {
    if (!tariffs || tariffs.length === 0) return 0;
    
    let totalCost = 0;
    let currentHour = startHour;
    let remainingHours = durationHours;
    
    const step = 1 / 60; 
    
    while (remainingHours > 0.001) {
        const timeOfDay = currentHour % 24;
        let currentPrice = 0;
        
        for (const t of tariffs) {
            if (t.start < t.end) {
                if (timeOfDay >= t.start && timeOfDay < t.end) currentPrice = t.price;
            } else {
                // 处理跨天区间
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
    const start_time_hours = params.start_hour + params.start_minute / 60;
    const end_time_hours = params.end_hour + params.end_minute / 60;
    
    let charging_duration = end_time_hours > start_time_hours 
        ? end_time_hours - start_time_hours 
        : (24 - start_time_hours) + end_time_hours;

    if (charging_duration <= 0) return { error: "错误：充电时间必须大于0" };

    const power_effective_max_kw = model.getEffectivePowerKw(params.max_current, params);
    const grid_power_max_kw = params.max_current * params.Vs / 1000;
    const max_charging_time_hours = energy_needed / power_effective_max_kw;

    const formatTime = (totalHours) => {
        let h = Math.floor(totalHours) % 24;
        if (h < 0) h += 24;
        let m = Math.round((totalHours - Math.floor(totalHours)) * 60);
        if (m === 60) { h = (h + 1) % 24; m = 0; }
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    if (max_charging_time_hours > charging_duration) {
        const energy_possible = power_effective_max_kw * charging_duration;
        const reachable_percentage = Math.min(100, params.start_percentage + (energy_possible / params.capacity) * 100);
        const extra_time_needed = max_charging_time_hours - charging_duration;

        const maxCost = calculateCost(start_time_hours, charging_duration, grid_power_max_kw, tariffs);
        const maxLossKw = (params.R * (params.max_current ** 2)) / 1000;

        return {
            error: "无法在设定时间内达成目标",
            reachable_percentage: Number(reachable_percentage.toFixed(1)),
            early_start_time: formatTime(start_time_hours - extra_time_needed),
            late_end_time: formatTime(end_time_hours + extra_time_needed),
            fallback_stats: {
                current: params.max_current,
                power_kw: Number(power_effective_max_kw.toFixed(2)),
                loss_percentage: Number(((maxLossKw / grid_power_max_kw) * 100).toFixed(2)),
                cost: maxCost,
                energy_added: Number(energy_possible.toFixed(2))
            }
        };
    }

    const optimal_current = model.calculateCurrent(energy_needed, charging_duration, params);
    if (optimal_current === null) return { error: "错误：无法计算" };

    const optimal_grid_power_kw = optimal_current * params.Vs / 1000;
    const current_power_effective_kw = model.getEffectivePowerKw(optimal_current, params);
    const power_loss_kw = (params.R * (optimal_current ** 2)) / 1000;
    
    const optimalCost = calculateCost(start_time_hours, charging_duration, optimal_grid_power_kw, tariffs);

    return {
        optimal_current: Number(optimal_current.toFixed(2)),
        charging_duration: Number(charging_duration.toFixed(2)),
        effective_power_kw: Number(current_power_effective_kw.toFixed(2)),
        loss_percentage: Number(((power_loss_kw / optimal_grid_power_kw) * 100).toFixed(2)),
        energy_added: Number(energy_needed.toFixed(2)),
        cost: optimalCost
    };
}
