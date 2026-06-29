import { DEFAULTS, CHARGING_MODELS } from './config.js';

export function calculateCharge(inputs) {
    const params = { ...DEFAULTS, ...inputs };
    const model = CHARGING_MODELS.quadratic;

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
    const max_charging_time_hours = energy_needed / power_effective_max_kw;

    if (max_charging_time_hours > charging_duration) {
        const energy_possible = power_effective_max_kw * charging_duration;
        const reachable_percentage = Math.min(100, params.start_percentage + (energy_possible / params.capacity) * 100);
        const extra_time_needed = max_charging_time_hours - charging_duration;

        // 计算推迟/提前的时间 HH:MM 格式
        const formatTime = (totalHours) => {
            let h = Math.floor(totalHours) % 24;
            if (h < 0) h += 24;
            let m = Math.round((totalHours - Math.floor(totalHours)) * 60);
            if (m === 60) { h = (h + 1) % 24; m = 0; }
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };

        const earlyStartHours = start_time_hours - extra_time_needed;
        const lateEndHours = end_time_hours + extra_time_needed;

        return {
            error: "无法在指定时间内达到目标电量",
            reachable_percentage,
            early_start_time: formatTime(earlyStartHours),
            late_end_time: formatTime(lateEndHours)
        };
    }

    const optimal_current = model.calculateCurrent(energy_needed, charging_duration, params);
    if (optimal_current === null) {
        return { error: "错误：无法计算" };
    }

    const current_power_effective_kw = model.getEffectivePowerKw(optimal_current, params);
    const power_loss_kw = (params.R * (optimal_current ** 2)) / 1000;

    return {
        optimal_current: Number(optimal_current.toFixed(2)),
        charging_duration: Number(charging_duration.toFixed(2)),
        effective_power_kw: Number(current_power_effective_kw.toFixed(2)),
        loss_percentage: Number(((power_loss_kw / (current_power_effective_kw + power_loss_kw)) * 100).toFixed(2))
    };
}
