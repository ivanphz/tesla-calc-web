// === 1. 页面加载初始化 ===
document.addEventListener('DOMContentLoaded', async () => {
    const saved = localStorage.getItem('tesla_calc_prefs');
    if (saved) {
        const prefs = JSON.parse(saved);
        if (prefs.target) syncTarget(prefs.target);
        if (prefs.startTime) document.getElementById('start-time').value = prefs.startTime;
        if (prefs.endTime) document.getElementById('end-time').value = prefs.endTime;
        if (prefs.useNow) document.getElementById('use-now').value = prefs.useNow;
        if (prefs.tariff) document.getElementById('tariff-config').value = prefs.tariff;
        
        if (prefs.activeTimeBtnId) {
            const btn = document.getElementById(prefs.activeTimeBtnId);
            if (btn) updateTimeBtnUI(btn);
        }
        if (prefs.start) syncStart(prefs.start, false); 
    }

    await fetchRealTimeBattery();
});

// === 从云端拉取车机实时电量 ===
async function fetchRealTimeBattery() {
    const syncStatus = document.getElementById('sync-status');
    try {
        syncStatus.innerText = "(同步中...)";
        syncStatus.style.color = "#6b7280";
        
        const response = await fetch(`/api/battery?t=${new Date().getTime()}`);
        const data = await response.json();
        
        if (data && typeof data.battery === 'number') {
            syncStart(data.battery, false);
            syncStatus.innerText = "(✓ 实时车机数据)";
            syncStatus.style.color = "#10b981";
        } else {
            syncStatus.innerText = "(获取失败，使用本地记录)";
            syncStatus.style.color = "#f59e0b";
        }
    } catch (error) {
        syncStatus.innerText = "(无法连接云端，使用本地记录)";
        syncStatus.style.color = "#f59e0b";
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
        useNow: document.getElementById('use-now').value,
        activeTimeBtnId: activeTimeBtn ? activeTimeBtn.id : 'btn-time-night',
        tariff: document.getElementById('tariff-config').value
    };
    localStorage.setItem('tesla_calc_prefs', JSON.stringify(prefs));
}

// === 2. 起始电量同步 ===
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

// === 3. 目标电量同步 ===
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

// === 4. 时间段设置 ===
function setTimeSlot(start, end, btn) {
    document.getElementById('start-time').value = start;
    document.getElementById('end-time').value = end;
    document.getElementById('use-now').value = 'false';
    updateTimeBtnUI(btn);
    saveSettings();
}

function setNowAsStart(btn) {
    document.getElementById('use-now').value = 'true';
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    document.getElementById('start-time').value = `${hh}:${mm}`;
    updateTimeBtnUI(btn);
    saveSettings();
}

function updateTimeBtnUI(activeBtn) {
    document.querySelectorAll('[id^="btn-time"]').forEach(btn => btn.classList.remove('active'));
    if (activeBtn) activeBtn.classList.add('active');
}

// === 5. 调用后端计算 API ===
async function calculate() {
    saveSettings(); 

    const start = document.getElementById('start-battery').value;
    const target = document.getElementById('target-battery').value;
    const startTime = document.getElementById('start-time').value.split(':');
    const endTime = document.getElementById('end-time').value.split(':');
    const useNow = document.getElementById('use-now').value;

    const params = new URLSearchParams({
        start: start,
        target: target,
        use_now: useNow,
        start_hour: startTime[0],
        start_minute: startTime[1],
        end_hour: endTime[0],
        end_minute: endTime[1],
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
            // == 充不满的状态渲染 ==
            document.getElementById('warning-result').style.display = 'block';
            document.getElementById('warn-reachable').innerText = data.result.reachable_percentage.toFixed(1) + '%';
            
            const fb = data.result.fallback_stats;
            document.getElementById('warn-fallback-energy').innerText = fb.energy_added.toFixed(1) + ' kWh';
            document.getElementById('warn-fallback-cost').innerText = '¥ ' + fb.cost.toFixed(2);
            
            // 动态判定展示方案
            const ul = document.getElementById('warn-solutions-list');
            ul.innerHTML = ''; 

            if (useNow === 'true') {
                // 场景二：即插即充（彻底隐藏提前方案，只推荐延后）
                ul.innerHTML = `
                    <li style="margin-bottom: 8px; padding-left: 10px; border-left: 3px solid var(--primary);">
                        <strong style="color: var(--text-main);">持续满载充电至 ${data.result.late_end_time} 结束</strong> 
                        <br><span style="font-size: 0.9rem; color: #6b7280;">(当前时间无法提前，已包含跨越时段的电价) 充满总费用：<strong style="color: #10b981;">¥ ${data.result.cost_late_end.toFixed(2)}</strong></span>
                    </li>`;
            } else {
                // 场景一：预约充电（重点推荐提前方案A，备选展示延后方案B）
                ul.innerHTML = `
                    <li style="margin-bottom: 14px; padding-left: 10px; border-left: 4px solid var(--primary);">
                        <span style="background: var(--primary); color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-right: 5px; vertical-align: text-bottom;">优选</span>
                        <strong style="color: var(--text-main); font-size: 1.05rem;">提前至 ${data.result.early_start_time} 预约开始</strong>
                        <br><span style="font-size: 0.9rem; color: #6b7280;">(到点自动断电。提前的时段已计入实时电价) 充满总费用：<strong style="color: #10b981;">¥ ${data.result.cost_early_start.toFixed(2)}</strong></span>
                    </li>
                    <li style="padding-left: 10px; border-left: 4px solid #d1d5db; opacity: 0.8;">
                        <span style="background: #d1d5db; color: #374151; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-right: 5px; vertical-align: text-bottom;">备选</span>
                        <strong style="color: var(--text-main);">延后至 ${data.result.late_end_time} 结束</strong>
                        <br><span style="font-size: 0.9rem; color: #6b7280;">(保持预约时间不变，早晨不拔枪) 充满总费用：<strong style="color: #10b981;">¥ ${data.result.cost_late_end.toFixed(2)}</strong></span>
                    </li>`;
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
