// === 1. 页面加载初始化 ===
document.addEventListener('DOMContentLoaded', async () => {
    // A. 恢复本地历史配置（目标电量、时段等）
    const saved = localStorage.getItem('tesla_calc_prefs');
    if (saved) {
        const prefs = JSON.parse(saved);
        if (prefs.target) syncTarget(prefs.target);
        if (prefs.startTime) document.getElementById('start-time').value = prefs.startTime;
        if (prefs.endTime) document.getElementById('end-time').value = prefs.endTime;
        if (prefs.useNow) document.getElementById('use-now').value = prefs.useNow;
        // ... 在 if (saved) { ... } 里面加上：
        if (prefs.tariff) document.getElementById('tariff-config').value = prefs.tariff;
        if (prefs.activeTimeBtnId) {
            const btn = document.getElementById(prefs.activeTimeBtnId);
            if (btn) updateTimeBtnUI(btn);
        }
        // 起始电量先用本地兜底
        if (prefs.start) syncStart(prefs.start, false); 
    }

    // B. 页面加载时自动执行一次拉取
    await fetchRealTimeBattery();
});

// === 独立出来的：从云端拉取车机实时电量 ===
async function fetchRealTimeBattery() {
    const syncStatus = document.getElementById('sync-status');
    try {
        syncStatus.innerText = "(同步中...)";
        syncStatus.style.color = "#6b7280";
        
        // 加上时间戳防止浏览器缓存请求
        const response = await fetch(`/api/battery?t=${new Date().getTime()}`);
        const data = await response.json();
        
        if (data && typeof data.battery === 'number') {
            syncStart(data.battery, false); // false 表示这是系统同步，非手动
            syncStatus.innerText = "(✓ 实时车机数据)";
            syncStatus.style.color = "#10b981"; // 绿色成功
        } else {
            syncStatus.innerText = "(获取失败，使用本地记录)";
            syncStatus.style.color = "#f59e0b"; // 橙色
        }
    } catch (error) {
        syncStatus.innerText = "(无法连接云端，使用本地记录)";
        syncStatus.style.color = "#f59e0b"; // 橙色
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
        activeTimeBtnId: activeTimeBtn ? activeTimeBtn.id : 'btn-time-night'
        tariff: document.getElementById('tariff-config').value
    };
    localStorage.setItem('tesla_calc_prefs', JSON.stringify(prefs));
}

// === 2. 起始电量同步逻辑 (大步进器) ===
function syncStart(val, manual = true) {
    let v = parseInt(val);
    if (isNaN(v)) v = 0;
    if (v < 0) v = 0;
    if (v > 99) v = 99;

    document.getElementById('start-battery').value = v;
    saveSettings();
    
    // 如果是手动点击修改的，去掉“实时数据”标签，避免误导
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

// === 3. 目标电量同步逻辑 (滑块 + 1%步进 + 预设) ===
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

// === 4. 时间段设置逻辑 ===
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
        tariff: document.getElementById('tariff-config').value // 传给后端
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
            document.getElementById('warn-early').innerText = data.result.early_start_time;
            document.getElementById('warn-late').innerText = data.result.late_end_time;
            
            // 渲染保底方案
            const fb = data.result.fallback_stats;
            document.getElementById('warn-fallback-current').innerText = fb.current + ' A';
            document.getElementById('warn-fallback-cost').innerText = '¥ ' + fb.cost.toFixed(2);
            document.getElementById('warn-fallback-energy').innerText = fb.energy_added.toFixed(1) + ' kWh';
        } else {
            // == 正常满电的状态渲染 ==
            document.getElementById('normal-result').style.display = 'block';
            document.getElementById('res-current').innerText = data.result.optimal_current + ' A';
            document.getElementById('res-duration').innerText = data.result.charging_duration + ' 小时';
            document.getElementById('res-power').innerText = data.result.effective_power_kw + ' kW';
            document.getElementById('res-loss').innerText = data.result.loss_percentage + ' %';
            
            // 渲染新增的电量和费用
            document.getElementById('res-energy').innerText = data.result.energy_added.toFixed(1) + ' kWh';
            document.getElementById('res-cost').innerText = '¥ ' + data.result.cost.toFixed(2);
        }
    } catch (error) {
        alert('计算出错，请检查网络或后端配置。');
        document.getElementById('loading').style.display = 'none';
    }
