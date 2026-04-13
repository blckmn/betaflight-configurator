import { useAutotuneStore } from "@/stores/autotune";
import FC from "@/js/fc";
import MSP from "@/js/msp";
import MSPCodes from "@/js/msp/MSPCodes";
import { mspHelper } from "@/js/msp/MSPHelper";
import { findLogBoundaries, parseChirpLog } from "@/js/blackbox/chirp_bbl_parser";
import { welchTransferFunction, recommendGains } from "@/js/blackbox/spectral_analysis";

/**
 * Composable providing autotune import and gain-apply logic.
 */
export function useAutotune() {
    const store = useAutotuneStore();

    async function importAndAnalyze() {
        store.analysisState = "importing";
        store.errorMessage = "";
        store.progressMessage = "Selecting file...";

        let file;
        try {
            file = await pickFile();
        } catch {
            store.analysisState = "idle";
            store.progressMessage = "";
            return;
        }

        if (!file) {
            store.analysisState = "idle";
            store.progressMessage = "";
            return;
        }

        try {
            store.progressMessage = `Reading ${file.name}...`;
            const arrayBuffer = await file.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);

            store.analysisState = "analyzing";
            store.progressMessage = "Finding log boundaries...";
            const logs = findLogBoundaries(data);

            if (!logs || logs.length === 0) {
                throw new Error("No log segments found in the file.");
            }

            // Try each log until we find one with chirp data
            let result = null;
            let lastError = null;

            for (let idx = 0; idx < logs.length; idx++) {
                store.progressMessage = `Parsing log ${idx + 1} of ${logs.length}...`;
                try {
                    const { sysConfig, chirpData } = parseChirpLog(data, logs[idx].start, logs[idx].end);

                    if (chirpData.sampleCount === 0 || chirpData.segments.length === 0) {
                        continue;
                    }

                    // Compute sample rate from header
                    const looptimeUs = sysConfig.looptime || 125;
                    const pidDenom = sysConfig.pid_process_denom || 1;
                    const bbRate = sysConfig.frameIntervalPDenom || 1;
                    const sampleRate = 1e6 / (looptimeUs * pidDenom * bbRate);

                    // FFT segment size: ~0.5s, power of 2, clamped 256-4096
                    let segmentSize = 256;
                    while (segmentSize < sampleRate * 0.5) segmentSize <<= 1;
                    segmentSize = Math.min(segmentSize, 4096);

                    const currentSliders = {
                        masterMultiplier: (sysConfig.simplified_master_multiplier || 100) / 100,
                        piGain: (sysConfig.simplified_pi_gain || 100) / 100,
                        iGain: (sysConfig.simplified_i_gain || 100) / 100,
                        dGain: (sysConfig.simplified_d_gain || 100) / 100,
                        feedforwardGain: (sysConfig.simplified_feedforward_gain || 100) / 100,
                        dtermFilterMultiplier: (sysConfig.simplified_dterm_filter_multiplier || 100) / 100,
                    };

                    store.progressMessage = "Computing transfer functions...";

                    const AXIS_NAMES = ["roll", "pitch", "yaw"];
                    const axes = {};

                    for (const seg of chirpData.segments) {
                        const len = seg.endIdx - seg.startIdx + 1;
                        if (len < segmentSize) continue;

                        const input = chirpData.setpoint[seg.axis].subarray(seg.startIdx, seg.endIdx + 1);
                        const output = chirpData.gyro[seg.axis].subarray(seg.startIdx, seg.endIdx + 1);

                        const tf = welchTransferFunction(input, output, sampleRate, segmentSize, 0.5);
                        const rec = recommendGains(tf, currentSliders);

                        axes[AXIS_NAMES[seg.axis]] = {
                            transferFunction: tf,
                            gains: {
                                proposed: rec.proposed,
                                bandwidth: rec.analysis.bandwidthHz,
                                phaseMargin: rec.analysis.phaseMarginDeg,
                                resonantPeak: rec.analysis.resonantPeakDb,
                                coherencePct: rec.analysis.meanCoherence * 100,
                            },
                            sampleCount: len,
                        };
                    }

                    if (Object.keys(axes).length > 0) {
                        result = {
                            filename: file.name,
                            sampleRate: Math.round(sampleRate),
                            axes,
                            sysConfig,
                        };
                        break;
                    }
                } catch (err) {
                    lastError = err;
                }
            }

            if (!result) {
                throw lastError || new Error("No chirp data found in any log segment.");
            }

            store.analysisResult = result;
            store.analysisState = "done";
            store.progressMessage = "";
        } catch (err) {
            store.analysisState = "error";
            store.errorMessage = err.message || "Analysis failed.";
            store.progressMessage = "";
        }
    }

    async function applyGains(proposed) {
        for (const [key, value] of Object.entries(proposed)) {
            if (key in FC.TUNING_SLIDERS) {
                FC.TUNING_SLIDERS[key] = value;
            }
        }

        await MSP.promise(MSPCodes.MSP_SET_SIMPLIFIED_TUNING, mspHelper.crunch(MSPCodes.MSP_SET_SIMPLIFIED_TUNING));
        await MSP.promise(MSPCodes.MSP_EEPROM_WRITE);
    }

    return { importAndAnalyze, applyGains };
}

// ── internal helpers ────────────────────────────────────────────────────────

async function pickFile() {
    if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
            types: [
                {
                    description: "Blackbox log files",
                    accept: { "application/octet-stream": [".bbl", ".BBL", ".txt", ".TXT"] },
                },
            ],
            multiple: false,
        });
        return handle.getFile();
    }

    return new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".bbl,.BBL,.txt,.TXT";
        input.style.display = "none";
        document.body.appendChild(input);

        input.addEventListener("change", () => {
            const file = input.files?.[0] ?? null;
            document.body.removeChild(input);
            resolve(file);
        });

        input.addEventListener("cancel", () => {
            document.body.removeChild(input);
            reject(new Error("cancelled"));
        });

        input.click();
    });
}
