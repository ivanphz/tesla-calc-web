import { DEFAULTS, CHARGING_MODELS, buildSegment } from './config.js';
import { parseTariffs, calculateCost } from './tariff.js';
import { formatTime, formatDuration } from './time-utils.js';

// —— 计划(plan)的通用辅助，与具体模型无关 ——

// 把一个计划的所有段累加成总时长/总电量
function planTotals(plan) {
    return plan.segments.reduce(
        (acc, s) => ({ durationHours: acc.durationHours + s.durationHours, energyKwh: acc.energyKwh + s.energyKwh }),
        { durationHours: 0, energyKwh: 0 }
    );
}

// 从 startHour 开始，把计划里的各段依次排在时间轴上，逐段按各自功率计费后求和。
// capHours 是时间预算上限：到点截断的场景传可用时长，正常场景不传（不设限）。
// 单段且不截断时等价于对整段直接 calculateCost，所以 quadratic 的电费和改造前逐位一致。
function planCost(plan, startHour, tariffs, capHours = Infinity) {
    let t = startHour;
    let cost = 0;
    let budget = capHours;
    for (const s of plan.segments) {
        if (budget <= 1e-9) break;
        const d = Math.min(s.durationHours, budget);
        cost += calculateCost(t, d, s.gridPowerKw, tariffs);
        t += d;
        budget -= d;
    }
    return Number(cost.toFixed(2));
}

// 时间预算内实际能充入的电量（逐段消耗预算，多段模型同样成立）
function planWindowEnergy(plan, capHours) {
    let budget = capHours;
    let energy = 0;
    for (const s of plan.segments) {
        if (budget <= 1e-9) break;
        const d = Math.min(s.durationHours, budget);
        energy += s.effectivePowerKw * d;
        budget -= d;
    }
    return energy;
}

// 段的对外展示版本（取整），放进结果的 plan.segments 里给前端/自动化按段渲染
function roundSegmentForOutput(s) {
    return {
        current: Number(s.current.toFixed(2)),
        energy_kwh: Number(s.energyKwh.toFixed(2)),
        effective_power_kw: Number(s.effectivePowerKw.toFixed(2)),
        grid_power_kw: Number(s.gridPowerKw.toFixed(2)),
        loss_percentage: Number(((s.lossKw / s.gridPowerKw) * 100).toFixed(2)),
        duration_hours: Number(s.durationHours.toFixed(2))
    };
}

// 核心编排逻辑：给定当前电量、目标电量、基准充电时段和"现在几点"，算出：
//   1. 能不能在基准时段内充满 —— 能的话，给出损耗最低（=花费最低）的充电计划；
//   2. 充不满的话，进入"时空碰撞"分支：看能不能提前开始/延后结束来凑够时间，
//      提供具体方案；连这个也来不及，就退而求其次算出"现在立刻充，能充到多少"。
// 全程只跟模型返回的「计划(plan)」打交道，不关心计划里是 1 段还是 N 段。
// 详细算法与扩展方式见仓库根目录 DEVELOPMENT.md。
export function calculateCharge(inputs) {
    const params = {
        ...DEFAULTS,
        ...inputs,
        // env_factors/battery_health 是嵌套对象，不能被 inputs 里的同名字段整体覆盖(浅合并)，
        // 否则以后只传部分字段(比如只传 sentry_mode_on)，缺的字段(比如 base_power_w)会变成 undefined，级联出 NaN。
        env_factors: { ...DEFAULTS.env_factors, ...(inputs.env_factors || {}) },
        battery_health: { ...DEFAULTS.battery_health, ...(inputs.battery_health || {}) }
    };
    // 预留接口：以后要切换到更复杂的算法模型，只需要传 model_name，这里不用改
    const model = CHARGING_MODELS[params.model_name] || CHARGING_MODELS.quadratic;
    const tariffs = parseTariffs(params.tariff_config);

    if (params.start_percentage < 0 || params.start_percentage > 100 || params.target_percentage < 0 || params.target_percentage > 100) {
        return { error: "错误：电量百分比必须在0-100之间", error_code: "PERCENTAGE_OUT_OF_RANGE" };
    }

    if (params.start_percentage >= params.target_percentage) {
        return { error: "错误：目标电量必须大于起始电量", error_code: "START_GTE_TARGET" };
    }

    // 手动微调电流（可选输入）：范围校验只放在这一处（这里才知道 min/max）
    if (params.forced_current != null && (params.forced_current < params.min_current || params.forced_current > params.max_current)) {
        return {
            error: `错误：电流必须在 ${params.min_current}-${params.max_current}A 之间`,
            error_code: "CURRENT_OUT_OF_RANGE"
        };
    }

    const energy_needed = params.capacity * (params.target_percentage - params.start_percentage) / 100;

    // 最大功率狂充计划：用于"够不够时间充满"的判断，以及充不满时的兜底展示。
    // 碰撞分支目前把它当成"单一恒定最大功率"来推算提前/延后方案 —— 这对 quadratic(永远单段)精确；
    // 未来多段涓流模型接入时，下面这几个 max 速率是首段值、碰撞分支需要重看（见 DEVELOPMENT.md）。
    const maxPlan = model.planMaxPower({ energyNeeded: energy_needed, params });
    const maxSeg = maxPlan.segments[0];
    const power_effective_max_kw = maxSeg.effectivePowerKw;
    const grid_power_max_kw = maxSeg.gridPowerKw;
    const max_charging_time_hours = planTotals(maxPlan).durationHours;

    const start_time_hours = params.start_hour + params.start_minute / 60;
    const end_time_hours = params.end_hour + params.end_minute / 60;
    const current_time_hours = params.current_hour + params.current_minute / 60;

    // 开始和结束时间相同是非法输入(不是"整整24小时")，直接拒绝，而不是静默按24小时窗口计算
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
                type: '优选',
                cost: cost_early,
                title: `提前至 ${formatTime(early_start)} 预约开始`,
                desc: `(比标准开始时间提前 ${formatDuration(extra_segment_hours)}，这部分预计花费 ¥${early_segment_cost}) 充满预估：<strong class="text-success">¥${cost_early}</strong>`
            });

            // "死守 start_time_hours 开始"里的这个时刻，指的是它"下一次出现"的那个点：
            // 今天还没到就是今天这个点，今天已经过了就是明天同一时刻——这是有意为之的设计。
            solutions.push({
                type: '备选',
                cost: cost_late,
                title: `死守 ${formatTime(start_time_hours)} 开始，延后至 ${formatTime(late_end)} 结束`,
                desc: `(比标准结束时间延后 ${formatDuration(extra_segment_hours)}，这部分预计花费 ¥${late_segment_cost}) 充满预估：<strong class="text-success">¥${cost_late}</strong>`
            });

            const energy_in_window = power_effective_max_kw * standard_window;
            fallback_stats = {
                label: `💡 若坚守 ${formatTime(start_time_hours)}-${formatTime(end_time_hours)} 不提前不延后:`,
                max_current: params.max_current,
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
                max_current: params.max_current,
                percent: percent_at_end,
                energy: energy_now_to_end,
                cost: cost_to_end
            };

            solutions.push({
                type: '强迫症必选',
                cost: total_cost,
                title: `现在立刻开充，延后至 ${formatTime(late_end)} 结束`,
                desc: `(必须突破时段限制，额外多充 <strong class="text-danger">${formatDuration(extra_hours)}</strong> 才能充满) 总预估：<strong class="text-success">¥${total_cost}</strong>`
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

    // 手动微调模式：不求解，直接按人指定的电流出一个单段计划。
    // 车机本来就只能设一个恒定电流，所以人工模式天然是单段——这个语义对任何模型都成立，不经过 model。
    const plan = params.forced_current != null
        ? { segments: [buildSegment(params.forced_current, energy_needed, params)] }
        : model.planOptimal({ energyNeeded: energy_needed, duration: available_duration, params });
    if (plan === null) return { error: "错误：无法计算", error_code: "SOLVE_FAILED" };

    const totals = planTotals(plan);
    const head = plan.segments[0]; // 标量字段（单一电流/功率）取首段；多段模型请读下方 plan.segments

    // 手动把电流调低时，充电会拖过结束时间。第一逻辑是"到点截断"：
    // 主结果（时长/电量/电费）展示"到结束时间为止"的真实情况，以及届时能充到多少电量；
    // "要充满还需延后多久、总共多少钱"降级为附带提示字段（window_overrun_hours / full_charge_cost）。
    const overrun_hours = Math.max(0, totals.durationHours - available_duration);
    const is_truncated = overrun_hours > 1e-9;

    const shown_duration = is_truncated ? available_duration : totals.durationHours;
    const shown_energy = is_truncated ? planWindowEnergy(plan, available_duration) : totals.energyKwh;
    const shown_cost = planCost(plan, effective_start_hours, tariffs, shown_duration);
    const reached_percentage = Math.min(100, params.start_percentage + (shown_energy / params.capacity) * 100);

    return {
        optimal_current: Number(head.current.toFixed(2)),
        charging_duration: Number(shown_duration.toFixed(2)),
        effective_power_kw: Number(head.effectivePowerKw.toFixed(2)),
        loss_percentage: Number(((head.lossKw / head.gridPowerKw) * 100).toFixed(2)),
        energy_added: Number(shown_energy.toFixed(2)),
        // 到结束时间能充到的电量百分比。能按时充满时它就等于目标电量。
        reached_percentage: Number(reached_percentage.toFixed(1)),
        cost: shown_cost,
        // 附带提示：要充满到目标还需超出结束时间多久（0 = 按时充满），以及届时的充满总费
        window_overrun_hours: Number(overrun_hours.toFixed(2)),
        ...(is_truncated ? { full_charge_cost: planCost(plan, effective_start_hours, tariffs) } : {}),
        // 前端手动微调按钮的边界（来源只有 config.js 一处）
        min_current: params.min_current,
        max_current: params.max_current,
        // 预留的分段渲染接口：quadratic 下永远是 1 段；涓流模型接入后这里会是多段，
        // 前端可据此画出"每段各用多大电流、各多久"，而不用改后端。
        // 注意：plan 始终描述"充满到目标"的完整计划，不做截断。
        plan: { segments: plan.segments.map(roundSegmentForOutput) }
    };
}
