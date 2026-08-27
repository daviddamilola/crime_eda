const PAGE_BACKGROUND = "#06101a";
const CHART_SURFACE = "#0d1b25";
const GRIDLINE = "#1e3a49";
const TEXT_PRIMARY = "#e6f0f4";
const TEXT_SECONDARY = "#8ba3af";
const REFERENCE_LINE = "#c4552e";
function niceTicks(lo, hi, count) {
    if (hi <= lo)
        return [lo];
    const step = (hi - lo) / count;
    const ticks = [];
    for (let i = 0; i <= count; i++)
        ticks.push(lo + step * i);
    return ticks;
}
export function drawChart(canvas, opts) {
    const ctx = canvas.getContext("2d");
    if (!ctx)
        return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 400;
    const cssHeight = canvas.clientHeight || 240;
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const paddingLeft = 58;
    const paddingRight = 14;
    const paddingTop = 26;
    const paddingBottom = opts.showXLabel ? 32 : 16;
    const plotWidth = Math.max(cssWidth - paddingLeft - paddingRight, 10);
    const plotHeight = Math.max(cssHeight - paddingTop - paddingBottom, 10);
    const allValues = opts.series.flatMap((s) => s.data).concat([opts.referenceValue]);
    const lo = Math.min(...allValues);
    const hi = Math.max(...allValues);
    const pad = (hi - lo) * 0.18 || 1;
    const yMin = lo - pad;
    const yMax = hi + pad;
    const lastT = opts.t.length ? opts.t[opts.t.length - 1] : 0;
    const xMax = Math.max(lastT * 1.12, 4);
    const xMin = 0;
    const scaleX = (x) => paddingLeft + ((x - xMin) / (xMax - xMin || 1)) * plotWidth;
    const scaleY = (y) => paddingTop + (1 - (y - yMin) / (yMax - yMin || 1)) * plotHeight;
    // page + chart surface backgrounds
    ctx.fillStyle = PAGE_BACKGROUND;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = CHART_SURFACE;
    ctx.fillRect(paddingLeft, paddingTop, plotWidth, plotHeight);
    // gridlines + y ticks
    const yTicks = niceTicks(yMin, yMax, 4);
    ctx.strokeStyle = GRIDLINE;
    ctx.lineWidth = 1;
    ctx.fillStyle = TEXT_SECONDARY;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tick of yTicks) {
        const y = scaleY(tick);
        ctx.beginPath();
        ctx.moveTo(paddingLeft, y);
        ctx.lineTo(paddingLeft + plotWidth, y);
        ctx.stroke();
        const label = opts.tickFormatter ? opts.tickFormatter(tick) : Math.round(tick).toLocaleString();
        ctx.fillText(label, paddingLeft - 8, y);
    }
    // x ticks
    const xTicks = niceTicks(xMin, xMax, 5);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const tick of xTicks) {
        const x = scaleX(tick);
        ctx.beginPath();
        ctx.moveTo(x, paddingTop);
        ctx.lineTo(x, paddingTop + plotHeight);
        ctx.stroke();
        if (opts.showXLabel) {
            ctx.fillText(Math.round(tick).toString(), x, paddingTop + plotHeight + 6);
        }
    }
    if (opts.showXLabel) {
        ctx.fillText("weeks elapsed", paddingLeft + plotWidth / 2, paddingTop + plotHeight + 18);
    }
    // reference (2022) line
    ctx.strokeStyle = REFERENCE_LINE;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.2;
    const refY = scaleY(opts.referenceValue);
    ctx.beginPath();
    ctx.moveTo(paddingLeft, refY);
    ctx.lineTo(paddingLeft + plotWidth, refY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = REFERENCE_LINE;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillText(opts.referenceLabel, paddingLeft + plotWidth - 4, refY - 2);
    // clip to plot area for the data series
    ctx.save();
    ctx.beginPath();
    ctx.rect(paddingLeft, paddingTop, plotWidth, plotHeight);
    ctx.clip();
    for (const series of opts.series) {
        if (series.data.length === 0)
            continue;
        ctx.strokeStyle = series.color;
        ctx.lineWidth = series.lineWidth ?? 2;
        ctx.setLineDash(series.dashed ? [7, 5] : []);
        ctx.beginPath();
        for (let i = 0; i < series.data.length; i++) {
            const x = scaleX(opts.t[i] ?? 0);
            const y = scaleY(series.data[i]);
            if (i === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }
    ctx.restore();
    // highlighted current-value dot + tag
    for (const series of opts.series) {
        if (!series.highlightLast || series.data.length === 0)
            continue;
        const lastIndex = series.data.length - 1;
        const x = scaleX(opts.t[lastIndex] ?? 0);
        const y = scaleY(series.data[lastIndex]);
        ctx.fillStyle = series.color;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = CHART_SURFACE;
        ctx.lineWidth = 2;
        ctx.stroke();
        const value = series.data[lastIndex];
        const label = series.valueFormatter ? series.valueFormatter(value) : Math.round(value).toLocaleString();
        ctx.fillStyle = TEXT_PRIMARY;
        ctx.font = "11px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, Math.min(x + 9, cssWidth - paddingRight - 4), y);
    }
    // title
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.font = "bold 12px -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(opts.title, paddingLeft, 16);
}
//# sourceMappingURL=chart.js.map