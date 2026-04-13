<template>
    <BaseTab tab-name="autotune" @cleanup="onCleanup">
        <div class="content_wrapper">
            <div class="tab_title" v-html="$t('tabAutotune')"></div>

            <div class="autotune-spacer"></div>

            <!-- Import Section (always visible) -->
            <AutotuneImport />

            <!-- Analysis Results (visible after successful analysis) -->
            <template v-if="store.analysisState === 'done' && store.analysisResult">
                <BodePlot />
                <CurrentPids />
                <GainRecommendation />
            </template>
        </div>
    </BaseTab>
</template>

<script setup>
import { onUnmounted } from "vue";
import BaseTab from "./BaseTab.vue";
import AutotuneImport from "./autotune/AutotuneImport.vue";
import CurrentPids from "./autotune/CurrentPids.vue";
import BodePlot from "./autotune/BodePlot.vue";
import GainRecommendation from "./autotune/GainRecommendation.vue";
import { useAutotuneStore } from "@/stores/autotune";

const store = useAutotuneStore();

function onCleanup() {
    store.reset();
}

onUnmounted(() => {
    store.reset();
});
</script>

<style lang="less">
.tab-autotune {
    .bode-plot,
    .current-pids,
    .gain-recommendation,
    .autotune-import {
        margin-bottom: 25px !important;
    }
}
</style>
