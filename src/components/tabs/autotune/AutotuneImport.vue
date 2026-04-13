<template>
    <div class="gui_box autotune-import">
        <div class="gui_box_titlebar">
            <div class="spacer_box_title" v-html="$t('autotuneImportTitle')"></div>
        </div>
        <div class="spacer">
            <!-- Idle / ready to import -->
            <div v-if="store.analysisState === 'idle'" class="import-prompt">
                <p v-html="$t('autotuneImportDescription')"></p>
                <div class="default_btn">
                    <a href="#" @click.prevent="importAndAnalyze">{{ $t("autotuneImportButton") }}</a>
                </div>
            </div>

            <!-- In-progress (importing or analyzing) -->
            <div
                v-if="store.analysisState === 'importing' || store.analysisState === 'analyzing'"
                class="import-progress"
            >
                <div class="progress-spinner"></div>
                <span class="progress-text">{{ store.progressMessage }}</span>
            </div>

            <!-- Error -->
            <div v-if="store.analysisState === 'error'" class="import-error">
                <p class="error-message">{{ store.errorMessage }}</p>
                <div class="default_btn">
                    <a href="#" @click.prevent="importAndAnalyze">{{ $t("autotuneImportRetry") }}</a>
                </div>
            </div>

            <!-- Done / summary -->
            <div v-if="store.analysisState === 'done' && store.analysisResult" class="import-summary">
                <div class="summary-row">
                    <div class="summary-grid">
                        <div class="summary-item">
                            <span class="summary-label" v-html="$t('autotuneFile')"></span>
                            <span class="summary-value">{{ store.analysisResult.filename }}</span>
                        </div>
                        <div class="summary-item">
                            <span class="summary-label" v-html="$t('autotuneSampleRate')"></span>
                            <span class="summary-value">{{ store.analysisResult.sampleRate }} Hz</span>
                        </div>
                        <div class="summary-item">
                            <span class="summary-label" v-html="$t('autotuneAxesDetected')"></span>
                            <span class="summary-value">{{ detectedAxes }}</span>
                        </div>
                    </div>
                    <div class="default_btn">
                        <a href="#" @click.prevent="importAndAnalyze">{{ $t("autotuneImportAnother") }}</a>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed } from "vue";
import { useAutotuneStore } from "@/stores/autotune";
import { useAutotune } from "@/composables/useAutotune";

const store = useAutotuneStore();
const { importAndAnalyze } = useAutotune();

const detectedAxes = computed(() => {
    if (!store.analysisResult?.axes) {
        return "";
    }
    return Object.keys(store.analysisResult.axes)
        .map((a) => a.charAt(0).toUpperCase() + a.slice(1))
        .join(", ");
});
</script>

<style lang="less">
.autotune-import {
    margin-bottom: 15px;

    .default_btn {
        width: auto;
        float: none;
        display: inline-block;

        a {
            padding-left: 12px;
            padding-right: 12px;
        }
    }

    .import-prompt {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 15px;

        p {
            margin: 0;
        }
    }

    .import-progress {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 0;

        .progress-spinner {
            width: 20px;
            height: 20px;
            border: 3px solid var(--surface-300);
            border-top-color: var(--primary-500);
            border-radius: 50%;
            animation: autotune-spin 0.8s linear infinite;
        }

        .progress-text {
            color: var(--surface-700);
        }
    }

    .import-error {
        .error-message {
            color: var(--danger-500, #e74c3c);
            margin-bottom: 10px;
            font-weight: bold;
        }
    }

    .import-summary {
        .summary-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 15px;
        }

        .summary-grid {
            display: flex;
            gap: 20px;
            flex: 1;
        }

        .summary-item {
            display: flex;
            flex-direction: column;

            .summary-label {
                font-size: 0.85em;
                color: var(--surface-600);
            }

            .summary-value {
                font-weight: bold;
                color: var(--surface-900);
            }
        }
    }
}

@keyframes autotune-spin {
    to {
        transform: rotate(360deg);
    }
}
</style>
