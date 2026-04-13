/**
 * Spectral analysis for chirp-based autotune.
 *
 * Computes the closed-loop transfer function from setpoint (input) to
 * gyro (output) using Welch's cross-spectral method, then derives
 * recommended PID gain adjustments.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ComplexFFT } from "./fft.js";

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

/**
 * Generate a Hanning window of the given size.
 * @param {number} size
 * @returns {Float64Array}
 */
export function hanningWindow(size) {
    const w = new Float64Array(size);
    for (let i = 0; i < size; i++) {
        w[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (size - 1)));
    }
    return w;
}

// ---------------------------------------------------------------------------
// Welch cross-spectral density
// ---------------------------------------------------------------------------

/**
 * Compute the transfer function H(f) = Sxy / Sxx using Welch's method.
 *
 * @param {Float32Array} input  - Input signal (e.g. setpoint for one axis)
 * @param {Float32Array} output - Output signal (e.g. gyro for same axis)
 * @param {number} sampleRate   - Samples per second (Hz)
 * @param {number} [segmentSize=1024] - FFT segment size (power of 2 recommended)
 * @param {number} [overlap=0.5] - Overlap fraction between segments
 * @returns {{ frequencies: Float64Array, magnitude: Float64Array, phase: Float64Array, coherence: Float64Array }}
 */
export function welchTransferFunction(input, output, sampleRate, segmentSize = 1024, overlap = 0.5) {
    const N = input.length;
    if (N !== output.length) {
        throw new Error("Input and output arrays must be the same length");
    }

    // Clamp segment size to not exceed data length
    if (segmentSize > N) {
        segmentSize = nextPow2(N);
        if (segmentSize > N) segmentSize = Math.max(segmentSize >> 1, 4);
    }

    const hopSize = Math.max(1, Math.round(segmentSize * (1 - overlap)));
    const numSegments = Math.max(1, Math.floor((N - segmentSize) / hopSize) + 1);
    const numBins = Math.floor(segmentSize / 2) + 1;
    const window = hanningWindow(segmentSize);

    // Accumulators for cross-spectral and auto-spectral densities
    const Sxx = new Float64Array(numBins); // auto-spectrum of input
    const Syy = new Float64Array(numBins); // auto-spectrum of output
    const SxyRe = new Float64Array(numBins); // cross-spectrum real
    const SxyIm = new Float64Array(numBins); // cross-spectrum imag

    const fft = new ComplexFFT(segmentSize, false);
    const fftInput = new Float64Array(2 * segmentSize);
    const Xk = new Float64Array(2 * segmentSize);
    const Yk = new Float64Array(2 * segmentSize);

    for (let seg = 0; seg < numSegments; seg++) {
        const offset = seg * hopSize;

        // FFT of windowed input segment
        for (let i = 0; i < segmentSize; i++) {
            fftInput[i] = input[offset + i] * window[i];
        }
        fft.simple(Xk, fftInput, "real");

        // FFT of windowed output segment
        for (let i = 0; i < segmentSize; i++) {
            fftInput[i] = output[offset + i] * window[i];
        }
        fft.simple(Yk, fftInput, "real");

        // Accumulate spectral densities
        for (let k = 0; k < numBins; k++) {
            const xr = Xk[2 * k],
                xi = Xk[2 * k + 1];
            const yr = Yk[2 * k],
                yi = Yk[2 * k + 1];

            Sxx[k] += xr * xr + xi * xi;
            Syy[k] += yr * yr + yi * yi;
            // Sxy = conj(X) * Y
            SxyRe[k] += xr * yr + xi * yi;
            SxyIm[k] += -xi * yr + xr * yi;
        }
    }

    // Compute transfer function H = Sxy / Sxx, coherence γ² = |Sxy|² / (Sxx * Syy)
    const frequencies = new Float64Array(numBins);
    const magnitude = new Float64Array(numBins);
    const phase = new Float64Array(numBins);
    const coherence = new Float64Array(numBins);

    const freqBinWidth = sampleRate / segmentSize;

    for (let k = 0; k < numBins; k++) {
        frequencies[k] = k * freqBinWidth;

        if (Sxx[k] < 1e-20) {
            // No input energy at this frequency — skip
            magnitude[k] = -Infinity;
            phase[k] = 0;
            coherence[k] = 0;
            continue;
        }

        // H(k) = Sxy(k) / Sxx(k)
        const hRe = SxyRe[k] / Sxx[k];
        const hIm = SxyIm[k] / Sxx[k];

        magnitude[k] = 20 * Math.log10(Math.sqrt(hRe * hRe + hIm * hIm)); // dB
        phase[k] = Math.atan2(hIm, hRe) * (180 / Math.PI); // degrees

        // Coherence: γ²(k) = |Sxy|² / (Sxx × Syy)
        const sxyMagSq = SxyRe[k] * SxyRe[k] + SxyIm[k] * SxyIm[k];
        const denom = Sxx[k] * Syy[k];
        coherence[k] = denom > 1e-30 ? sxyMagSq / denom : 0;
    }

    return { frequencies, magnitude, phase, coherence, numSegments };
}

// ---------------------------------------------------------------------------
// Gain recommendation
// ---------------------------------------------------------------------------

/**
 * Recommend simplified tuning slider adjustments based on the measured
 * closed-loop transfer function.
 *
 * Derives individual P, I, D, feedforward, and filter recommendations from
 * the frequency response characteristics:
 *   - P (pi_gain): controls bandwidth — scaled to reach target -3dB frequency
 *   - I (i_gain): controls low-frequency tracking — scaled from low-freq error
 *   - D (d_gain): controls damping — scaled to reach target phase margin
 *   - FF (feedforward_gain): tracks setpoint changes — scaled with P
 *   - D-term filter: set from noise floor frequency
 *
 * All outputs are slider multiplier values (1.0 = default, stored as ×100 integers).
 *
 * @param {{ frequencies: Float64Array, magnitude: Float64Array, phase: Float64Array, coherence: Float64Array }} tf
 * @param {object} currentSliders - Current simplified tuning slider values as decimals (1.0 = 100)
 * @param {number} [targetBandwidthHz=45] - Desired -3dB bandwidth
 * @param {number} [targetPhaseMarginDeg=50] - Desired phase margin in degrees
 * @returns {{ proposed: object, analysis: object }}
 */
export function recommendGains(tf, currentSliders, targetBandwidthHz = 45, targetPhaseMarginDeg = 50) {
    const { frequencies, magnitude, phase, coherence } = tf;

    // --- Extract frequency response characteristics ---

    // 1. Bandwidth: frequency where closed-loop magnitude crosses -3dB
    let bandwidthHz = 0;
    for (let k = 1; k < frequencies.length; k++) {
        if (coherence[k] < 0.3) continue;
        if (magnitude[k] <= -3.0 && magnitude[k - 1] > -3.0) {
            const frac = (-3.0 - magnitude[k - 1]) / (magnitude[k] - magnitude[k - 1]);
            bandwidthHz = frequencies[k - 1] + frac * (frequencies[k] - frequencies[k - 1]);
            break;
        }
    }
    if (bandwidthHz === 0) {
        let maxFreqAbove3dB = 0;
        for (let k = 1; k < frequencies.length; k++) {
            if (coherence[k] < 0.3) continue;
            if (magnitude[k] > -3.0 && frequencies[k] > maxFreqAbove3dB) {
                maxFreqAbove3dB = frequencies[k];
            }
        }
        bandwidthHz = maxFreqAbove3dB || targetBandwidthHz;
    }

    // 2. Resonant peak: max magnitude overshoot (indicates underdamping)
    let resonantPeakDb = -Infinity;
    let resonantFreqHz = 0;
    for (let k = 1; k < frequencies.length; k++) {
        if (coherence[k] < 0.3) continue;
        if (frequencies[k] > 0 && frequencies[k] < 500 && magnitude[k] > resonantPeakDb) {
            resonantPeakDb = magnitude[k];
            resonantFreqHz = frequencies[k];
        }
    }

    // 3. Gain crossover: where magnitude crosses 0 dB
    let gainCrossoverHz = 0;
    for (let k = 1; k < frequencies.length; k++) {
        if (coherence[k] < 0.3) continue;
        if (magnitude[k] <= 0 && magnitude[k - 1] > 0) {
            const frac = (0 - magnitude[k - 1]) / (magnitude[k] - magnitude[k - 1]);
            gainCrossoverHz = frequencies[k - 1] + frac * (frequencies[k] - frequencies[k - 1]);
            break;
        }
    }

    // 4. Phase margin at gain crossover
    let phaseAtCrossover = 0;
    if (gainCrossoverHz > 0) {
        for (let k = 1; k < frequencies.length; k++) {
            if (frequencies[k] >= gainCrossoverHz) {
                const frac = (gainCrossoverHz - frequencies[k - 1]) / (frequencies[k] - frequencies[k - 1]);
                phaseAtCrossover = phase[k - 1] + frac * (phase[k] - phase[k - 1]);
                break;
            }
        }
    }
    const phaseMarginDeg = 180 + phaseAtCrossover;

    // 5. Low-frequency gain error: average magnitude deviation from 0 dB
    //    in the 2-10 Hz range. If magnitude is below 0 dB here, I-term is too low.
    let lowFreqErrorDb = 0;
    let lowFreqCount = 0;
    for (let k = 0; k < frequencies.length; k++) {
        if (frequencies[k] >= 2 && frequencies[k] <= 10 && coherence[k] > 0.3) {
            lowFreqErrorDb += magnitude[k]; // should be ~0 dB for good tracking
            lowFreqCount++;
        }
    }
    lowFreqErrorDb = lowFreqCount > 0 ? lowFreqErrorDb / lowFreqCount : 0;

    // 6. Noise floor: frequency where coherence drops below 0.5
    let noiseFloorHz = frequencies[frequencies.length - 1];
    for (let k = 1; k < frequencies.length; k++) {
        if (frequencies[k] > 20 && coherence[k] < 0.5) {
            noiseFloorHz = frequencies[k];
            break;
        }
    }

    // 7. Overall coherence (measurement quality)
    let coherenceSum = 0;
    let coherenceCount = 0;
    for (let k = 0; k < frequencies.length; k++) {
        if (frequencies[k] >= 5 && frequencies[k] <= 100) {
            coherenceSum += coherence[k];
            coherenceCount++;
        }
    }
    const meanCoherence = coherenceCount > 0 ? coherenceSum / coherenceCount : 0;

    // --- Compute individual gain scaling factors ---

    // P (via pi_gain): scale to hit target bandwidth
    // Bandwidth is roughly proportional to P gain
    let piScale = bandwidthHz > 0 ? targetBandwidthHz / bandwidthHz : 1.0;

    // D: scale to hit target phase margin
    // D adds phase lead; more D → more phase margin
    let dScale = 1.0;
    if (phaseMarginDeg > 0 && phaseMarginDeg < 180) {
        dScale = 1.0 + (targetPhaseMarginDeg - phaseMarginDeg) / 90.0;
    }

    // I: scale based on low-frequency tracking error
    // If low-freq gain is below 0 dB, I is too low; if above, I is too high
    // Each dB of error maps to ~10% I adjustment
    let iScale = 1.0;
    if (lowFreqErrorDb < -1.0) {
        // Low-freq gain too low → increase I
        iScale = 1.0 + Math.abs(lowFreqErrorDb) * 0.1;
    } else if (lowFreqErrorDb > 2.0) {
        // Low-freq gain too high (overshoot from I) → decrease I
        iScale = 1.0 - lowFreqErrorDb * 0.05;
    }

    // FF (feedforward): generally tracks with P. If bandwidth is good but
    // transient response is sluggish, FF should increase. As a first
    // approximation, scale FF with the P adjustment.
    let ffScale = piScale;

    // Safety: back off all gains if resonant peak indicates near-instability
    if (resonantPeakDb > 6.0) {
        // Severe resonance — significant reduction
        piScale *= 0.75;
        dScale *= 0.85;
        ffScale *= 0.8;
    } else if (resonantPeakDb > 3.0) {
        // Moderate resonance — mild reduction
        piScale *= 0.9;
        dScale *= 0.95;
    }

    // Filter: set D-term filter based on noise floor
    const defaultFilterHz = 150;
    let filterScale = noiseFloorHz / defaultFilterHz;

    // Clamp all to safe range (max 2x change per iteration)
    piScale = clamp(piScale, 0.5, 2.0);
    iScale = clamp(iScale, 0.5, 2.0);
    dScale = clamp(dScale, 0.5, 2.0);
    ffScale = clamp(ffScale, 0.5, 2.0);
    filterScale = clamp(filterScale, 0.5, 2.0);

    // --- Apply to current slider values ---
    // Output as integer slider values (100 = 1.0x = default)

    const cur = currentSliders;
    const proposed = {
        slider_master_multiplier: Math.round(clamp((cur.masterMultiplier ?? 1.0) * 100, 25, 250)),
        slider_pi_gain: Math.round(clamp((cur.piGain ?? 1.0) * piScale * 100, 25, 250)),
        slider_i_gain: Math.round(clamp((cur.iGain ?? 1.0) * iScale * 100, 25, 250)),
        slider_d_gain: Math.round(clamp((cur.dGain ?? 1.0) * dScale * 100, 25, 250)),
        slider_feedforward_gain: Math.round(clamp((cur.feedforwardGain ?? 1.0) * ffScale * 100, 25, 250)),
        slider_dterm_filter_multiplier: Math.round(
            clamp((cur.dtermFilterMultiplier ?? 1.0) * filterScale * 100, 25, 250),
        ),
    };

    const analysis = {
        bandwidthHz,
        resonantPeakDb,
        resonantFreqHz,
        gainCrossoverHz,
        phaseMarginDeg,
        lowFreqErrorDb,
        noiseFloorHz,
        meanCoherence,
        piScale,
        iScale,
        dScale,
        ffScale,
        filterScale,
    };

    return { proposed, analysis };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
