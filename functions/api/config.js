// 替换 config.js 的全部内容
export const DEFAULTS = {
    capacity: 78,
    max_current: 32,
    R: 0.44,
    Vs: 224.2,
    target_percentage: 80,
    end_hour: 7,
    end_minute: 0,
    timezone: "Asia/Shanghai",
    
    // === 新增：环境与车机耗电预留接口 ===
    env_factors: {
        sentry_mode_on: false,      // 未来留给面板的哨兵开关
        winter_heating_on: false,   // 冬季极寒加热开关
        base_power_w: 0             // 基础唤醒功耗 (后续可根据真实数据反推赋值)
    },
    
    // === 新增：电池健康度预留接口 ===
    battery_health: {
        usable_capacity_ratio: 0.955 // 藏电比例，用于修正真实充入电量
    }
};

export const CHARGING_MODELS = {
    // 当前阶段：最经济纯粹的二次方程恒流模型
    quadratic: {
        calculateCurrent(energyNeeded, duration, params) {
            const powerIdealW = (energyNeeded / duration) * 1000;
            const a = params.R;
            const b = -params.Vs;
            const c = powerIdealW;
            const delta = b * b - 4 * a * c;

            if (delta < 0) return null;

            const I1 = (-b + Math.sqrt(delta)) / (2 * a);
            const I2 = (-b - Math.sqrt(delta)) / (2 * a);
            
            const solutions = [I1, I2].filter(i => i > 0);
            if (solutions.length === 0) return null;
            
            let optimal = Math.min(...solutions);
            return optimal > params.max_current ? params.max_current : optimal;
        },
        getEffectivePowerKw(current, params) {
            const gridPower = params.Vs * current;
            const powerLoss = params.R * (current ** 2);
            // 预留了减去车机基础功耗的计算位
            const effective = gridPower - powerLoss - (params.env_factors ? params.env_factors.base_power_w : 0);
            return effective / 1000;
        }
    },
    
    // 未来阶段：处理涓流、动态压降与电池衰减的复杂非线性模型
    advanced_non_linear: {
        calculateCurrent(startSoc, targetSoc, duration, params) {
            // TODO: 等待导入真实历次充电数据后，拟合 >95% 的涓流降速曲线
            throw new Error("Not implemented yet");
        },
        getEffectivePowerKw(current, currentSoc, params) {
            // TODO: 根据不同 SOC 阶段返回不同的实际功率
            throw new Error("Not implemented yet");
        }
    }
};
