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
    document.getElementById('use-now').value = 'false';
    updateTimeBtnUI(btn);
    saveSettings();
}

function setNowAsStart(btn) {
    document.getElementById('use-now').value = 'true';
    const now = new Date();
    document.getElementById('start-time').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    updateTimeBtnUI(btn);
    saveSettings();
}

function updateTimeBtnUI(activeBtn) {
    document.querySelectorAll('[id^="btn-time"]').forEach(btn => btn.classList.remove('active'));
    if (activeBtn) activeBtn.classList.add('active');
}

async function calculate() {
    saveSettings(); 
    const start = document.getElementById('start-battery').value;
    const target = document.getElementById('target-battery').value;
    const startTime = document.getElementById('start-time').value.split(':');
    const endTime = document.getElementById('end-time').value.split(':');
    const useNow = document.getElementById('use-now').value;

    // 获取当前时间（真实 or 沙盒）
    const useMock = document.getElementById('enable-mock-time').checked;
    let currHour, currMinute;
    if (useMock) {
        const mockParts = document.getElementById('mock-time').value.split(':');
        currHour = parseInt(mockParts[0]);
        currMinute = parseInt(mockParts[1]);
    } else {
        const now = new Date();
        currHour = now.getHours();
        currMinute = now.getMinutes();
    }

    const params = new URLSearchParams({
        start: start,
        target: target,
        use_now: useNow,
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
            document.getElementById('warning-result').style.display = 'block';
            document.getElementById('warn-reachable').innerText = data.result.reachable_percentage.toFixed(1) + '%';
            
            const fb = data.result.fallback_stats;
            document.getElementById('warn-fallback-energy').innerText = fb.energy_added.toFixed(1) + ' kWh';
            document.getElementById('warn-fallback-cost').innerText = '¥ ' + fb.cost.toFixed(2);
            
            const ul = document.getElementById('warn-solutions-list');
            ul.innerHTML = ''; 
            
            // 动态渲染后端下发的最优方案
            data.result.solutions.forEach(sol => {
                ul.innerHTML += `
                    <li style="margin-bottom: 14px; padding-left: 10px; border-left: 4px solid ${sol.color};">
                        <span style="background: ${sol.color}; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; margin-right: 5px; vertical-align: text-bottom;">${sol.type}</span>
                        <strong style="color: var(--text-main); font-size: 1.05rem;">${sol.title}</strong>
                        <br><span style="font-size: 0.9rem; color: #6b7280;">${sol.desc}</span>
                    </li>`;
            });
        } else {
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
