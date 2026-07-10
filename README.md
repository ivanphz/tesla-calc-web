# Tesla 充电计算器

给自己家 Tesla 算"用多大电流充电，能在谷电时段内充满、损耗最低、花费最少"的小工具。部署在 Cloudflare Pages + Pages Functions 上，纯静态前端 + 几个无服务器 API，没有构建步骤，没有数据库（只用了 Cloudflare KV 存两个数值）。

在线地址：见 Cloudflare Pages 项目设置里绑定的域名。

---

## 目录

- [项目结构](#项目结构)
- [核心算法（简述）](#核心算法简述)
- [预留接口](#预留接口--未来扩展点)
- [API 接口](#api-接口)
- [外部数据同步（TeslaMate / Node-RED）](#外部数据同步teslamate--node-red)
- [部署](#部署)
- [本地测试](#本地测试)
- [已知限制 / 尚未做的事](#已知限制--尚未做的事)

---

## 项目结构

```
tesla-calc-web/
├── .github/workflows/deploy.yml   手动触发部署到 Cloudflare Pages 的 GitHub Actions
├── functions/api/
│   ├── config.js        车辆/物理参数默认值 + 充电模型（当前算法 + 预留的未来模型接口）
│   ├── tariff.js         分时电价解析 + 按时段算钱，纯粹的"钟点定价"逻辑，不知道"充电"是什么
│   ├── time-utils.js     纯时间格式化工具（12.5 -> "12:30" 这类），不掺业务逻辑
│   ├── calculator.js     核心编排：决定用多大电流、要不要提前开始/延后结束、多少钱
│   ├── charge.js          GET /api/charge：解析 URL 参数 -> 调 calculator.js -> 返回 JSON
│   └── battery.js         GET/POST /api/battery：车机电量、目标电量的 KV 读写接口
├── public/
│   ├── index.html        页面结构
│   ├── app.js              前端交互逻辑：状态同步、时间预设、发起计算请求、渲染结果
│   ├── style.css          样式（所有视觉相关的东西都在这，HTML/JS 里不应该出现内联 style）
├── README.md             总览、部署、API（本文件）
└── DEVELOPMENT.md        架构、算法推导、如何新增充电模型（改算法看这份）
```

依赖关系是单向的：`charge.js` → `calculator.js` → `config.js` / `tariff.js` / `time-utils.js`。`calculator.js` 不知道 HTTP 是什么，`tariff.js`/`time-utils.js` 也不知道"充电"是什么——真要复用其中某一块（比如单独拿分时电价算钱），不用牵扯别的文件。

---

## 核心算法（简述）

谷电时段内电价通常不分时段，省钱关键不是"多快充完"而是**把恒定电流摊满可用时间、取够用的最小电流**，把 `I²R` 损耗压到最低。给定时长反推有效功率、解一元二次方程取较小正根即最优电流。充不满时进入"时空碰撞"分支，给出提前开始/延后结束/立刻狂充等带具体电费的方案。

> 完整的算法推导、分段计划(plan)契约、以及**如何新增一个充电模型（涓流等）**，见 [DEVELOPMENT.md](./DEVELOPMENT.md)。改算法只看那一份文档即可，不用通读代码。

---

## 预留接口 / 未来扩展点

这些字段已经定义在 `config.js` 的 `DEFAULTS` 里，但**目前的前端/API 都还没有实际传参去覆盖它们**，所以现在看不出任何效果——先记录清楚，以后要用的时候不用重新设计。

| 字段 | 现状 | 用途 |
|---|---|---|
| `phases` | 默认 `1` | 单相/三相电桩切换。TeslaMate 的 MQTT 会推 `charger_phases`，以后可以考虑直接同步这个值而不是手动改配置 |
| `env_factors.base_power_w` | 默认 `0` | 车机哨兵模式/暖车等不进电池的耗电，求解器和校验器已经统一按这个字段算过，公式是对的 |
| `env_factors.sentry_mode_on` / `winter_heating_on` | 定义了，全项目没有任何地方读取 | 纯占位符。真要用的时候，得决定这两个开关具体怎么换算成 `base_power_w`（或者去改 `R`——低温对内阻的影响可能更适合走这条路） |
| `model_name` / `CHARGING_MODELS.advanced_non_linear` | `model_name` 默认 `'quadratic'`，`advanced_non_linear` 是抛异常的占位符 | 涓流/分段充电模型的接口。模型返回"充电计划(plan)"而非单个电流，quadratic 返回单段、涓流返回多段；接入只需实现两个方法 + 改 `model_name`，`calculator.js` 不用动。**详细契约和涓流示例见 [DEVELOPMENT.md](./DEVELOPMENT.md)** |
| `result.plan.segments` | quadratic 下永远 1 段 | 分段渲染接口，涓流接入后前端可按段展示"每段各多大电流、各多久" |
| `battery_health.usable_capacity_ratio` | 默认 `1.0`，未被 `energy_needed` 的计算引用 | 电池衰减/实际可用容量校正，等有真实数据了再接进 `capacity` 的计算里 |

**充电电流没有做整数取整**：算出来的是带小数的理论最优电流（比如 23.38A），车机实际只能设整数安培。这是有意不做的——由人来看着办，宁可保守多设 1A，也不想在代码里悄悄做出可能欠充的取整决定。

**没有做 TeslaMate 剩余时间的交叉校验/历史留痕**：这个想法讨论过（可以拿车机自己估的剩余时间和这套算法的预测做对比，积累数据以后拿来校准），但目前 `battery.js` 用的 KV 只存"最新一个值"，真要做历史留痕需要重新设计存储方式，属于一个独立的、还没启动的工作。

---

## API 接口

### `GET /api/charge`

| 参数 | 说明 | 默认值 |
|---|---|---|
| `start` | 起始电量 %（必填，缺失或非数字返回 400） | – |
| `target` | 目标电量 % | 80 |
| `start_hour` / `start_minute` | 基准时段开始时间 | 22:00 |
| `end_hour` / `end_minute` | 基准时段结束时间 | 07:00 |
| `current_hour` / `current_minute` | "现在几点"，用于判断是否已在时段内/是否来得及 | 不传时按服务器 `Asia/Shanghai` 当前时刻兜底（见下） |
| `tariff` | 分时电价配置文本（可选，供自动化临时覆盖；显式传空串 = 不计费） | 不传则用 config.js 的 `DEFAULTS.tariff_config` |
| `forced_current` | 手动指定充电电流（可选）。传了就按这个电流算时长/损耗/电费，不传则求解最优。必须在 `min_current`-`max_current` 范围内 | 不传（求解最优） |

> **"现在几点"的兜底**：网页前端总是显式传这两个参数（要支持沙盒时间）。直连 API 的调用方（比如 iOS 捷径）可以不传，服务器会按 `config.js` 里 `timezone` 配置的时区取当前时刻。响应里的 `inputs` 会原样回显服务器实际采用的所有参数，包括兜底出来的时间。

**无论成功失败，返回的都是同一个信封结构 `{ inputs, result }`**，错误永远在 `result.error` / `result.error_code` 里，调用方只需要解析一种结构。正常时 `result`：

```json
{
  "optimal_current": 24.36,
  "charging_duration": 9,
  "effective_power_kw": 5.2,
  "loss_percentage": 4.78,
  "energy_added": 46.8,
  "cost": 18.59,
  "window_overrun_hours": 0,
  "min_current": 5,
  "max_current": 32,
  "plan": { "segments": [ { "current": 24.36, "...": "..." } ] }
}
```

`window_overrun_hours`：手动把电流调低时充电会拖过结束时间，这里给出超出的小时数（0 = 按时完成）；超出部分的电价已如实计入 `cost`。`min_current`/`max_current`：前端微调按钮的步进边界（来源是 config.js）。`plan.segments`：分段计划（见预留接口）。

失败时 `result` 带 `error` + 机器可读的 `error_code`：

| error_code | 含义 |
|---|---|
| `MISSING_START_PARAM` | 缺少或非法的 `start` 参数（HTTP 400） |
| `PERCENTAGE_OUT_OF_RANGE` | 电量百分比不在 0–100 |
| `START_GTE_TARGET` | 起始电量 ≥ 目标电量 |
| `INVALID_TIME_WINDOW` | 开始和结束时间相同 |
| `CURRENT_OUT_OF_RANGE` | `forced_current` 缺失数值或超出 min-max 范围 |
| `SOLVE_FAILED` | 数学上无解（正常配置下基本不会触发） |
| `UNREACHABLE_IN_WINDOW` | 时段内充不满，此时额外带 `solutions` 和 `fallback_stats` |

`UNREACHABLE_IN_WINDOW` 时的附加字段：

- `solutions[]`：具体方案数组，每项含 `type`（优选/备选/强迫症必选）、`cost`（**纯数字**，供自动化直接读）、`title` 和 `desc`（面向网页展示的字符串，`desc` 内含少量 HTML 标记）。
- `fallback_stats`：坚守原时段（不提前不延后）的结果，含 `label`、`max_current`（计算所用的最大电流，前端"按 XX A 满载"的数字来源）、`percent`、`energy`、`cost`。

### `GET /api/battery`

返回 `{ battery: number|null, charge_limit: number|null }`，分别是车机当前电量和目标充电百分比，任一没同步过就是 `null`。

> GET 不做鉴权，知道 URL 的任何人都能读到这两个数值（也仅有这两个数值）。API 与前端同源，不设置 CORS 头，其它网站的页面无法跨域读取；非浏览器调用方（捷径、脚本）不受此限制。若以后在意公开可读性，可参照 POST 给 GET 也加 token。

### `POST /api/battery`

请求体 `{ token, battery?, charge_limit? }`，`battery`/`charge_limit` 各自独立可选，哪个字段有效就写哪个。`token` 必须等于 Cloudflare 环境变量 `SECRET_TOKEN`，未配置该变量时一律拒绝（不会因为两边都是 `undefined` 而放行）。

---

## 外部数据同步（TeslaMate / Node-RED）

车机的实时电量和目标充电百分比，是通过 Node-RED 监听 TeslaMate 的 MQTT 推送、过滤掉未变化的值、再 POST 到 `/api/battery` 写入 KV 的。大致流程（每个字段各一条类似的流）：

```
MQTT In (teslamate/cars/1/battery_level)
  → RBE 节点（仅数值变化时放行）
  → Function 节点（拼成 {token, battery: parseInt(msg.payload)}）
  → HTTP Request 节点（POST 到 /api/battery）
```

`charge_limit`（目标电量）用的是同一个 `/api/battery` 端点，只是监听 `teslamate/cars/1/charge_limit_soc`、payload 换成 `{token, charge_limit: ...}`。两条流互不影响，缺一条另一条照常工作。

前端页面打开时会自动 `GET /api/battery` 把两个值拉回来填进输入框；用户手动改动后会显示"已手动修改"，不会被下一次同步覆盖式地误导成"已同步车机"。

---

## 部署

### Cloudflare Pages

1. 项目 **Settings → Bindings** 添加一个 KV 命名空间绑定，变量名 `TESLA_KV`。
2. 项目 **Settings → Variables and Secrets** 添加 `SECRET_TOKEN`：这是 Node-RED（或其它外部程序）推送数据时用的密钥，只要不是明文暴露在公开仓库/日志里，用 **Secret**（加密）还是 **Text**（明文）都可以——两者对代码里 `env.SECRET_TOKEN` 的读取方式完全一样，唯一区别是 Text 类型的值以后还能在 Cloudflare 控制台里看到/复制，Secret 类型设置后就再也看不到了，只能覆盖。个人项目、密钥本身不算敏感的话，选 Text 更方便（比如以后要在另一台设备上配置同一个密钥，不用重新生成）。

### GitHub Actions（`.github/workflows/deploy.yml`）

- **Secrets**（Settings → Secrets and variables → Actions → Secrets）：`CF_API_TOKEN`、`CF_ACCOUNT_ID`。
- **Variables**（同一页面的 Variables 标签页）：`CF_PROJECT_NAME`，值填 Cloudflare Pages 里的项目名。项目名不再写死在 `deploy.yml` 里。

默认是手动触发（Actions 页面点按钮）。想要每次 push 到 `main` 自动部署，把 `deploy.yml` 里注释掉的 `push: branches: ["main"]` 取消注释即可。

---

## 本地测试

没有构建步骤，`public/` 下的文件可以直接用任意静态服务器打开调试前端；后端 `functions/api/*.js` 是标准 ES Module，`calculateCharge` 可以直接在 Node 里 `import` 后传参调用，不需要跑完整的 Cloudflare 环境：

```js
import { calculateCharge } from './functions/api/calculator.js';

console.log(calculateCharge({
    start_percentage: 20,
    target_percentage: 80,
    start_hour: 22, start_minute: 0,
    end_hour: 7, end_minute: 0,
    current_hour: 20, current_minute: 0,
    tariff_config: "22:00-07:00=0.3783\n07:00-11:00=0.5783\n11:00-13:00=0.3783\n13:00-22:00=0.5783"
}));
```

`battery.js` 依赖 Cloudflare 的 `env.TESLA_KV`/`env.SECRET_TOKEN`，本地测试时可以传一个手写的 mock（`{ get, put }` 两个方法）代替，不需要真的连 Cloudflare。

---

## 已知限制 / 尚未做的事

- 电价的唯一权威来源是 `functions/api/config.js` 的 `DEFAULTS.tariff_config`，前端只读展示（点击「开始计算」后回显后端实际采用的电价）。改电价 = 改 config.js 后重新部署。
- 计算出的最优电流带小数，结果面板提供 ±1A 手动微调（首次点击吸附到整数，因为车机只能设整数安培），微调的重算走后端同一条链路。
- 充电电流不取整（见上文"预留接口"），需要人工设置到车机上时自行取整。
- 涓流充电等非线性充电曲线模型未实现，接口已预留（`model_name`）。
- 没有 TeslaMate 剩余时间的交叉校验或历史留痕功能。
- 电价配置文本里格式/数值非法的行会被整行静默跳过（不污染其它行的计费），但不会有任何报错提示告诉你哪一行被跳过了。
- `GET /api/battery` 公开可读（无鉴权），见上文 API 章节的说明。
