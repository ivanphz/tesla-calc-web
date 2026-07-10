# 开发文档（DEVELOPMENT.md）

这份文档的目标：**以后要改算法或加功能，读这一份就够，不用从头审计代码。** 面向用户的介绍、部署步骤、API 参数在 [README.md](./README.md)，这里只讲"里面怎么运作、怎么扩展"。

---

## 目录

- [分层与数据流](#分层与数据流)
- [核心算法推导](#核心算法推导)
- [充电计划(plan)契约](#充电计划plan契约)——扩展的关键
- [如何新增一个充电模型](#如何新增一个充电模型)（含涓流示例）
- ["充不满"碰撞分支的边界](#充不满碰撞分支的边界)
- [预留接口清单](#预留接口清单)
- [怎么测](#怎么测)

---

## 分层与数据流

依赖是**单向**的，上层依赖下层，下层不知道上层的存在：

```
HTTP 层     charge.js  (解析 URL 参数、兜底、统一错误信封)
             │  battery.js (KV 读写，和上面并列，互不依赖)
             ▼
编排层     calculator.js  (calculateCharge：判断能否充满、选方案、算钱)
             ▼
模型/工具层  config.js    (车辆参数 DEFAULTS + 充电模型 CHARGING_MODELS)
             tariff.js     (电价解析 + 按时段算钱)
             time-utils.js (时间格式化)
```

- `calculator.js` **不知道 HTTP 是什么**，可以直接在 Node 里 `import` 后传参调用。
- `tariff.js` / `time-utils.js` **不知道"充电"是什么**，纯工具，可单独复用。
- 换充电算法只动 `config.js`（见下文）；改电价计费只动 `tariff.js`；两者互不影响。

分时电价的唯一权威来源是 `config.js` 的 `DEFAULTS.tariff_config`：前端不传电价（只读回显响应里 `inputs.tariff_config`），API 调用方可用 `?tariff=` 临时覆盖。

一次 `GET /api/charge` 的数据流：`charge.js` 把查询参数整理成 `inputs` → `calculateCharge(inputs)` → 内部选出 `model`（由 `inputs.model_name` 决定）→ 模型产出**充电计划** → 编排层遍历计划累加时长/电量/电费 → 返回 `{ inputs, result }`。

---

## 核心算法推导

### 为什么是"摊满时间、取较小电流"

谷电时段内电价通常不分时段，所以省钱的关键不是"多快充完"，而是**把恒定电流尽量摊满可用时间、取够用的最小电流**，把 `I²R` 发热损耗压到最低——损耗越低，同样充到目标，从电网买的电越少，越省钱。

给定要充的电量和可用时长，反推需要的有效功率，解这个关于电流 `I` 的一元二次方程（`solveQuadraticCurrent`）：

- 电网抽取功率：`Vs·I·phases`
- 发热损耗：`R·I²·phases`
- 进电池的有效功率：`Vs·I·phases − R·I²·phases − base_power_w`（`base_power_w` 是车机自耗，哨兵/暖车等不进电池的部分）

方程两个正根**取较小的那个**——同样能在规定时间内充满，小电流的 `I²R` 损耗更低。结果夹到 `[min_current, max_current]`。

> ⚠️ **改动物理公式时最容易踩的坑**：`solveQuadraticCurrent`（求解器）和 `buildSegment`（用电流反算有效功率）必须互为反函数，两边的 `phases`、`base_power_w` 系数要完全对上，否则算出来的"最优电流"实际充不满目标电量，而且**不会报任何错**。改一处务必两处一起核。

### 时间窗口与"现在几点"

- `standard_window`：基准时段总时长（跨天如 22:00-07:00 会 +24 抹平）。
- `now_to_end`：从现在到时段结束还剩多久。
- 判断"现在在不在时段内"，在则用 `now_to_end` 作为可用时间（重新规划剩余），不在则用完整 `standard_window`。
- 全程只用"还剩几小时"这种**相对值**，从不判断"今天/明天"——电价也只分钟点不分日期，所以"死守 22:00"里的 22:00 是"下一次出现的 22:00"，今天没到就是今天、过了就是明天，天然无需区分。

---

## 充电计划(plan)契约

**这是扩展的核心。** 编排层 `calculateCharge` 不直接跟"电流"打交道，而是跟模型返回的**计划**打交道。

- **段(segment)** = 一段用单一恒定电流的充电，形状（`config.js` 里 `buildSegment()` 负责造）：
  ```js
  { current, energyKwh, gridPowerKw, lossKw, effectivePowerKw, durationHours }
  ```
  其中 `durationHours = energyKwh / effectivePowerKw`，由电量和有效功率**推导**，不预设。
- **计划(plan)** = `{ segments: [段, 段, ...] }`。

`quadratic` 恒流模型**永远只返回 1 段**（整段一个电流）。未来的涓流/分段模型返回**多段**（低电量段大电流、高电量段电流递减）。编排层遍历 `segments` 累加，不关心是 1 段还是 N 段——**这就是为什么换模型不用动 `calculateCharge`**。

编排层提供三个与模型无关的辅助（在 `calculator.js`）：

- `planTotals(plan)` → `{ durationHours, energyKwh }`（各段求和）。
- `planCost(plan, startHour, tariffs)` → 把各段依次排在时间轴上、逐段按各自功率计费求和。单段时等价于对整段直接 `calculateCost`。
- `roundSegmentForOutput(seg)` → 段的对外展示版本（取整），放进结果的 `plan.segments`。

结果对象里除了原有的标量字段（`optimal_current` 等，取自首段，供现有 UI），还多一个 `plan.segments` 数组——这是**给未来分段渲染预留的接口**：涓流模型接入后，前端可据此画出"每段各多大电流、各多久"，后端不用再改。

---

### 手动微调电流（forced_current）

输入里带 `forced_current` 时，编排层**不调用模型求解**，直接 `buildSegment(forced_current, energy_needed, params)` 出一个单段计划——车机本来就只能设一个恒定电流，所以人工模式天然是单段，这个语义对任何模型（包括未来的多段涓流）都成立。范围校验（min/max）只在 `calculateCharge` 里做一处。调低电流导致到点充不满时，主结果采用**到点截断**语义（第一逻辑）：时长/电量/电费展示"到结束时间为止"的数据，`reached_percentage` 给出届时可达电量；"要充满还需延后多久（`window_overrun_hours`）、总共多少钱（`full_charge_cost`，按真实时间轴逐段计费，超出部分落进峰价会如实变贵）"是附带提示。截断的电量/电费分别由 `planWindowEnergy` 和 `planCost` 的 capHours 参数按段消耗时间预算得出，对多段模型同样成立。

---

## 如何新增一个充电模型

以"加一个涓流分段模型"为例，**全部改动集中在 `config.js`，`calculator.js` 一行不动**：

### 第 1 步：在 `CHARGING_MODELS` 里实现两个方法

契约固定是这两个，都返回一个 plan：

```js
CHARGING_MODELS.trickle = {
    // 损耗最低、力争在 duration 小时内充满 energyNeeded 度电
    planOptimal({ energyNeeded, duration, params }) {
        // 例：把要充的电量按 SoC 拆成"恒流段"和"涓流段"
        // （下面是示意，真实阈值/曲线要用实测数据）
        const segments = [];
        // ... 低电量段：接近 quadratic 的大电流
        // segments.push(buildSegment(currentA, energyA, params));
        // ... 高电量涓流段：传入一个被电池限制过的、更小的电流
        // segments.push(buildSegment(currentB, energyB, params));
        return { segments };
    },
    // 最大功率狂充（用于"够不够时间"判断和充不满兜底）
    planMaxPower({ energyNeeded, params }) {
        // 同样可以是多段：狂充时高电量段也会被电池限流
        return { segments: [ /* ... */ ] };
    }
};
```

要点：
- 用共享的 `buildSegment(current, energyKwh, params)` 造每一段，别自己重算功率公式（保证口径一致）。
- 各段的 `energyKwh` 加起来要等于 `energyNeeded`。
- 涓流段的"电流被电池限制"这件事，就体现在你给那一段传一个更小的 `current`。

### 第 2 步：切换

把 `DEFAULTS.model_name` 改成 `'trickle'`，或在请求/前端传 `model_name=trickle`。`calculateCharge` 里 `CHARGING_MODELS[params.model_name]` 会自动选中。**编排层、charge.js、前端都不用改**（前端若要按段展示，读 `result.plan.segments` 即可）。

### 第 3 步：正常分支会自动正确

`calculateCharge` 的正常分支已经是遍历 `plan.segments` 累加时长/电量、逐段计费，所以多段模型的"充得满"结果会自动算对。**但碰撞分支不会**——见下。

---

## "充不满"碰撞分支的边界

`calculateCharge` 里"时段内充不满"的那段（`UNREACHABLE_IN_WINDOW`），目前把最大功率当成**单一恒定速率**来推算"提前开始/延后结束/立刻狂充"这些方案：它取 `maxPlan.segments[0]` 的 `gridPowerKw` / `effectivePowerKw` 作为整段的恒定速率。

- 对 `quadratic`（永远单段）这是**精确**的。
- 对未来的**多段涓流模型**，`maxPlan` 会有多段、速率不恒定，这个分支的"提前 X 小时能多充多少、多花多少钱"就不准了。

所以：**接入多段模型时，必须重看这个碰撞分支**，把里面"速率 × 时长"式的估算改成"遍历 maxPlan 的段、走到某个时长为止"。正常分支不用管（已经分段安全），只有这个碰撞分支是已知的、被显式圈出来的待办。代码里对应位置有 `⚠️` 注释指向本节。

---

## 预留接口清单

已定义、但目前没有实际传值去覆盖的字段（现在看不出效果，记清楚以后要用时不用重新设计）：

| 字段 | 现状 | 用途 |
|---|---|---|
| `model_name` + `CHARGING_MODELS` | 默认 `quadratic`；`advanced_non_linear` 是抛异常的占位符 | 换充电算法的总开关，配合上面的 plan 契约 |
| `result.plan.segments` | quadratic 下永远 1 段 | 分段渲染接口，涓流接入后前端按段画图 |
| `phases` | 默认 1 | 单相/三相切换。TeslaMate MQTT 有 `charger_phases` 可来源 |
| `env_factors.base_power_w` | 默认 0 | 车机自耗（哨兵/暖车），求解器和 `buildSegment` 已按它统一 |
| `env_factors.sentry_mode_on` / `winter_heating_on` | 定义了但无处读取 | 纯占位；真用时要决定怎么换算成 `base_power_w`（低温也可能更适合改 `R`） |
| `battery_health.usable_capacity_ratio` | 默认 1.0，未被引用 | 电池衰减/实际可用容量校正 |

**故意不做的**（是风格，不是遗漏）：充电电流不取整（人工设到车机时自行取整，宁可保守多设 1A）；不做 TeslaMate 剩余时间的交叉校验/历史留痕（现有 KV 只存最新值，留痕要重设计存储）。

---

## 怎么测

没有构建步骤，模型和编排层都是标准 ES Module，直接在 Node 里 import：

```js
import { calculateCharge } from './functions/api/calculator.js';
console.log(calculateCharge({
    start_percentage: 20, target_percentage: 80,
    start_hour: 22, start_minute: 0, end_hour: 7, end_minute: 0,
    current_hour: 20, current_minute: 0,
    tariff_config: "22:00-07:00=0.3783\n07:00-11:00=0.5783\n11:00-13:00=0.3783\n13:00-22:00=0.5783"
}));
// => optimal_current: 24.36, charging_duration: 9, effective_power_kw: 5.2,
//    loss_percentage: 4.78, energy_added: 46.8, cost: 18.59,
//    plan: { segments: [ { current: 24.36, ... } ] }
```

**改动物理公式或模型后，务必回归这几个锚点值**（quadratic，默认车辆参数、上面那份电价）：

| 场景 | 关键输出 |
|---|---|
| 20%→80%，22:00-07:00，现在 20:00 | `optimal_current=24.36`, `duration=9`, `cost=18.59` |
| 60%→70%，现在 23:30（触发 5A 底线） | `optimal_current=5`, `duration=7.03` |
| 11%→100%，现在 15:55（碰撞，两方案） | 两方案 `cost=29.92`；`fallback` 88.6% / 60.5kWh / ¥24.43 |

`charge.js` / `battery.js` 依赖 Cloudflare 的 `env`（`TESLA_KV`、`SECRET_TOKEN`），本地测时传一个手写的 mock（`{ get, put }`）即可，不用真连 Cloudflare。
