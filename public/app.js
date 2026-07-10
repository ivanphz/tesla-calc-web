// === 1. 页面加载初始化 ===
document.addEventListener('DOMContentLoaded', async () => {
    // A. 刚打开网页时，立刻初始化一次沙盒时间，防止出现 --:--
    syncLocalTime();

    // B. 恢复本地历史配置
    const saved = localStorage.getItem('tesla_calc_prefs');
    if (saved) {
        const prefs = JSON.parse(saved);
        if (prefs.target) syncTarget(prefs.target, false);
        if (prefs.startTime) document.getElementById('start-time').value = prefs.startTime;
        if (prefs.endTime) document.getElementById('end-time').value = prefs.endTime;
        // 用 != null 而不是 if(prefs.start)：电量 0% 保存后是字符串 "0"，是假值，
        // 直接真值判断会把这个合法的 0 吞掉（和之前修过的 parseInt(x)||默认值 是同一类问题）
        if (prefs.start != null && prefs.start !== '') syncStart(prefs.start, false);
    }
    // "谷电/午间"高亮不再单独存一份状态，而是每次都直接从当前的开始/结束时间反推——
    // 这样它就不可能和实际时间"看起来同步了、其实没同步"，因为它本来就是算出来的，不是记出来的。
    syncBaseWindowButtonState();

    // C. 拉取云端车机电量
    await fetchRealTimeBattery();

    // D. 拉取云端车机目标电量：有数据就用，没有就保留当前值，不需要开关
    await fetchRealTimeChargeLimit();
});

// === 核心：获取真实当前时间 + 3分钟操作缓冲 ===
function syncLocalTime() {
    const now = new Date();
    // 只做一件事：加3分钟。不强行做任何四舍五入或进位。
    now.setMinutes(now.getMinutes() + 3);
    
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    
    const timeInput = document.getElementById('mock-time');
    if (timeInput) {
        timeInput.value = `${h}:${m}`;
    }
}

// 计算"此刻应该被当作几点几分"：开了沙盒就用沙盒时间，没开就用真实时间(+3分钟操作缓冲)。
// calculate() 和"当前"预设按钮共用这一份逻辑，避免同一套时间规则散落在两个地方。
function getEffectiveNow() {
    const useMock = document.getElementById('enable-mock-time').checked;
    if (useMock) {
        const [h, m] = document.getElementById('mock-time').value.split(':').map(Number);
        return { hour: h, minute: m };
    }
    const now = new Date();
    now.setMinutes(now.getMinutes() + 3);
    return { hour: now.getHours(), minute: now.getMinutes() };
}

async function fetchRealTimeBattery() {
    const syncStatus = document.getElementById('sync-status');
    try {
        syncStatus.innerText = "(同步中...)";
        syncStatus.style.color = "#6b7280";
        const response = await fetch(`/api/battery?t=${new Date().getTime()}`);
        const data = await response.json();
        if (data && typeof data.battery === 'number') {
            syncStart(data.battery, false);
            syncStatus.innerText = "(✓ 实时数据)";
            syncStatus.style.color = "#10b981";
        } else {
            syncStatus.innerText = "(获取失败，使用本地记录)";
            syncStatus.style.color = "#f59e0b";
        }
    } catch (error) {
        syncStatus.innerText = "(连接失败，使用本地记录)";
        syncStatus.style.color = "#f59e0b";
    }
}

// === 目标电量跟随车机 ===
async function fetchRealTimeChargeLimit() {
    const targetSyncStatus = document.getElementById('target-sync-status');
    try {
        targetSyncStatus.innerText = "(同步中...)";
        targetSyncStatus.style.color = "#6b7280";
        const response = await fetch(`/api/battery?t=${new Date().getTime()}`);
        const data = await response.json();
        if (data && typeof data.charge_limit === 'number') {
            syncTarget(data.charge_limit, false);
            targetSyncStatus.innerText = "(✓ 已同步车机)";
            targetSyncStatus.style.color = "#10b981";
        } else {
            targetSyncStatus.innerText = "(车机暂无数据，可手动设置)";
            targetSyncStatus.style.color = "#f59e0b";
        }
    } catch (error) {
        targetSyncStatus.innerText = "(连接失败，可手动设置)";
        targetSyncStatus.style.color = "#f59e0b";
    }
}

function toggleTariffSettings() {
    const el = document.getElementById('tariff-panel');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function saveSettings() {
    const prefs = {
        start: document.getElementById('start-battery').value,
        target: document.getElementById('target-battery').value,
        startTime: document.getElementById('start-time').value,
        endTime: document.getElementById('end-time').value
    };
    localStorage.setItem('tesla_calc_prefs', JSON.stringify(prefs));
}

function syncStart(val, manual = true) {
    let v = parseInt(val);
    if (isNaN(v)) v = 0;
    if (v < 0) v = 0;
    if (v > 99) v = 99;
    document.getElementById('start-battery').value = v;
    saveSettings();
    if (manual) {
        const status = document.getElementById('sync-status');
        status.innerText = "(已手动修改)";
        status.style.color = "#6b7280";
    }
}

function adjustStart(delta) {
    const current = parseInt(document.getElementById('start-battery').value) || 0;
    syncStart(current + delta, true);
}

function syncTarget(val, manual = true) {
    let v = parseInt(val);
    if (isNaN(v)) v = 80;
    if (v < 50) v = 50;
    if (v > 100) v = 100;
    document.getElementById('target-battery').value = v; 
    document.getElementById('target-slider').value = v;
    document.getElementById('target-val-display').innerText = v + '%';
    document.querySelectorAll('#target-presets button').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.innerText) === v);
    });
    saveSettings();
    if (manual) {
        const status = document.getElementById('target-sync-status');
        status.innerText = "(已手动修改)";
        status.style.color = "#6b7280";
    }
}

function adjustTarget(delta) {
    const current = parseInt(document.getElementById('target-battery').value) || 80;
    syncTarget(current + delta);
}

function setTimeSlot(start, end, btn) {
    document.getElementById('start-time').value = start;
    document.getElementById('end-time').value = end;
    updateTimeBtnUI(btn);
    saveSettings();
}

function updateTimeBtnUI(activeBtn) {
    document.querySelectorAll('[id^="btn-time"]').forEach(btn => btn.classList.remove('active'));
    if (activeBtn) activeBtn.classList.add('active');
}

// "谷电/午间"这两个按钮的高亮状态，不额外存一份，而是每次都从当前的开始/结束时间直接反推：
// 值匹配上了就点亮对应按钮，match 不上就都不亮——不会出现"改回了同样的时间，按钮却没亮"的不同步。
const BASE_WINDOW_PRESETS = [
    { id: 'btn-time-night', start: '22:00', end: '07:00' },
    { id: 'btn-time-noon', start: '11:00', end: '13:00' }
];

function syncBaseWindowButtonState() {
    const start = document.getElementById('start-time').value;
    const end = document.getElementById('end-time').value;
    const matched = BASE_WINDOW_PRESETS.find(p => p.start === start && p.end === end);
    updateTimeBtnUI(matched ? document.getElementById(matched.id) : null);
}

// === 开始时间 / 结束时间各自独立的快捷预设 ===
function setStartTime(timeStr) {
    document.getElementById('start-time').value = timeStr;
    syncBaseWindowButtonState();
    saveSettings();
}

function setStartTimeNow() {
    const { hour, minute } = getEffectiveNow();
    setStartTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
}

function setEndTime(timeStr) {
    document.getElementById('end-time').value = timeStr;
    syncBaseWindowButtonState();
    saveSettings();
}

// === 计算与结果渲染 ===
// lastCalc 记录最近一次成功计算的关键信息，供"微调电流"使用：
//   optimal   —— 求解出的最优电流（还原按钮回到这里）
//   displayed —— 当前展示的电流（微调按钮在它基础上步进）
//   min/max   —— 步进边界，来自后端返回（源头是 config.js，前端不写死）
let lastCalc = null;
// 在途保护：上一次计算还没返回时忽略新的触发。
// 没有这个保护，快速连点"+"时第二次点击读到的还是旧电流，会发出重复请求、丢掉步进。
let calcInFlight = false;

async function calculate(forcedCurrent = null) {
    if (calcInFlight) return;
    calcInFlight = true;
    saveSettings(); 
    const start = document.getElementById('start-battery').value;
    const target = document.getElementById('target-battery').value;
    const startTime = document.getElementById('start-time').value.split(':');
    const endTime = document.getElementById('end-time').value.split(':');

    // 处理时间传递 (默认使用真实现实时间，除非开启沙盒)
    const { hour: currHour, minute: currMinute } = getEffectiveNow();

    const params = new URLSearchParams({
        start: start,
        target: target,
        start_hour: startTime[0],
        start_minute: startTime[1],
        end_hour: endTime[0],
        end_minute: endTime[1],
        current_hour: currHour,
        current_minute: currMinute
        // 电价不再由前端传递：后端统一用 config.js 里的 DEFAULTS.tariff_config
    });
    if (forcedCurrent != null) params.set('forced_current', forcedCurrent);

    document.getElementById('normal-result').style.display = 'none';
    document.getElementById('warning-result').style.display = 'none';
    document.getElementById('loading').style.display = 'block';

    try {
        const response = await fetch(`/api/charge?${params.toString()}`);
        const data = await response.json();
        document.getElementById('loading').style.display = 'none';

        // 回填只读电价展示（后端实际采用的电价，永远和计算用的一致）
        if (data.inputs && data.inputs.tariff_config != null) {
            document.getElementById('tariff-display').innerText =
                data.inputs.tariff_config || '(未配置电价，本次计算不含电费)';
        }

        if (data.result.error) {
            if (data.result.error_code === 'UNREACHABLE_IN_WINDOW') {
                // == 时段内充不满：渲染完整的 fallback_stats + solutions 面板 ==
                document.getElementById('warning-result').style.display = 'block';

                const fb = data.result.fallback_stats;
                document.getElementById('warn-fallback-label').innerText = fb.label;
                document.getElementById('warn-max-current').innerText = fb.max_current;
                document.getElementById('warn-reachable').innerText = fb.percent.toFixed(1) + '%';
                document.getElementById('warn-fallback-energy').innerText = fb.energy.toFixed(1) + ' kWh';
                document.getElementById('warn-fallback-cost').innerText = '¥ ' + fb.cost.toFixed(2);

                const ul = document.getElementById('warn-solutions-list');
                ul.innerHTML = '';

                // type -> CSS 修饰类，具体颜色值都放在 style.css 里，这里只决定"是哪一种"
                const typeClass = {
                    '优选': 'solution-item--preferred',
                    '备选': 'solution-item--alternative',
                    '强迫症必选': 'solution-item--forced'
                };

                data.result.solutions.forEach(sol => {
                    ul.innerHTML += `
                        <li class="solution-item ${typeClass[sol.type] || ''}">
                            <span class="solution-badge">${sol.type}</span>
                            <strong class="solution-title">${sol.title}</strong>
                            <br><span class="solution-desc">${sol.desc}</span>
                        </li>`;
                });
            } else {
                // == 其它校验类错误（电量设反了 / 百分比越界 / 时间窗非法 / 电流越界）：没有 fallback_stats/solutions，简单提示即可 ==
                alert(data.result.error);
            }
        } else {
            // == 正常满电的状态渲染 ==
            const r = data.result;
            document.getElementById('normal-result').style.display = 'block';
            document.getElementById('res-current').innerText = r.optimal_current + ' A';
            document.getElementById('res-duration').innerText = r.charging_duration + ' 小时';
            document.getElementById('res-power').innerText = r.effective_power_kw + ' kW';
            document.getElementById('res-loss').innerText = r.loss_percentage + ' %';
            document.getElementById('res-energy').innerText = r.energy_added.toFixed(1) + ' kWh';
            document.getElementById('res-cost').innerText = '¥ ' + r.cost.toFixed(2);

            // 记录微调状态：新一轮"开始计算"(forcedCurrent==null)时，最优值刷新；微调时保留原最优值
            if (forcedCurrent == null) {
                lastCalc = { optimal: r.optimal_current, displayed: r.optimal_current, min: r.min_current, max: r.max_current };
            } else {
                lastCalc = { ...lastCalc, displayed: r.optimal_current, min: r.min_current, max: r.max_current };
            }
            const status = document.getElementById('current-adjust-status');
            status.innerText = forcedCurrent != null ? `(手动 ${r.optimal_current}A，最优 ${lastCalc.optimal}A)` : '';

            // 手动调低电流可能拖过结束时间：后端给出超出量，这里如实提示
            const note = document.getElementById('overrun-note');
            if (r.window_overrun_hours > 0) {
                const mins = Math.round(r.window_overrun_hours * 60);
                const h = Math.floor(mins / 60), m = mins % 60;
                note.innerText = `⚠️ 该电流下无法在结束时间前充满，将超出 ${h > 0 ? h + '小时' : ''}${m}分（超出部分电价已计入总费）`;
                note.style.display = 'block';
            } else {
                note.style.display = 'none';
            }
        }
    } catch (error) {
        alert('计算出错，请检查网络或后端配置。');
        document.getElementById('loading').style.display = 'none';
    } finally {
        calcInFlight = false;
    }
}

// 微调电流：以 1A 步进。首次点击先吸附到整数——车机只能设整数安培，
// 所以从 24.36A 点"+"得到 25（向上取整）、点"-"得到 24（向下取整），之后按整数 ±1。
// 重算走后端同一条计算链路（物理公式只有后端一份），不在前端复算功率/损耗。
function adjustResultCurrent(delta) {
    if (!lastCalc) return;
    const cur = lastCalc.displayed;
    let next;
    if (!Number.isInteger(cur)) {
        next = delta > 0 ? Math.ceil(cur) : Math.floor(cur);
    } else {
        next = cur + delta;
    }
    next = Math.min(lastCalc.max, Math.max(lastCalc.min, next));
    if (next === cur) return; // 已到边界或吸附后无变化，不发多余请求
    return calculate(next);
}

function restoreOptimalCurrent() {
    if (!lastCalc) return;
    return calculate(); // 不带 forced_current，重新求解最优
}

// === 新增：时间输入框加减与智能吸附逻辑 ===
function adjustTime(inputId, deltaMinutes) {
    const input = document.getElementById(inputId);
    if (!input || !input.value) return;
    
    let [h, m] = input.value.split(':').map(Number);
    
    if (deltaMinutes > 0) {
        // 增加时间：如果当前不是5的倍数（如16:16），直接吸附到下一个5的倍数（16:20）
        if (m % 5 !== 0) {
            m = Math.ceil(m / 5) * 5;
        } else {
            m += deltaMinutes;
        }
    } else {
        // 减少时间：如果当前不是5的倍数（如16:16），直接吸附到上一个5的倍数（16:15）
        if (m % 5 !== 0) {
            m = Math.floor(m / 5) * 5;
        } else {
            m += deltaMinutes;
        }
    }
    
    // 处理跨小时跨天进退位
    while (m >= 60) { m -= 60; h += 1; }
    while (m < 0) { m += 60; h -= 1; }
    if (h >= 24) h -= 24;
    if (h < 0) h += 24;
    
    input.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (inputId === 'start-time' || inputId === 'end-time') syncBaseWindowButtonState();
    saveSettings();
}
