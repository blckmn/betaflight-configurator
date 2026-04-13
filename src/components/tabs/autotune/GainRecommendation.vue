<template>
    <div class="gui_box gain-recommendation">
        <div class="gui_box_titlebar">
            <div class="spacer_box_title" v-html="$t('autotuneGainTitle')"></div>
        </div>
        <div class="spacer">
            <div v-if="visibleAxisList.length" class="recommendation-table-wrapper">
                <table class="recommendation-table">
                    <!-- Axis group headers -->
                    <thead>
                        <tr class="axis-header-row">
                            <th></th>
                            <th></th>
                            <th
                                v-for="axis in visibleAxisList"
                                :key="axis.key"
                                :style="{ color: axis.color }"
                                class="axis-group-header"
                            >
                                {{ axis.label }}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="row in tableRows" :key="row.key">
                            <!-- Spacer + column sub-headers before the sliders section -->
                            <tr v-if="row.columnHeaders" class="spacer-row">
                                <td :colspan="2 + visibleAxisList.length"></td>
                            </tr>
                            <tr v-if="row.columnHeaders" class="column-header-row">
                                <th></th>
                                <th>{{ $t("autotuneCurrent") }}</th>
                                <th v-for="axis in visibleAxisList" :key="axis.key">
                                    {{ $t("autotuneProposed") }}
                                </th>
                            </tr>
                            <tr v-if="row.sectionTitle" class="section-title-row">
                                <td :colspan="2 + visibleAxisList.length">{{ row.sectionTitle }}</td>
                            </tr>
                            <tr :class="{ 'section-divider': row.divider && !row.sectionTitle }">
                                <td class="row-label">{{ row.label }}</td>
                                <td class="value-current">{{ row.current }}</td>
                                <td
                                    v-for="axis in visibleAxisList"
                                    :key="axis.key"
                                    :class="changeClass(row.axes[axis.key]?.changePct)"
                                >
                                    <template v-if="row.axes[axis.key]">
                                        {{ row.axes[axis.key].value }}
                                        <span v-if="row.axes[axis.key].changePct != null" class="change-suffix">
                                            ({{ formatChangePct(row.axes[axis.key].changePct) }})
                                        </span>
                                    </template>
                                    <template v-else>--</template>
                                </td>
                            </tr>
                        </template>
                    </tbody>
                </table>
            </div>

            <!-- Apply Button -->
            <div class="apply-section">
                <div class="default_btn apply-btn">
                    <a href="#" :class="{ disabled: !isConnected || !visibleAxisList.length }" @click.prevent="onApply">
                        {{ $t("autotuneApplyGains") }}
                    </a>
                </div>
                <span v-if="!isConnected" class="apply-hint" v-html="$t('autotuneConnectRequired')"></span>
                <span v-if="applied" class="apply-success" v-html="$t('autotuneApplied')"></span>
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { useAutotuneStore } from "@/stores/autotune";
import { useConnectionStore } from "@/stores/connection";
import { useAutotune } from "@/composables/useAutotune";

const store = useAutotuneStore();
const connectionStore = useConnectionStore();
const { applyGains } = useAutotune();

const applied = ref(false);

const isConnected = computed(() => connectionStore.connectionValid);

const AXIS_DEFS = [
    { key: "roll", label: "Roll", color: "#e74c3c" },
    { key: "pitch", label: "Pitch", color: "#2ecc71" },
    { key: "yaw", label: "Yaw", color: "#3498db" },
];

const ANALYSIS_FIELDS = [
    { key: "bandwidth", configKey: null, label: "Bandwidth", format: formatHz },
    { key: "phaseMargin", configKey: null, label: "Phase Margin", format: formatDeg },
    { key: "resonantPeak", configKey: null, label: "Resonant Peak", format: formatDb },
    { key: "coherencePct", configKey: null, label: "Coherence", format: formatPct },
];

const SLIDER_FIELDS = [
    { key: "slider_pi_gain", configKey: "simplified_pi_gain", label: "P / I Gain" },
    { key: "slider_i_gain", configKey: "simplified_i_gain", label: "I Gain" },
    { key: "slider_d_gain", configKey: "simplified_d_gain", label: "D Gain" },
    { key: "slider_feedforward_gain", configKey: "simplified_feedforward_gain", label: "Feedforward" },
    { key: "slider_dterm_filter_multiplier", configKey: "simplified_dterm_filter_multiplier", label: "D-Term Filter" },
];

const visibleAxisList = computed(() => {
    if (!store.analysisResult?.axes) return [];
    return AXIS_DEFS.filter((a) => store.analysisResult.axes[a.key]);
});

const tableRows = computed(() => {
    const axes = store.analysisResult?.axes;
    const sc = store.analysisResult?.sysConfig;
    if (!axes || !sc) return [];

    const rows = [];

    // Analysis section
    for (let i = 0; i < ANALYSIS_FIELDS.length; i++) {
        const f = ANALYSIS_FIELDS[i];
        const perAxis = {};
        for (const a of visibleAxisList.value) {
            const val = axes[a.key]?.gains?.[f.key];
            if (val != null) {
                perAxis[a.key] = { value: f.format(val), changePct: null };
            }
        }
        rows.push({
            key: `analysis-${f.key}`,
            label: f.label,
            current: "",
            axes: perAxis,
            section: i === 0,
            divider: i === 0,
            sectionTitle: i === 0 ? "Analysis" : null,
        });
    }

    // Proposed slider section
    for (let i = 0; i < SLIDER_FIELDS.length; i++) {
        const f = SLIDER_FIELDS[i];
        const current = sc[f.configKey] ?? 100;
        const perAxis = {};
        for (const a of visibleAxisList.value) {
            const proposed = axes[a.key]?.gains?.proposed?.[f.key];
            if (proposed != null) {
                const changePct = current !== 0 ? ((proposed - current) / current) * 100 : 0;
                perAxis[a.key] = { value: proposed, changePct };
            }
        }
        rows.push({
            key: `slider-${f.key}`,
            label: f.label,
            current,
            axes: perAxis,
            section: i === 0,
            divider: i === 0,
            sectionTitle: i === 0 ? "Proposed Sliders" : null,
            columnHeaders: i === 0,
        });
    }

    return rows;
});

function changeClass(pct) {
    if (pct == null) return "";
    if (pct > 5) return "change-increase";
    if (pct < -5) return "change-decrease";
    return "change-none";
}

function formatHz(v) {
    return v != null ? `${v.toFixed(1)} Hz` : "--";
}
function formatDeg(v) {
    return v != null ? `${v.toFixed(1)}\u00B0` : "--";
}
function formatDb(v) {
    return v != null ? `${v.toFixed(1)} dB` : "--";
}
function formatPct(v) {
    return v != null ? `${v.toFixed(0)}%` : "--";
}

function formatChangePct(v) {
    if (v == null || v === 0) return "--";
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toFixed(0)}%`;
}

async function onApply() {
    if (!isConnected.value) return;
    const firstAxis = visibleAxisList.value[0];
    if (!firstAxis) return;
    const proposed = store.analysisResult.axes[firstAxis.key]?.gains?.proposed;
    if (!proposed) return;
    await applyGains(proposed);
    applied.value = true;
}
</script>

<style lang="less">
.gain-recommendation {
    .recommendation-table-wrapper {
        overflow-x: auto;
        margin-bottom: 12px;
    }

    .recommendation-table {
        width: 100%;
        border-collapse: collapse;

        th,
        td {
            padding: 5px 10px;
            text-align: left;
            border-bottom: 1px solid var(--surface-200);
            font-size: 12px;
        }

        th {
            font-weight: bold;
            color: var(--surface-700);
        }

        .axis-group-header {
            font-size: 13px;
            font-weight: bold;
            border-bottom: 2px solid var(--surface-300);
        }

        .row-label {
            color: var(--surface-700);
        }

        .section-label {
            font-weight: bold;
        }

        .spacer-row td {
            height: 12px;
            padding: 0;
            border: none;
        }

        .column-header-row th {
            font-weight: bold;
            font-size: 11px;
            color: var(--surface-700);
            padding-top: 10px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--surface-300);
        }

        .section-title-row td {
            font-weight: bold;
            font-size: 11px;
            color: var(--surface-500);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding-top: 10px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--surface-300);
        }

        .section-divider td {
            border-top: 2px solid var(--surface-300);
        }

        .value-current {
            color: var(--surface-500);
        }

        .change-suffix {
            font-size: 10px;
            opacity: 0.8;
        }

        .change-increase {
            color: #2ecc71;
            font-weight: bold;
        }
        .change-decrease {
            color: #e74c3c;
            font-weight: bold;
        }
        .change-none {
            color: var(--surface-600);
        }
    }

    .apply-section {
        display: flex;
        align-items: center;
        gap: 15px;

        .apply-btn {
            width: auto;
            float: none;
            display: inline-block;
            min-width: 140px;

            a {
                padding-left: 12px;
                padding-right: 12px;
            }
        }

        .apply-hint {
            font-size: 0.9em;
            color: var(--surface-500);
        }

        .apply-success {
            font-size: 0.9em;
            color: #2ecc71;
            font-weight: bold;
        }
    }
}
</style>
