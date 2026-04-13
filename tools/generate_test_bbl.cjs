#!/usr/bin/env node
/**
 * Generate a simulated .BBL file with chirp data for testing the autotune feature.
 *
 * Simulates a 20-second chirp sweep on each axis (roll, pitch, yaw) with a
 * second-order plant response, producing realistic-looking frequency response data.
 *
 * Usage: node tools/generate_test_bbl.js [output_path]
 *        Default output: tools/test_chirp.BBL
 */

const fs = require("fs");
const path = require("path");

const outputPath = process.argv[2] || path.join(__dirname, "test_chirp.BBL");

// --- Simulation parameters ---

const LOOPTIME_US = 125;        // 8 kHz PID loop
const BB_RATE_DENOM = 4;        // Log every 4th loop → 2 kHz
const SAMPLE_RATE = 1e6 / (LOOPTIME_US * BB_RATE_DENOM); // 2000 Hz
const CHIRP_DURATION_S = 20;
const CHIRP_F0 = 0.2;           // Start frequency Hz
const CHIRP_F1 = 600;           // End frequency Hz
const CHIRP_AMPLITUDE = 230;    // deg/s

const NUM_SAMPLES = Math.round(SAMPLE_RATE * CHIRP_DURATION_S);

// Plant model: second-order system G(s) = wn^2 / (s^2 + 2*zeta*wn*s + wn^2)
// Different per axis to make it interesting
const PLANT_PARAMS = [
    { wn: 2 * Math.PI * 50, zeta: 0.6 },   // Roll: 50 Hz natural freq
    { wn: 2 * Math.PI * 45, zeta: 0.55 },   // Pitch: 45 Hz, slightly less damped
    { wn: 2 * Math.PI * 35, zeta: 0.5 },    // Yaw: 35 Hz, less damped
];

// --- Chirp signal generation (matches firmware chirp.c) ---

function generateChirp(f0, f1, duration, sampleRate, amplitude) {
    const N = Math.round(duration * sampleRate);
    const Ts = 1.0 / sampleRate;
    const beta = Math.pow(f1 / f0, 1.0 / duration);
    const k0 = 2 * Math.PI / Math.log(beta);
    const k1 = k0 * f0;

    const exc = new Float64Array(N);
    const freq = new Float64Array(N);
    const sinarg = new Float64Array(N);

    for (let i = 0; i < N; i++) {
        const t = i * Ts;
        const fchirp = f0 * Math.pow(beta, t);
        freq[i] = fchirp;

        let sa = k0 * fchirp - k1;
        sa = sa % (2 * Math.PI);
        if (sa < 0) sa += 2 * Math.PI;
        sinarg[i] = sa;

        let e = Math.cos(sa);
        if (fchirp < 1.0) e *= fchirp;
        exc[i] = e * amplitude;
    }

    return { exc, freq, sinarg, N };
}

// --- Second-order system simulation (discrete, Tustin/bilinear) ---

function simulateSecondOrder(input, sampleRate, wn, zeta) {
    const N = input.length;
    const output = new Float64Array(N);
    const T = 1.0 / sampleRate;

    // Bilinear (Tustin) transform of G(s) = wn^2 / (s^2 + 2*zeta*wn*s + wn^2)
    // s = (2/T)(z-1)/(z+1)
    const wn2 = wn * wn;
    const T2 = T * T;
    const a0 = 4 + 4 * zeta * wn * T + wn2 * T2;
    const b0 = wn2 * T2 / a0;
    const b1 = 2 * wn2 * T2 / a0;
    const b2 = wn2 * T2 / a0;
    const a1 = (2 * wn2 * T2 - 8) / a0;
    const a2 = (4 - 4 * zeta * wn * T + wn2 * T2) / a0;

    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < N; i++) {
        const x0 = input[i];
        output[i] = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x0;
        y2 = y1; y1 = output[i];
    }

    // Add small noise
    for (let i = 0; i < N; i++) {
        output[i] += (Math.random() - 0.5) * 2.0;
    }

    return output;
}

// --- Variable-byte encoding (matches blackbox format) ---

function writeUnsignedVB(buf, value) {
    value = value >>> 0; // force unsigned 32-bit
    while (value > 127) {
        buf.push((value & 0x7F) | 0x80);
        value >>>= 7;
    }
    buf.push(value);
}

function writeSignedVB(buf, value) {
    // ZigZag encoding
    const encoded = (value << 1) ^ (value >> 31);
    writeUnsignedVB(buf, encoded >>> 0);
}

// --- Build the BBL file ---

function buildHeader() {
    const lines = [];
    function H(name, value) {
        lines.push(`H ${name}:${value}\n`);
    }

    H("Product", "Blackbox flight data recorder by Nicholas Sherlock");
    H("Data version", "2");
    H("Firmware type", "Betaflight");
    H("Firmware revision", "Betaflight 2025.12.0 (simulated)");
    H("Firmware date", "Jan  1 2025 00:00:00");
    H("Board information", "SIMULATED");
    H("Log start datetime", "2025-01-01T00:00:00.000");
    H("Craft name", "Autotune Test");
    H("I interval", "32");
    H("P interval", "1/4");
    H("P ratio", "32");
    H("minthrottle", "1070");
    H("maxthrottle", "2000");
    H("looptime", String(LOOPTIME_US));
    H("gyro_sync_denom", "1");
    H("pid_process_denom", "1");
    H("acc_1G", "2048");
    H("vbatscale", "110");
    H("vbatref", "4095");
    H("currentMeter", "0,400");
    H("motorOutput", "1070,2047");

    // PID values
    H("rollPID", "45,80,30");
    H("pitchPID", "47,84,34");
    H("yawPID", "45,80,0");
    H("d_min", "30,34,0");
    H("ff_weight", "120,125,120");
    H("levelPID", "50,50,75");

    // Debug mode = CHIRP (26)
    H("debug_mode", "26");
    H("blackbox_high_resolution", "0");

    // Chirp parameters
    H("chirp_lag_freq_hz", "3");
    H("chirp_lead_freq_hz", "30");
    H("chirp_amplitude_roll", String(CHIRP_AMPLITUDE));
    H("chirp_amplitude_pitch", String(CHIRP_AMPLITUDE));
    H("chirp_amplitude_yaw", "180");
    H("chirp_frequency_start_deci_hz", String(Math.round(CHIRP_F0 * 10)));
    H("chirp_frequency_end_deci_hz", String(Math.round(CHIRP_F1 * 10)));
    H("chirp_time_seconds", String(CHIRP_DURATION_S));

    // Simplified tuning
    H("simplified_pids_mode", "2");
    H("simplified_master_multiplier", "100");
    H("simplified_pi_gain", "100");
    H("simplified_d_gain", "100");
    H("simplified_dmax_gain", "100");
    H("simplified_feedforward_gain", "100");
    H("simplified_pitch_d_gain", "105");
    H("simplified_pitch_pi_gain", "100");
    H("simplified_dterm_filter", "1");
    H("simplified_dterm_filter_multiplier", "100");
    H("simplified_gyro_filter", "1");
    H("simplified_gyro_filter_multiplier", "100");

    // Filter config
    H("gyro_lpf1_static_hz", "250");
    H("gyro_lpf2_static_hz", "500");
    H("dterm_lpf1_static_hz", "75");
    H("dterm_lpf2_static_hz", "150");

    // Field definitions for I-frames
    // Fields: loopIteration, time, setpoint[0-2], gyroADC[0-2], motor[0-3], debug[0-3]
    const iFieldNames = [
        "loopIteration", "time(us)",
        "setpoint[0]", "setpoint[1]", "setpoint[2]",
        "gyroADC[0]", "gyroADC[1]", "gyroADC[2]",
        "motor[0]", "motor[1]", "motor[2]", "motor[3]",
        "debug[0]", "debug[1]", "debug[2]", "debug[3]",
    ];

    // All signed except loopIteration, time, and motors
    const iSigned =     [0, 0,  1, 1, 1,  1, 1, 1,  0, 0, 0, 0,  1, 1, 1, 1];
    // I-frame predictors: 0=zero (raw)
    const iPredictor =  [0, 0,  0, 0, 0,  0, 0, 0,  4, 5, 5, 5,  0, 0, 0, 0];
    // I-frame encodings: 1=unsigned_vb, 0=signed_vb
    const iEncoding =   [1, 1,  0, 0, 0,  0, 0, 0,  1, 0, 0, 0,  0, 0, 0, 0];

    H("Field I name", iFieldNames.join(","));
    H("Field I signed", iSigned.join(","));
    H("Field I predictor", iPredictor.join(","));
    H("Field I encoding", iEncoding.join(","));

    // P-frame definitions (same fields, different predictors/encodings)
    // P predictor: 6=INC for iteration, 1=previous for most, 5=motor_0 for motors
    const pPredictor =  [6, 1,  1, 1, 1,  1, 1, 1,  1, 1, 1, 1,  1, 1, 1, 1];
    const pEncoding =   [0, 1,  0, 0, 0,  0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0];
    const pSigned =     [0, 0,  1, 1, 1,  1, 1, 1,  1, 1, 1, 1,  1, 1, 1, 1];

    H("Field P predictor", pPredictor.join(","));
    H("Field P encoding", pEncoding.join(","));
    H("Field P signed", pSigned.join(","));

    // S-frame definitions (slow frame)
    H("Field S name", "flightModeFlags,stateFlags,failsafePhase,rxSignalReceived,rxFlightChannelsValid");
    H("Field S signed", "0,0,0,0,0");
    H("Field S predictor", "0,0,0,0,0");
    H("Field S encoding", "1,1,1,1,1");

    return Buffer.from(lines.join(""), "ascii");
}

function buildDataFrames() {
    const buf = [];
    const AXIS_NAMES = ["roll", "pitch", "yaw"];

    // Generate chirp for each axis sequentially
    let iteration = 0;
    let timeUs = 0;
    const timeStepUs = LOOPTIME_US * BB_RATE_DENOM;
    let iFrameInterval = 32;
    let prevFrame = null;
    let framesSinceI = 0;

    // Write an initial S-frame with chirp NOT active
    writeSlowFrame(buf, 0);

    for (let axis = 0; axis < 3; axis++) {
        console.log(`Generating axis ${axis} (${AXIS_NAMES[axis]})...`);

        const chirp = generateChirp(CHIRP_F0, CHIRP_F1, CHIRP_DURATION_S, SAMPLE_RATE, CHIRP_AMPLITUDE);
        const gyroResponse = simulateSecondOrder(chirp.exc, SAMPLE_RATE, PLANT_PARAMS[axis].wn, PLANT_PARAMS[axis].zeta);

        // Write S-frame: chirp active (BOXCHIRP = bit 6 = 64)
        writeSlowFrame(buf, 64);

        for (let i = 0; i < chirp.N; i++) {
            const setpoint = Math.round(chirp.exc[i]);
            const gyro = Math.round(gyroResponse[i]);
            const debug0 = Math.round(5000 * chirp.sinarg[i]);
            const debug1 = axis;
            const debug2 = Math.round(10 * chirp.freq[i]);
            const debug3 = Math.round(1000 * chirp.exc[i] / CHIRP_AMPLITUDE); // raw chirp normalized

            const motor0 = 1500;
            const frame = [
                iteration, timeUs,
                axis === 0 ? setpoint : 0,
                axis === 1 ? setpoint : 0,
                axis === 2 ? setpoint : 0,
                axis === 0 ? gyro : 0,
                axis === 1 ? gyro : 0,
                axis === 2 ? gyro : 0,
                motor0, 0, 0, 0,
                debug0, debug1, debug2, debug3,
            ];

            if (framesSinceI >= iFrameInterval || prevFrame === null) {
                writeIFrame(buf, frame);
                framesSinceI = 0;
            } else {
                writePFrame(buf, frame, prevFrame);
            }

            prevFrame = frame.slice();
            iteration++;
            timeUs += timeStepUs;
            framesSinceI++;
        }

        // Write S-frame: chirp inactive
        writeSlowFrame(buf, 0);

        // Gap between axes (0.5 seconds of no-chirp data)
        const gapSamples = Math.round(SAMPLE_RATE * 0.5);
        for (let i = 0; i < gapSamples; i++) {
            const frame = [
                iteration, timeUs,
                0, 0, 0,
                0, 0, 0,
                1500, 0, 0, 0,
                0, -1, 0, 0,
            ];
            if (framesSinceI >= iFrameInterval || prevFrame === null) {
                writeIFrame(buf, frame);
                framesSinceI = 0;
            } else {
                writePFrame(buf, frame, prevFrame);
            }
            prevFrame = frame.slice();
            iteration++;
            timeUs += timeStepUs;
            framesSinceI++;
        }
    }

    // Write end-of-log event
    buf.push(0x45); // 'E'
    buf.push(255);  // EVENT_LOG_END
    const endMsg = "End of log\0";
    for (let i = 0; i < endMsg.length; i++) {
        buf.push(endMsg.charCodeAt(i));
    }

    return Buffer.from(buf);
}

function writeIFrame(buf, frame) {
    buf.push(0x49); // 'I'

    // Field 0: loopIteration — unsigned VB
    writeUnsignedVB(buf, frame[0]);
    // Field 1: time — unsigned VB
    writeUnsignedVB(buf, frame[1]);
    // Fields 2-4: setpoint[0-2] — signed VB, predictor 0 (raw)
    writeSignedVB(buf, frame[2]);
    writeSignedVB(buf, frame[3]);
    writeSignedVB(buf, frame[4]);
    // Fields 5-7: gyroADC[0-2] — signed VB, predictor 0 (raw)
    writeSignedVB(buf, frame[5]);
    writeSignedVB(buf, frame[6]);
    writeSignedVB(buf, frame[7]);
    // Field 8: motor[0] — unsigned VB, predictor MINTHROTTLE (value - 1070)
    writeUnsignedVB(buf, frame[8] - 1070);
    // Fields 9-11: motor[1-3] — signed VB, predictor MOTOR_0 (value - motor[0])
    writeSignedVB(buf, frame[9] - frame[8]);
    writeSignedVB(buf, frame[10] - frame[8]);
    writeSignedVB(buf, frame[11] - frame[8]);
    // Fields 12-15: debug[0-3] — signed VB, predictor 0 (raw)
    writeSignedVB(buf, frame[12]);
    writeSignedVB(buf, frame[13]);
    writeSignedVB(buf, frame[14]);
    writeSignedVB(buf, frame[15]);
}

function writePFrame(buf, frame, prev) {
    buf.push(0x50); // 'P'

    // Field 0: loopIteration — predictor INC: NOT encoded in the stream.
    // The parser computes it as previous[0] + skippedFrames + 1.

    // Field 1: time — unsigned VB, predictor PREVIOUS → delta
    writeUnsignedVB(buf, frame[1] - prev[1]);
    // Fields 2-7: setpoint + gyro — signed VB, predictor PREVIOUS → delta
    for (let i = 2; i <= 7; i++) {
        writeSignedVB(buf, frame[i] - prev[i]);
    }
    // Fields 8-11: motors — signed VB, predictor PREVIOUS → delta
    for (let i = 8; i <= 11; i++) {
        writeSignedVB(buf, frame[i] - prev[i]);
    }
    // Fields 12-15: debug — signed VB, predictor PREVIOUS → delta
    for (let i = 12; i <= 15; i++) {
        writeSignedVB(buf, frame[i] - prev[i]);
    }
}

function writeSlowFrame(buf, flightModeFlags) {
    buf.push(0x53); // 'S'
    writeUnsignedVB(buf, flightModeFlags);
    writeUnsignedVB(buf, 0); // stateFlags
    writeUnsignedVB(buf, 0); // failsafePhase
    writeUnsignedVB(buf, 1); // rxSignalReceived
    writeUnsignedVB(buf, 1); // rxFlightChannelsValid
}

// --- Main ---

console.log("Generating simulated chirp BBL file...");
console.log(`  Sample rate: ${SAMPLE_RATE} Hz`);
console.log(`  Chirp: ${CHIRP_F0}-${CHIRP_F1} Hz over ${CHIRP_DURATION_S}s per axis`);
console.log(`  Plant: Roll 50Hz/ζ=0.6, Pitch 45Hz/ζ=0.55, Yaw 35Hz/ζ=0.5`);

const header = buildHeader();
const data = buildDataFrames();
const file = Buffer.concat([header, data]);

fs.writeFileSync(outputPath, file);

const sizeKB = (file.length / 1024).toFixed(1);
console.log(`\nWrote ${outputPath} (${sizeKB} KB)`);
console.log(`  ${3 * NUM_SAMPLES} chirp samples + gaps + framing`);
console.log(`\nExpected transfer function peaks:`);
console.log(`  Roll:  50 Hz resonance, ~6 dB peak`);
console.log(`  Pitch: 45 Hz resonance, ~7 dB peak`);
console.log(`  Yaw:   35 Hz resonance, ~8 dB peak`);
