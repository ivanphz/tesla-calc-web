// === 1. 页面加载初始化 ===
document.addEventListener('DOMContentLoaded', async () => {
    // A. 刚打开网页时，立刻初始化一次沙盒时间，防止出现 --:--
    syncLocalTime();

    // B. 恢复本地历史配置
    const saved = localStorage.getItem('tesla_calc_prefs');
    if (saved) {
        const prefs = JSON.parse(saved);
        if (prefs.target) syncTarget(prefs.target);
        if (prefs.startTime) document.getElementById('start-time').value = prefs.startTime;
        if (prefs.endTime) document.getElementById('end-time').value = prefs.endTime;
        if (prefs.tariff) document.getElementById('tariff-config').value = prefs.tariff;
        if (prefs.activeTimeBtnId) {
            const btn = document.getElementById(prefs.activeTimeBtnId);
            if (btn) updateTimeBtnUI(btn);
        }
        if (prefs.start) syncStart(prefs.start, false);
        if (prefs.syncTargetWithCar) document.getElementById('sync-target-with-car').checked = true;
    }
    
    // C. 拉取云端车机电量
    await fetchRealTimeBattery();

    // D. 如果开着"跟随车机目标电量"，顺带拉一次目标电量
    if (document.getElementById('sync-target-with-car').checked) {
        await fetchRealTimeChargeLimit();
    }
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
            syncTarget(data.charge_limit);
            targetSyncStatus.innerText = "(✓ 已同步车机)";
            targetSyncStatus.style.color = "#10b981";
        } else {
            targetSyncStatus.innerText = "(车机暂无数据，沿用当前值)";
            targetSyncStatus.style.color = "#f59e0b";
        }
    } catch (error) {
        targetSyncStatus.innerText = "(连接失败，沿用当前值)";
        targetSyncStatus.style.color = "#f59e0b";
    }
}

// 开关切换：打开就立刻拉一次；关掉则清空状态提示，改回纯手动
function onSyncTargetToggle(checked) {
    saveSettings();
    const targetSyncStatus = document.getElementById('target-sync-status');
    if (checked) {
        fetchRealTimeChargeLimit();
    } else {
        targetSyncStatus.innerText = "";
    }
}

function toggleTariffSettings() {
    const el = document.getElementById('tariff-config');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function saveSettings() {
    const activeTimeBtn = document.querySelector('.quick-btns .active[id^="btn-time"]');
    const prefs = {
        start: document.getElementById('start-battery').value,
        target: document.getElementById('target-battery').value,
        startTime: document.getElementById('start-time').value,
        endTime: document.getElementById('end-time').value,
        activeTimeBtnId: activeTimeBtn ? activeTimeBtn.id : 'btn-time-night',
        tariff: document.getElementById('tariff-config').value,
        syncTargetWithCar: document.getElementById('sync-target-with-car').checked
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

function syncTarget(val) {
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

// === 开始时间 / 结束时间各自独立的快捷预设 ===
// 单独改动其中一个，"谷电/午间"这两个组合预设就不一定还准了，所以顺手清掉它们的高亮(不清active本身没有功能影响，只是视觉上会显示误导)
function setStartTime(timeStr) {
    document.getElementById('start-time').value = timeStr;
    updateTimeBtnUI();
    saveSettings();
}

function setStartTimeNow() {
    const { hour, minute } = getEffectiveNow();
    setStartTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
}

function setEndTime(timeStr) {
    document.getElementById('end-time').value = timeStr;
    updateTimeBtnUI();
    saveSettings();
}

async function calculate() {
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
        current_minute: currMinute,
        tariff: document.getElementById('tariff-config').value
    });

    document.getElementById('normal-result').style.display = 'none';
    document.getElementById('warning-result').style.display = 'none';
    document.getElementById('loading').style.display = 'block';

    try {
        const response = await fetch(`/api/charge?${params.toString()}`);
        const data = await response.json();
        document.getElementById('loading').style.display = 'none';

        if (data.result.error) {
            if (data.result.error_code === 'UNREACHABLE_IN_WINDOW') {
                // == 时段内充不满：渲染完整的 fallback_stats + solutions 面板 ==
                document.getElementById('warning-result').style.display = 'block';

                const fb = data.result.fallback_stats;
                document.getElementById('warn-fallback-label').innerText = fb.label;
                document.getElementById('warn-reachable').innerText = fb.percent.toFixed(1) + '%';
                document.getElementById('warn-fallback-energy').innerText = fb.energy.toFixed(1) + ' kWh';
                document.getElementById('warn-fallback-cost').innerText = '¥ ' + fb.cost.toFixed(2);

                const ul = document.getElementById('warn-solutions-list');
                ul.innerHTML = '';

                data.result.solutions.forEach(sol => {
                    ul.innerHTML += `
                        <li style="margin-bottom: 14px; padding-left: 10px; border-left: 4px solid ${sol.color};">
                            <span style="background: ${sol.color}; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-right: 5px; vertical-align: text-bottom;">${sol.type}</span>
                            <strong style="color: var(--text-main); font-size: 1.05rem;">${sol.title}</strong>
                            <br><span style="font-size: 0.9rem; color: #6b7280;">${sol.desc}</span>
                        </li>`;
                });
            } else {
                // == 其它校验类错误（电量设反了 / 百分比越界 / 时间窗非法 / 无法求解）：没有 fallback_stats/solutions，简单提示即可 ==
                alert(data.result.error);
            }
        } else {
            // == 正常满电的状态渲染 ==
            document.getElementById('normal-result').style.display = 'block';
            document.getElementById('res-current').innerText = data.result.optimal_current + ' A';
            document.getElementById('res-duration').innerText = data.result.charging_duration + ' 小时';
            document.getElementById('res-power').innerText = data.result.effective_power_kw + ' kW';
            document.getElementById('res-loss').innerText = data.result.loss_percentage + ' %';
            document.getElementById('res-energy').innerText = data.result.energy_added.toFixed(1) + ' kWh';
            document.getElementById('res-cost').innerText = '¥ ' + data.result.cost.toFixed(2);
        }
    } catch (error) {
        alert('计算出错，请检查网络或后端配置。');
        document.getElementById('loading').style.display = 'none';
    }
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
    if (inputId === 'start-time' || inputId === 'end-time') updateTimeBtnUI();
    saveSettings();
}
