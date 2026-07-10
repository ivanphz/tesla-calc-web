// 纯格式化工具，不涉及任何计算/业务逻辑。

// 12.5 -> "12:30"。转成整数分钟运算，规避浮点数残留和进位缺失；
// 对超出 [0, 24) 的输入（比如跨天累加出来的 32.5）也会正确抹平成 08:30。
export function formatTime(totalHours) {
    let totalMinutes = Math.round(totalHours * 60);
    totalMinutes = ((totalMinutes % 1440) + 1440) % 1440;

    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 1.483 -> "1小时29分"；0.5 -> "30分"
export function formatDuration(hours) {
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return h > 0 ? `${h}小时${m}分` : `${m}分`;
}
