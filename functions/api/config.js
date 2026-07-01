export const DEFAULTS = {
    capacity: 78,
    max_current: 32,
    min_current: 5,  // 车机允许设置的最小电流底线
    R: 0.44,
    Vs: 224.2,
    phases: 1,       // 新增接口：单相电默认为 1。未来若换 380V 三相电桩，改为 3 即可
    target_percentage: 80,
    end_hour: 7,
    end_minute: 0,
    timezone: "Asia/Shanghai",
    
    // === 环境与车机耗电预留接口 ===
    env_factors: {
        sentry_mode_on: false,
        winter_heating_on: false,
        base_power_w: 0
    },
    
    // === 电池健康度预留接口 ===
    battery_health: {
        usable_capacity_ratio: 1.0 // 已按要求设为 100%，直接基于 78 度电纯粹计算
    }
};

export const CHARGING_MODELS = {
    // 当前阶段：最经济纯粹的二次方程恒流模型
    quadratic: {
        calculateCurrent(energyNeeded, duration, params) {
            const powerIdealW = (energyNeeded / duration) * 1000;
            const a = params.R;
            // 引入相数：三相电的总电压等效为单相乘以相数
            const b = -params.Vs * params.phases; 
            const c = powerIdealW;
            const delta = b * b - 4 * a * c;

            if (delta < 0) return null;

            const I1 = (-b + Math.sqrt(delta)) / (2 * a);
            const I2 = (-b - Math.sqrt(delta)) / (2 * a);
            
            const solutions = [I1, I2].filter(i => i > 0);
            if (solutions.length === 0) return null;
            
            let optimal = Math.min(...solutions);
            
            // 【核心修改点】：在此处做上下限兜底
            optimal = Math.max(optimal, params.min_current); // 兜底 5A
            return optimal > params.max_current ? params.max_current : optimal; // 兜底 32A
        },
        getEffectivePowerKw(current, params) {
            // 引入相数：总进电功率和总发热线损都乘以 phases
            const gridPower = params.Vs * current * params.phases;
            const powerLoss = params.R * (current ** 2) * params.phases;
            const effective = gridPower - powerLoss - (params.env_factors ? params.env_factors.base_power_w : 0);
            return effective / 1000;
        }
    },
    
    // 未来阶段：处理涓流、动态压降与电池衰减的复杂非线性模型
    advanced_non_linear: {
        calculateCurrent(startSoc, targetSoc, duration, params) {
            throw new Error("Not implemented yet");
        },
        getEffectivePowerKw(current, currentSoc, params) {
            throw new Error("Not implemented yet");
        }
    }
};
