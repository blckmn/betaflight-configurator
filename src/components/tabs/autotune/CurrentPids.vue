<template>
    <div class="gui_box current-pids">
        <div class="gui_box_titlebar">
            <div class="spacer_box_title">Current PIDs (from log)</div>
        </div>
        <div class="spacer">
            <table v-if="rows.length" class="pids-table">
                <thead>
                    <tr>
                        <th></th>
                        <th></th>
                        <th v-for="axis in availableAxes" :key="axis.key" :style="{ color: axis.color }">
                            {{ axis.label }}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in rows" :key="row.key">
                        <td class="row-label">{{ row.label }}</td>
                        <td></td>
                        <td v-for="axis in availableAxes" :key="axis.key">
                            {{ row.values[axis.key] ?? "--" }}
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script setup>
import { computed } from "vue";
import { useAutotuneStore } from "@/stores/autotune";

const store = useAutotuneStore();

const AXIS_DEFS = [
    { key: "roll", label: "Roll", color: "#e74c3c", pidKey: "rollPID" },
    { key: "pitch", label: "Pitch", color: "#2ecc71", pidKey: "pitchPID" },
    { key: "yaw", label: "Yaw", color: "#3498db", pidKey: "yawPID" },
];

const PID_ROWS = [
    { key: "P", index: 0, label: "P" },
    { key: "I", index: 1, label: "I" },
    { key: "D", index: 2, label: "D" },
];

const availableAxes = computed(() => {
    if (!store.analysisResult?.axes) return [];
    return AXIS_DEFS.filter((a) => store.analysisResult.axes[a.key]);
});

const rows = computed(() => {
    const sc = store.analysisResult?.sysConfig;
    if (!sc) return [];

    return PID_ROWS.map((r) => {
        const values = {};
        for (const a of availableAxes.value) {
            const pid = sc[a.pidKey];
            if (pid) {
                values[a.key] = pid[r.index];
            }
        }
        return { key: r.key, label: r.label, values };
    });
});
</script>

<style lang="less">
.current-pids {
    .pids-table {
        border-collapse: collapse;

        th,
        td {
            padding: 5px 16px;
            text-align: left;
            border-bottom: 1px solid var(--surface-200);
            font-size: 12px;
        }

        th {
            font-weight: bold;
        }

        .row-label {
            font-weight: bold;
            color: var(--surface-700);
        }
    }
}
</style>
