// === 1. 页面加载时恢复历史设置 ===
document.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('tesla_calc_prefs');
    if (saved) {
        const prefs = JSON.parse(saved);
        
        // 恢复电量
        if (prefs.start) document.getElementById('start-battery').value = prefs.start;
        if (prefs.target) syncTarget(prefs.target);
        
        // 恢复时间
        if (prefs.startTime) document.getElementById('start-time').value = prefs.startTime;
        if (prefs.endTime) document.getElementById('end-time').value = prefs.endTime;
        if (prefs.useNow) document.getElementById('use-now').value = prefs.useNow;
        
        // 恢复高亮按钮
        if (prefs.activeTimeBtnId) {
            const btn = document.getElementById(prefs.activeTimeBtnId);
            if (btn) updateTimeBtnUI(btn);
        }
    }
});

// === 2. 保存设置到本地 ===
function saveSettings() {
    // 找出当前激活的时间按钮（谷电/午间/从现在开始）
    const timeBtnsContainer = document.getElementById('btn-time-night').parentElement;
    const activeTimeBtn = timeBtnsContainer.querySelector('.active');
    
    const prefs = {
        start: document.getElementById('start-battery').value,
        target: document.getElementById('target-slider').value,
        startTime: document.getElementById('start-time').value,
        endTime: document.getElementById('end-time').value,
        useNow: document.getElementById('use-now').value,
        activeTimeBtnId: activeTimeBtn ? activeTimeBtn.id : 'btn-time-night'
    };
    
    localStorage.setItem('tesla_calc_prefs', JSON.stringify(prefs));
}

// === 3. UI 交互逻辑 ===
function adjustStart(delta) {
    const input = document.getElementById('start-battery');
    let val = parseInt(input.value) + delta;
    if(val >= 0 && val < 100) {
        input.value = val;
        saveSettings(); // 数值变动，保存记忆
    }
}

function syncTarget(val) {
    document.getElementById('target-slider').value = val;
    document.getElementById('target-val-display').innerText = val + '%';
    
    document.querySelectorAll('#target-presets button').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.innerText) === parseInt(val));
    });
    saveSettings(); // 数值变动，保存记忆
}

function setTimeSlot(start, end, btn) {
    document.getElementById('start-time').value = start;
    document.getElementById('end-time').value = end;
    document.getElementById('use-now').value = 'false';
    updateTimeBtnUI(btn);
    saveSettings(); // 数值变动，保存记忆
}

function setNowAsStart(btn) {
    document.getElementById('use-now').value = 'true';
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    document.getElementById('start-time').value = `${hh}:${mm}`;
    updateTimeBtnUI(btn);
    saveSettings(); // 数值变动，保存记忆
}

function updateTimeBtnUI(activeBtn) {
    document.getElementById('btn-time-night').classList.remove('active');
    document.getElementById('btn-time-noon').classList.remove('active');
    document.getElementById('btn-time-now').classList.remove('active');
    if (activeBtn) activeBtn.classList.add('active');
}

// === 4. API 请求与计算逻辑 ===
async function calculate() {
    // 点击计算时，做一次兜底保存
    saveSettings(); 

    const start = document.getElementById('start-battery').value;
    const target = document.getElementById('target-slider').value;
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
        end_minute: endTime[1]
    });

    document.getElementById('normal-result').style.display = 'none';
    document.getElementById('warning-result').style.display = 'none';
    document.getElementById('loading').style.display = 'block';

    try {
        const response = await fetch(`/api/charge?${params.toString()}`);
        const data = await response.json();
        document.getElementById('loading').style.display = 'none';

        if (data.result.error) {
            // 触发警告状态
            document.getElementById('warning-result').style.display = 'block';
            document.getElementById('warn-reachable').innerText = data.result.reachable_percentage.toFixed(1) + '%';
            document.getElementById('warn-early').innerText = data.result.early_start_time;
            document.getElementById('warn-late').innerText = data.result.late_end_time;
        } else {
            // 正常显示结果
            document.getElementById('normal-result').style.display = 'block';
            document.getElementById('res-current').innerText = data.result.optimal_current + ' A';
            document.getElementById('res-duration').innerText = data.result.charging_duration + ' 小时';
            document.getElementById('res-power').innerText = data.result.effective_power_kw + ' kW';
            document.getElementById('res-loss').innerText = data.result.loss_percentage + ' %';
        }
    } catch (error) {
        alert('计算出错，请检查网络或后端配置。');
        document.getElementById('loading').style.display = 'none';
    }
}
