export const DEFAULTS = {
    capacity: 78,
    max_current: 32,
    min_current: 5,  // 车机允许设置的最小电流底线
    R: 0.44,
    Vs: 224.2,
    phases: 1,       // 新增接口：单相电默认为 1。未来若换 380V 三相电桩，改为 3 即可
    model_name: 'quadratic', // 预留接口：未来上线 advanced_non_linear 等模型时，切这个字段即可，calculateCharge 不用改
    target_percentage: 80,
    start_hour: 22,
    start_minute: 0,
    end_hour: 7,
    end_minute: 0,
    timezone: "Asia/Shanghai", // charge.js 在请求没带 current_hour/current_minute 时，按这个时区取服务器当前时刻兜底

    // 分时电价（唯一权威来源，改电价只改这里）。格式：每行一段 "HH:MM-HH:MM=每度电价"，跨天时段直接写即可。
    // 前端只读展示这份电价；API 调用方也可用 ?tariff= 参数临时覆盖（不传即用这里的值）。
    tariff_config: [
        "22:00-07:00=0.3783",
        "07:00-11:00=0.5783",
        "11:00-13:00=0.3783",
        "13:00-22:00=0.5783"
    ].join("\n"),
    
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

// ============================================================================
// 充电模型契约（重要：新增模型只需实现这个契约，calculateCharge 一行都不用改）
// ----------------------------------------------------------------------------
// 一个「段(segment)」= 一段用单一恒定电流的充电过程，形状：
//     { current, energyKwh, gridPowerKw, lossKw, effectivePowerKw, durationHours }
// 一个「计划(plan)」= { segments: [段, 段, ...] }，描述把电充进去的完整过程。
//
// 每个模型必须暴露两个方法，都返回 plan：
//     planOptimal({ energyNeeded, duration, params })
//         —— 损耗最低、力争在 duration 小时内把 energyNeeded 度电充进去。
//     planMaxPower({ energyNeeded, params })
//         —— 最大功率狂充（用于"够不够时间充满"的判断，和充不满时的兜底展示）。
//
// quadratic（当前恒流模型）永远只返回【1 段】；
// 未来的涓流/分段模型返回【多段】（低电量段大电流、高电量段电流递减）。
// calculateCharge 只跟 plan 打交道、遍历 segments 累加，不关心里面是 1 段还是 N 段，
// 所以换模型（改 DEFAULTS.model_name）时 calculateCharge 不用动。
// 详见 DEVELOPMENT.md 的「如何新增一个充电模型」。
// ============================================================================

// 物理原语：给定电流和这一段要充的电量，算出这一段的各项功率与耗时。
// 所有模型共用，保证"电流→功率→损耗→耗时"的换算口径在全项目只有一处。
export function buildSegment(current, energyKwh, params) {
    const gridPowerKw = (current * params.Vs * params.phases) / 1000;            // 从电网抽取的总功率
    const lossKw = (params.R * (current ** 2) * params.phases) / 1000;           // I²R 发热线损
    const basePowerKw = (params.env_factors ? params.env_factors.base_power_w : 0) / 1000; // 车机自耗(哨兵/暖车)
    const effectivePowerKw = gridPowerKw - lossKw - basePowerKw;                 // 真正进电池的功率
    // 耗时由"这段电量 ÷ 有效功率"推导，不预设。这样触发 5A 底线导致提前充完的情况会自然算对，
    // 不用再在 calculateCharge 里特判。
    const durationHours = effectivePowerKw > 0 ? energyKwh / effectivePowerKw : Infinity;
    return { current, energyKwh, gridPowerKw, lossKw, effectivePowerKw, durationHours };
}

export const CHARGING_MODELS = {
    // 当前阶段：最经济纯粹的二次方程恒流模型。整段用同一个电流，所以计划永远是 1 段。
    quadratic: {
        planOptimal({ energyNeeded, duration, params }) {
            const current = solveQuadraticCurrent(energyNeeded, duration, params);
            if (current === null) return null;
            return { segments: [buildSegment(current, energyNeeded, params)] };
        },
        planMaxPower({ energyNeeded, params }) {
            return { segments: [buildSegment(params.max_current, energyNeeded, params)] };
        }
    },

    // 未来阶段：涓流 / 动态压降 / 电池衰减的分段模型。目前不实现，只保留契约形状。
    // 真正实现时：
    //   - planOptimal / planMaxPower 内部把 [startSoc, targetSoc] 拆成若干段（可从 params 读 SoC），
    //     每段用 buildSegment() 造好，返回 { segments: [seg1, seg2, ...] }；
    //   - 例如高电量涓流段可以对该段传入一个被电池限制过的、更小的 current；
    //   - calculateCharge 的正常分支会自动遍历这些段累加时长/电量/电费，无需改动。
    //   - ⚠️ 但"充不满"的碰撞分支目前按"单一恒定最大功率"推算提前/延后方案，
    //     多段模型接入时需要重看那个分支，详见 DEVELOPMENT.md。
    advanced_non_linear: {
        planOptimal({ energyNeeded, duration, params }) {
            throw new Error("涓流分段模型尚未实现，详见 DEVELOPMENT.md");
        },
        planMaxPower({ energyNeeded, params }) {
            throw new Error("涓流分段模型尚未实现，详见 DEVELOPMENT.md");
        }
    }
};

// 二次方程求解：解出"在 duration 小时内充满 energyNeeded 度电"所需的、损耗最低的恒定电流。
// 抽成独立函数，quadratic 模型内部用；不属于对外契约的一部分。
function solveQuadraticCurrent(energyNeeded, duration, params) {
    const powerIdealW = (energyNeeded / duration) * 1000;
    const basePowerW = params.env_factors ? params.env_factors.base_power_w : 0;
    // a、c 必须和 buildSegment 里的有效功率公式互为反函数，否则求出来的"最优电流"充不到目标电量：
    // a 的 R 要乘 phases，c 要把车机基础耗电加回来，两边口径才能对上。
    const a = params.R * params.phases;
    const b = -params.Vs * params.phases;
    const c = powerIdealW + basePowerW;
    const delta = b * b - 4 * a * c;

    if (delta < 0) return null;

    const I1 = (-b + Math.sqrt(delta)) / (2 * a);
    const I2 = (-b - Math.sqrt(delta)) / (2 * a);

    const roots = [I1, I2].filter(i => i > 0);
    if (roots.length === 0) return null;

    let optimal = Math.min(...roots); // 取较小正根：损耗(I²R)更低
    optimal = Math.max(optimal, params.min_current); // 底线：车机允许设置的最小电流
    return optimal > params.max_current ? params.max_current : optimal; // 上限：最大充电电流
}
