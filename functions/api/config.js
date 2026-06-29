export const DEFAULTS = {
    capacity: 78,
    max_current: 32,
    R: 0.44,
    Vs: 224.2,
    target_percentage: 80,
    end_hour: 7,
    end_minute: 0,
    timezone: "Asia/Shanghai"
};

export const CHARGING_MODELS = {
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
            const powerMax = params.Vs * current - params.R * (current ** 2);
            const powerLoss = params.R * (current ** 2);
            return (powerMax - powerLoss) / 1000;
        }
    }
};
