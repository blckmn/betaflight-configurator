<template>
    <UiBox :title="$t('autotuneBodePlotTitle')">
        <!-- Axis checkboxes — centred -->
        <div class="flex justify-center gap-5">
            <label
                v-for="axis in AXES"
                :key="axis.key"
                class="flex items-center gap-1.5 cursor-pointer font-bold text-xs"
                :style="{ color: AXIS_COLORS[axis.key] }"
            >
                <input
                    type="checkbox"
                    class="cursor-pointer accent-current"
                    :checked="store.visibleAxes[axis.key]"
                    :disabled="!hasAxis(axis.key)"
                    @change="toggleAxis(axis.key, $event)"
                />
                {{ $t(axis.labelKey) }}
            </label>
        </div>

        <!-- Full-width overlaid charts -->
        <div ref="plotContainer" class="w-full">
            <svg ref="magnitudeSvg" class="bode-svg block w-full"></svg>
            <svg ref="phaseSvg" class="bode-svg block w-full"></svg>
        </div>
    </UiBox>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useAutotuneStore } from "@/stores/autotune";
import UiBox from "../../elements/UiBox.vue";
import * as d3 from "d3";

const store = useAutotuneStore();
const plotContainer = ref(null);
const magnitudeSvg = ref(null);
const phaseSvg = ref(null);

const AXIS_COLORS = { roll: "#e74c3c", pitch: "#2ecc71", yaw: "#3498db" };
const AXES = [
    { key: "roll", labelKey: "autotuneAxisRoll", colorClass: "toggle-roll" },
    { key: "pitch", labelKey: "autotuneAxisPitch", colorClass: "toggle-pitch" },
    { key: "yaw", labelKey: "autotuneAxisYaw", colorClass: "toggle-yaw" },
];

const margin = { top: 20, right: 30, bottom: 30, left: 55 };

let resizeObserver = null;

function hasAxis(key) {
    return !!store.analysisResult?.axes?.[key];
}

function toggleAxis(key, event) {
    const wouldBeChecked = event.target.checked;
    if (!wouldBeChecked) {
        // Count how many are currently checked
        const checkedCount = AXES.filter((a) => store.visibleAxes[a.key] && hasAxis(a.key)).length;
        if (checkedCount <= 1) {
            // Prevent unchecking the last one
            event.target.checked = true;
            return;
        }
    }
    store.visibleAxes[key] = wouldBeChecked;
}

onMounted(() => {
    resizeObserver = new ResizeObserver(() => drawPlots());
    if (plotContainer.value) resizeObserver.observe(plotContainer.value);
});

onUnmounted(() => resizeObserver?.disconnect());

watch(
    () => [store.visibleAxes.roll, store.visibleAxes.pitch, store.visibleAxes.yaw, store.analysisResult],
    () => nextTick(() => drawPlots()),
    { deep: true },
);

function getVisibleTraces() {
    if (!store.analysisResult?.axes) return [];
    return AXES.filter((a) => store.visibleAxes[a.key] && store.analysisResult.axes[a.key]).map((a) => {
        const tf = store.analysisResult.axes[a.key].transferFunction;
        const points = [];
        for (let i = 0; i < tf.frequencies.length; i++) {
            if (tf.frequencies[i] > 0) {
                points.push({
                    freq: tf.frequencies[i],
                    magnitude: tf.magnitude[i],
                    phase: tf.phase[i],
                    coherence: tf.coherence?.[i] ?? 1,
                });
            }
        }
        return { key: a.key, color: AXIS_COLORS[a.key], points };
    });
}

function drawPlots() {
    const traces = getVisibleTraces();
    if (!magnitudeSvg.value || !phaseSvg.value) return;

    const containerWidth = plotContainer.value?.clientWidth || 700;
    const svgHeight = 220;
    const width = containerWidth - margin.left - margin.right;
    const height = svgHeight - margin.top - margin.bottom;

    // Global frequency range
    let minFreq = Infinity,
        maxFreq = 0;
    for (const t of traces) {
        if (t.points.length) {
            minFreq = Math.min(minFreq, t.points[0].freq);
            maxFreq = Math.max(maxFreq, t.points[t.points.length - 1].freq);
        }
    }
    if (minFreq >= maxFreq) {
        minFreq = 1;
        maxFreq = 1000;
    }
    minFreq = Math.max(1, minFreq);

    const xScale = d3.scaleLog().domain([minFreq, maxFreq]).range([0, width]).clamp(true);

    drawMagnitude(traces, xScale, width, height, svgHeight, containerWidth);
    drawPhase(traces, xScale, width, height, svgHeight, containerWidth);
}

function drawMagnitude(traces, xScale, width, height, svgHeight, containerWidth) {
    const svg = d3.select(magnitudeSvg.value);
    svg.selectAll("*").remove();
    if (!traces.length) {
        svg.attr("width", 0).attr("height", 0);
        return;
    }
    svg.attr("width", containerWidth).attr("height", svgHeight);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    let yMin = Infinity,
        yMax = -Infinity;
    for (const t of traces) {
        for (const p of t.points) {
            if (isFinite(p.magnitude)) {
                yMin = Math.min(yMin, p.magnitude);
                yMax = Math.max(yMax, p.magnitude);
            }
        }
    }
    const pad = Math.max(3, (yMax - yMin) * 0.1);
    const yScale = d3
        .scaleLinear()
        .domain([yMin - pad, yMax + pad])
        .range([height, 0]);

    // Coherence shading from first trace
    drawCoherenceShading(g, traces[0].points, xScale, height);

    // 0 dB reference
    if (yScale.domain()[0] <= 0 && yScale.domain()[1] >= 0) {
        g.append("line")
            .attr("x1", 0)
            .attr("x2", width)
            .attr("y1", yScale(0))
            .attr("y2", yScale(0))
            .attr("stroke", "#999")
            .attr("stroke-dasharray", "4,3")
            .attr("stroke-width", 0.5);
        g.append("text")
            .attr("x", width + 4)
            .attr("y", yScale(0))
            .attr("dy", "0.35em")
            .attr("font-size", "10px")
            .attr("fill", "#999")
            .text("0 dB");
    }

    const line = d3
        .line()
        .x((d) => xScale(d.freq))
        .y((d) => yScale(d.magnitude))
        .curve(d3.curveMonotoneX);
    for (const t of traces) {
        g.append("path")
            .datum(t.points)
            .attr("fill", "none")
            .attr("stroke", t.color)
            .attr("stroke-width", 2)
            .attr("d", line);
    }

    g.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(xScale).ticks(8, "~s"));
    g.append("g").call(d3.axisLeft(yScale).ticks(5));
    g.append("text")
        .attr("transform", "rotate(-90)")
        .attr("y", -margin.left + 14)
        .attr("x", -height / 2)
        .attr("text-anchor", "middle")
        .attr("font-size", "11px")
        .attr("fill", "var(--surface-700)")
        .text("Magnitude (dB)");
}

function drawPhase(traces, xScale, width, height, svgHeight, containerWidth) {
    const svg = d3.select(phaseSvg.value);
    svg.selectAll("*").remove();
    if (!traces.length) {
        svg.attr("width", 0).attr("height", 0);
        return;
    }
    svg.attr("width", containerWidth).attr("height", svgHeight);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Unwrap phase per trace
    const unwrappedTraces = traces.map((t) => {
        const pts = [];
        for (let i = 0; i < t.points.length; i++) {
            if (i === 0) {
                pts.push({ ...t.points[i] });
            } else {
                let diff = t.points[i].phase - t.points[i - 1].phase;
                while (diff > 180) diff -= 360;
                while (diff < -180) diff += 360;
                pts.push({ ...t.points[i], phase: pts[i - 1].phase + diff });
            }
        }
        return { ...t, points: pts };
    });

    let yMin = Infinity,
        yMax = -Infinity;
    for (const t of unwrappedTraces) {
        for (const p of t.points) {
            if (isFinite(p.phase)) {
                yMin = Math.min(yMin, p.phase);
                yMax = Math.max(yMax, p.phase);
            }
        }
    }
    const pad = Math.max(10, (yMax - yMin) * 0.1);
    const yScale = d3
        .scaleLinear()
        .domain([yMin - pad, yMax + pad])
        .range([height, 0]);

    drawCoherenceShading(g, traces[0].points, xScale, height);

    // -180 deg reference
    if (yScale.domain()[0] <= -180 && yScale.domain()[1] >= -180) {
        g.append("line")
            .attr("x1", 0)
            .attr("x2", width)
            .attr("y1", yScale(-180))
            .attr("y2", yScale(-180))
            .attr("stroke", "#c0392b")
            .attr("stroke-dasharray", "4,3")
            .attr("stroke-width", 0.5);
        g.append("text")
            .attr("x", width + 4)
            .attr("y", yScale(-180))
            .attr("dy", "0.35em")
            .attr("font-size", "10px")
            .attr("fill", "#c0392b")
            .text("-180\u00B0");
    }

    const line = d3
        .line()
        .x((d) => xScale(d.freq))
        .y((d) => yScale(d.phase))
        .curve(d3.curveMonotoneX);
    for (const t of unwrappedTraces) {
        g.append("path")
            .datum(t.points)
            .attr("fill", "none")
            .attr("stroke", t.color)
            .attr("stroke-width", 2)
            .attr("d", line);
    }

    g.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(xScale).ticks(8, "~s"));
    g.append("g").call(d3.axisLeft(yScale).ticks(5));
    g.append("text")
        .attr("x", width / 2)
        .attr("y", height + margin.bottom - 4)
        .attr("text-anchor", "middle")
        .attr("font-size", "11px")
        .attr("fill", "var(--surface-700)")
        .text("Frequency (Hz)");
    g.append("text")
        .attr("transform", "rotate(-90)")
        .attr("y", -margin.left + 14)
        .attr("x", -height / 2)
        .attr("text-anchor", "middle")
        .attr("font-size", "11px")
        .attr("fill", "var(--surface-700)")
        .text("Phase (\u00B0)");
}

function drawCoherenceShading(g, points, xScale, height) {
    if (!points.length) return;
    let bandStart = 0;
    let prevHigh = points[0].coherence >= 0.5;
    for (let i = 1; i <= points.length; i++) {
        const isLast = i === points.length;
        const curHigh = isLast ? !prevHigh : points[i].coherence >= 0.5;
        if (curHigh !== prevHigh || isLast) {
            const x1 = xScale(points[bandStart].freq);
            const x2 = xScale(points[isLast ? i - 1 : i - 1].freq);
            g.append("rect")
                .attr("x", x1)
                .attr("y", 0)
                .attr("width", Math.max(0, x2 - x1))
                .attr("height", height)
                .attr("fill", prevHigh ? "#2ecc71" : "#e74c3c")
                .attr("opacity", 0.07);
            bandStart = i;
            prevHigh = curHigh;
        }
    }
}
</script>

<style>
.bode-svg {
    text {
        fill: var(--surface-700);
    }
    .tick text {
        font-size: 10px;
        fill: var(--surface-600);
    }
    .tick line,
    .domain {
        stroke: var(--surface-400);
    }
}
</style>
