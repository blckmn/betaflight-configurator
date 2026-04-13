/**
 * Focused blackbox log parser for chirp/autotune frequency response analysis.
 *
 * Extracts only the data relevant for chirp analysis from Betaflight
 * blackbox (.BBL) log files: setpoint, gyro, and debug fields during
 * chirp-active segments.
 *
 * Depends on:
 *   - ./datastream.js  (ArrayDataStream, signExtend helpers)
 *   - ./decoders.js    (Tag2_3S32, Tag2_3SVariable, Tag8_4S16, Tag8_8SVB)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ArrayDataStream } from "./datastream.js";
import "./decoders.js"; // side-effect: extends ArrayDataStream prototype

// ---------------------------------------------------------------------------
// Constants — encoding types (match FLIGHT_LOG_FIELD_ENCODING_*)
// ---------------------------------------------------------------------------

const ENCODING_SIGNED_VB = 0;
const ENCODING_UNSIGNED_VB = 1;
const ENCODING_NEG_14BIT = 3;
const ENCODING_TAG8_8SVB = 6;
const ENCODING_TAG2_3S32 = 7;
const ENCODING_TAG8_4S16 = 8;
const ENCODING_NULL = 9;
const ENCODING_TAG2_3SVARIABLE = 10;

// ---------------------------------------------------------------------------
// Constants — predictor types (match FLIGHT_LOG_FIELD_PREDICTOR_*)
// ---------------------------------------------------------------------------

const PREDICTOR_0 = 0;
const PREDICTOR_PREVIOUS = 1;
const PREDICTOR_STRAIGHT_LINE = 2;
const PREDICTOR_AVERAGE_2 = 3;
const PREDICTOR_MINTHROTTLE = 4;
const PREDICTOR_MOTOR_0 = 5;
const PREDICTOR_INC = 6;
// const PREDICTOR_HOME_COORD        = 7;  // GPS only — not needed for chirp
const PREDICTOR_1500 = 8;
const PREDICTOR_VBATREF = 9;
const PREDICTOR_LAST_MAIN_FRAME_TIME = 10;
const PREDICTOR_MINMOTOR = 11;

// ---------------------------------------------------------------------------
// Constants — frame & event markers
// ---------------------------------------------------------------------------

const FRAME_TYPE_I = 0x49; // 'I'
const FRAME_TYPE_P = 0x50; // 'P'
const FRAME_TYPE_S = 0x53; // 'S'
const FRAME_TYPE_E = 0x45; // 'E'
const FRAME_TYPE_G = 0x47; // 'G'
const FRAME_TYPE_H = 0x48; // 'H'

const EVENT_SYNC_BEEP = 0;
const EVENT_INFLIGHT_ADJ = 13;
const EVENT_LOGGING_RESUME = 14;
const EVENT_DISARM = 15;
const EVENT_FLIGHTMODE = 30;
const EVENT_LOG_END = 255;

// BOXCHIRP is bit 6 in rcModeActivationMask (the value logged in S-frame flightModeFlags)
const BOXCHIRP_BIT = 6;

// The log boundary marker that starts every log in a BBL file
const LOG_BOUNDARY = "H Product:Blackbox flight data recorder by Nicholas Sherlock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signExtend14Bit(word) {
    return word & 0x2000 ? word | 0xffffc000 : word;
}

/**
 * Determine the "group size" for a grouped encoding type.
 * Grouped encodings read multiple field values from a single tag structure.
 */
function encodingGroupSize(encoding) {
    switch (encoding) {
        case ENCODING_TAG2_3S32:
            return 3;
        case ENCODING_TAG2_3SVARIABLE:
            return 3;
        case ENCODING_TAG8_4S16:
            return 4;
        case ENCODING_TAG8_8SVB:
            return 8;
        default:
            return 1;
    }
}

/**
 * Search the data for the ASCII text that marks the beginning of each
 * flight log. Returns byte offsets of the 'H' at the start of each
 * "H Product:..." line.
 */
function findString(data, str, startFrom) {
    const needle = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        needle[i] = str.charCodeAt(i);
    }
    for (let i = startFrom; i <= data.length - needle.length; i++) {
        if (data[i] === needle[0]) {
            let match = true;
            for (let j = 1; j < needle.length; j++) {
                if (data[i + j] !== needle[j]) {
                    match = false;
                    break;
                }
            }
            if (match) return i;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Public API: findLogBoundaries
// ---------------------------------------------------------------------------

/**
 * Scan a BBL file (as Uint8Array) and return the byte ranges for each
 * individual flight log it contains.
 *
 * @param {Uint8Array} data  The raw BBL file bytes.
 * @returns {Array<{start: number, end: number}>}
 */
export function findLogBoundaries(data) {
    const boundaries = [];
    let offset = 0;

    while (offset < data.length) {
        const start = findString(data, LOG_BOUNDARY, offset);
        if (start === -1) break;

        // The next log starts at the next boundary marker (or EOF)
        const nextStart = findString(data, LOG_BOUNDARY, start + LOG_BOUNDARY.length);
        const end = nextStart === -1 ? data.length : nextStart;

        boundaries.push({ start, end });
        offset = end;
    }

    return boundaries;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/**
 * Parse the text header section of a single flight log.
 * Returns a sysConfig object plus field definitions for I, P, and S frames.
 */
function parseHeader(data, logStart, logEnd) {
    const stream = new ArrayDataStream(data, logStart, logEnd);

    // Frame definitions keyed by type letter.  For I/P frames the field name
    // arrays are shared (P-frame names = I-frame names).
    const frameDefs = {
        I: { name: [], signed: [], predictor: [], encoding: [], count: 0 },
        P: { name: [], signed: [], predictor: [], encoding: [], count: 0 },
        S: { name: [], signed: [], predictor: [], encoding: [], count: 0 },
    };

    const sysConfig = {
        dataVersion: 2,
        looptime: 125,
        pid_process_denom: 1,
        debug_mode: -1,
        blackbox_high_resolution: 0,
        frameIntervalI: 32,
        frameIntervalPNum: 1,
        frameIntervalPDenom: 1,
        minthrottle: 1070,
        vbatref: 4095,
        motorOutput: [0, 0],
        rollPID: [0, 0, 0],
        pitchPID: [0, 0, 0],
        yawPID: [0, 0, 0],
        chirp_lag_freq_hz: 0,
        chirp_lead_freq_hz: 0,
        chirp_amplitude_roll: 0,
        chirp_amplitude_pitch: 0,
        chirp_amplitude_yaw: 0,
        chirp_frequency_start_deci_hz: 0,
        chirp_frequency_end_deci_hz: 0,
        chirp_time_seconds: 0,
        simplified_master_multiplier: 100,
        simplified_pi_gain: 100,
        simplified_i_gain: 100,
        simplified_d_gain: 100,
        simplified_feedforward_gain: 100,
        simplified_dterm_filter_multiplier: 100,
    };

    // Read header lines one at a time until we hit a non-header byte
    while (!stream.eof) {
        const startOfLine = stream.pos;
        const ch = stream.readChar();

        if (ch === "H") {
            // Must be followed by a space
            const sp = stream.readChar();
            if (sp !== " ") {
                // Not a header line — rewind and stop
                stream.pos = startOfLine;
                break;
            }

            // Read the rest of the line until newline
            let line = "";
            while (!stream.eof) {
                const c = stream.readChar();
                if (c === "\n" || c === stream.EOF) break;
                line += c;
            }

            parseHeaderLine(line, sysConfig, frameDefs);
        } else {
            // We've reached the binary data section — put back the byte
            stream.pos = startOfLine;
            break;
        }
    }

    // P-frame field names are the same as I-frame names (they share indices)
    frameDefs.P.name = frameDefs.I.name;
    frameDefs.P.signed = frameDefs.I.signed;
    frameDefs.P.count = frameDefs.I.count;

    // Build field-index maps for quick lookup during frame parsing
    const fieldIndices = buildFieldIndices(frameDefs.I.name);
    sysConfig.fieldIndices = fieldIndices;

    return {
        sysConfig,
        frameDefs,
        dataStart: stream.pos,
    };
}

/**
 * Parse a single header line (without the "H " prefix) and update
 * sysConfig / frameDefs accordingly.
 */
function parseHeaderLine(line, sysConfig, frameDefs) {
    // Split on the first colon
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) return;

    const key = line.substring(0, colonIdx);
    const value = line.substring(colonIdx + 1);

    // --- Field definition lines ---
    // Format: "Field I name:...", "Field I signed:...", etc.
    const fieldMatch = key.match(/^Field ([IPS]) (\w+)$/);
    if (fieldMatch) {
        const frameChar = fieldMatch[1];
        const property = fieldMatch[2];
        const parts = value.split(",");

        if (frameDefs[frameChar]) {
            if (property === "name") {
                frameDefs[frameChar].name = parts;
                frameDefs[frameChar].count = parts.length;
            } else if (property === "signed") {
                frameDefs[frameChar].signed = parts.map(Number);
            } else if (property === "predictor") {
                frameDefs[frameChar].predictor = parts.map(Number);
            } else if (property === "encoding") {
                frameDefs[frameChar].encoding = parts.map(Number);
            }
        }
        return;
    }

    // --- Scalar / tuple config values ---
    switch (key) {
        case "Data version":
            sysConfig.dataVersion = parseInt(value, 10);
            break;
        case "I interval":
            sysConfig.frameIntervalI = parseInt(value, 10);
            break;
        case "P interval":
            if (value.indexOf("/") !== -1) {
                const parts = value.split("/");
                sysConfig.frameIntervalPNum = parseInt(parts[0], 10);
                sysConfig.frameIntervalPDenom = parseInt(parts[1], 10);
            } else {
                sysConfig.frameIntervalPNum = parseInt(value, 10);
                sysConfig.frameIntervalPDenom = 1;
            }
            break;
        case "P ratio":
            // Alternative form — derive P interval from ratio
            // P ratio = I interval / P interval
            // We'll use it if P interval wasn't explicitly set
            if (sysConfig.frameIntervalPNum === 1 && sysConfig.frameIntervalPDenom === 1) {
                const ratio = parseInt(value, 10);
                if (ratio > 0) {
                    sysConfig.frameIntervalPNum = 1;
                    sysConfig.frameIntervalPDenom = ratio;
                }
            }
            break;
        case "looptime":
            sysConfig.looptime = parseInt(value, 10);
            break;
        case "pid_process_denom":
            sysConfig.pid_process_denom = parseInt(value, 10);
            break;
        case "debug_mode":
            sysConfig.debug_mode = parseInt(value, 10);
            break;
        case "blackbox_high_resolution":
            sysConfig.blackbox_high_resolution = parseInt(value, 10);
            break;
        case "minthrottle":
            sysConfig.minthrottle = parseInt(value, 10);
            break;
        case "maxthrottle":
            sysConfig.maxthrottle = parseInt(value, 10);
            break;
        case "vbatref":
            sysConfig.vbatref = parseInt(value, 10);
            break;
        case "motorOutput": {
            const parts = value.split(",").map(Number);
            if (parts.length >= 2) sysConfig.motorOutput = [parts[0], parts[1]];
            break;
        }
        case "rollPID":
            sysConfig.rollPID = value.split(",").map(Number);
            break;
        case "pitchPID":
            sysConfig.pitchPID = value.split(",").map(Number);
            break;
        case "yawPID":
            sysConfig.yawPID = value.split(",").map(Number);
            break;
        case "chirp_lag_freq_hz":
            sysConfig.chirp_lag_freq_hz = parseInt(value, 10);
            break;
        case "chirp_lead_freq_hz":
            sysConfig.chirp_lead_freq_hz = parseInt(value, 10);
            break;
        case "chirp_amplitude_roll":
            sysConfig.chirp_amplitude_roll = parseInt(value, 10);
            break;
        case "chirp_amplitude_pitch":
            sysConfig.chirp_amplitude_pitch = parseInt(value, 10);
            break;
        case "chirp_amplitude_yaw":
            sysConfig.chirp_amplitude_yaw = parseInt(value, 10);
            break;
        case "chirp_frequency_start_deci_hz":
            sysConfig.chirp_frequency_start_deci_hz = parseInt(value, 10);
            break;
        case "chirp_frequency_end_deci_hz":
            sysConfig.chirp_frequency_end_deci_hz = parseInt(value, 10);
            break;
        case "chirp_time_seconds":
            sysConfig.chirp_time_seconds = parseInt(value, 10);
            break;
        case "simplified_master_multiplier":
        case "simplified_pi_gain":
        case "simplified_i_gain":
        case "simplified_feedforward_gain":
            sysConfig[key] = parseInt(value, 10);
            break;
        case "simplified_d_gain":
            sysConfig.simplified_d_gain = parseInt(value, 10);
            break;
        case "simplified_dterm_filter_multiplier":
            sysConfig.simplified_dterm_filter_multiplier = parseInt(value, 10);
            break;
    }
}

/**
 * Build a map from well-known field names to their indices in the I-frame
 * field array.  Field names in the header look like "setpoint[0]",
 * "gyroADC[1]", "debug[3]", etc.
 */
function buildFieldIndices(names) {
    const indices = {};
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        // Map both the raw name (e.g. "setpoint[0]") and a friendlier alias
        indices[name] = i;

        // Create aliases: setpoint[0] → setpoint0, gyroADC[2] → gyroADC2, etc.
        const alias = name.replace(/\[(\d+)\]/, "$1");
        if (alias !== name) {
            indices[alias] = i;
        }
    }
    return indices;
}

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

/**
 * Read a single raw value from the stream using the specified encoding.
 *
 * For grouped encodings (TAG2_3S32, TAG8_4S16, TAG8_8SVB, TAG2_3SVARIABLE),
 * this fills the `groupValues` array with all values in the group and
 * returns the first one.  The caller must advance its field index by the
 * group size.
 *
 * @param {ArrayDataStream} stream
 * @param {number} encoding
 * @param {number} dataVersion  — 1 or 2 (affects TAG8_4S16 version)
 * @param {number[]} groupValues — reusable scratch array (length >= 8)
 * @param {number} groupCount   — how many fields remain in the frame
 *                                 (caps TAG8_8SVB to actual remaining)
 * @returns {number} The first (or only) decoded value.
 */
function readFieldValue(stream, encoding, dataVersion, groupValues, groupCount) {
    switch (encoding) {
        case ENCODING_SIGNED_VB:
            return stream.readSignedVB();

        case ENCODING_UNSIGNED_VB:
            return stream.readUnsignedVB();

        case ENCODING_NEG_14BIT:
            return -signExtend14Bit(stream.readUnsignedVB());

        case ENCODING_TAG2_3S32:
            stream.readTag2_3S32(groupValues);
            return groupValues[0];

        case ENCODING_TAG2_3SVARIABLE:
            stream.readTag2_3SVariable(groupValues);
            return groupValues[0];

        case ENCODING_TAG8_4S16:
            if (dataVersion >= 2) {
                stream.readTag8_4S16_v2(groupValues);
            } else {
                stream.readTag8_4S16_v1(groupValues);
            }
            return groupValues[0];

        case ENCODING_TAG8_8SVB:
            stream.readTag8_8SVB(groupValues, Math.min(groupCount, 8));
            return groupValues[0];

        case ENCODING_NULL:
            return 0;

        default:
            // Unknown encoding — best-effort: read a signed VB so we at least
            // consume some bytes rather than looping forever.
            return stream.readSignedVB();
    }
}

/**
 * Apply a predictor to convert a raw (delta/residual) value to the actual
 * field value.
 *
 * @param {number} fieldIndex
 * @param {number} predictor    — predictor type
 * @param {number} raw          — raw decoded value
 * @param {Int32Array} current  — the frame being built (partially filled)
 * @param {Int32Array|null} previous  — preceding frame
 * @param {Int32Array|null} previous2 — frame before that
 * @param {number} skippedFrames
 * @param {object} sysConfig
 * @param {number} motor0Index  — index of motor[0] in the field array
 * @param {number} lastMainFrameTime
 * @returns {number}
 */
function applyPrediction(
    fieldIndex,
    predictor,
    raw,
    current,
    previous,
    previous2,
    skippedFrames,
    sysConfig,
    motor0Index,
    lastMainFrameTime,
) {
    switch (predictor) {
        case PREDICTOR_0:
            // Value is absolute
            return raw;

        case PREDICTOR_PREVIOUS:
            return raw + (previous ? previous[fieldIndex] : 0);

        case PREDICTOR_STRAIGHT_LINE:
            if (previous && previous2) {
                return raw + 2 * previous[fieldIndex] - previous2[fieldIndex];
            }
            return raw + (previous ? previous[fieldIndex] : 0);

        case PREDICTOR_AVERAGE_2:
            if (previous && previous2) {
                return raw + ((previous[fieldIndex] + previous2[fieldIndex]) >> 1);
            }
            return raw + (previous ? previous[fieldIndex] : 0);

        case PREDICTOR_MINTHROTTLE:
            return raw + sysConfig.minthrottle;

        case PREDICTOR_MOTOR_0:
            return raw + (motor0Index >= 0 ? current[motor0Index] : 0);

        case PREDICTOR_INC:
            // Handled specially before reading — should not reach here.
            // But just in case:
            return raw + (previous ? previous[fieldIndex] + skippedFrames + 1 : 0);

        case PREDICTOR_1500:
            return raw + 1500;

        case PREDICTOR_VBATREF:
            return raw + sysConfig.vbatref;

        case PREDICTOR_LAST_MAIN_FRAME_TIME:
            return raw + lastMainFrameTime;

        case PREDICTOR_MINMOTOR:
            return raw + sysConfig.motorOutput[0];

        default:
            return raw;
    }
}

/**
 * Parse a complete frame (I, P, or S) from the binary stream.
 *
 * Populates `current` with the decoded field values.
 *
 * @param {ArrayDataStream} stream
 * @param {object} frameDef        — { name, signed, predictor, encoding, count }
 * @param {Int32Array} current     — output array (length >= frameDef.count)
 * @param {Int32Array|null} previous
 * @param {Int32Array|null} previous2
 * @param {number} skippedFrames
 * @param {object} sysConfig
 * @param {number} motor0Index
 * @param {number} lastMainFrameTime
 * @returns {boolean} true if the frame was parsed successfully
 */
function parseFrame(
    stream,
    frameDef,
    current,
    previous,
    previous2,
    skippedFrames,
    sysConfig,
    motor0Index,
    lastMainFrameTime,
) {
    const groupValues = new Array(8); // scratch buffer for grouped encodings
    let i = 0;
    const count = frameDef.count;
    const posBeforeFrame = stream.pos;

    while (i < count) {
        if (stream.eof) return false;

        const predictor = frameDef.predictor[i];
        const encoding = frameDef.encoding[i];

        // --- PREDICTOR_INC: value is derived, nothing to read from stream ---
        if (predictor === PREDICTOR_INC) {
            current[i] = (previous ? previous[i] : 0) + skippedFrames + 1;
            i++;
            continue;
        }

        // --- Grouped encodings read multiple values at once ---
        const groupSize = encodingGroupSize(encoding);

        if (groupSize > 1) {
            // How many values remain in the frame
            const remaining = count - i;
            // The group might extend beyond the remaining fields (shouldn't
            // happen in well-formed data, but clamp to be safe)
            const actualGroupSize = Math.min(groupSize, remaining);

            // Zero out scratch buffer
            for (let g = 0; g < groupSize; g++) groupValues[g] = 0;

            // Read the raw group
            readFieldValue(stream, encoding, sysConfig.dataVersion, groupValues, actualGroupSize);

            // Apply predictor to each member of the group
            for (let g = 0; g < actualGroupSize; g++) {
                if (frameDef.predictor[i + g] === PREDICTOR_INC) {
                    // INC fields inside a group — shouldn't normally happen,
                    // but handle gracefully
                    current[i + g] = (previous ? previous[i + g] : 0) + skippedFrames + 1;
                } else {
                    current[i + g] = applyPrediction(
                        i + g,
                        frameDef.predictor[i + g],
                        groupValues[g],
                        current,
                        previous,
                        previous2,
                        skippedFrames,
                        sysConfig,
                        motor0Index,
                        lastMainFrameTime,
                    );
                }
            }

            i += actualGroupSize;
        } else {
            // --- Single-value encoding ---
            const raw = readFieldValue(stream, encoding, sysConfig.dataVersion, groupValues, 1);

            current[i] = applyPrediction(
                i,
                predictor,
                raw,
                current,
                previous,
                previous2,
                skippedFrames,
                sysConfig,
                motor0Index,
                lastMainFrameTime,
            );

            i++;
        }
    }

    // Sanity check: the frame should not have consumed a huge amount of data
    // relative to what is plausible.  If the stream moved more than ~2000
    // bytes for a single frame, it is almost certainly corrupt.
    if (stream.pos - posBeforeFrame > 2048) {
        return false;
    }

    return true;
}

/**
 * Try to skip an event frame. Returns true if we consumed a recognized
 * event, false if we had to scan for the next frame marker.
 */
function parseEventFrame(stream, _sysConfig) {
    const eventType = stream.readByte();

    switch (eventType) {
        case EVENT_LOG_END:
            // "End of log\0" — 11 bytes
            for (let i = 0; i < 11; i++) stream.readByte();
            return { type: EVENT_LOG_END };

        case EVENT_LOGGING_RESUME: {
            const logIteration = stream.readUnsignedVB();
            const currentTime = stream.readUnsignedVB();
            return { type: EVENT_LOGGING_RESUME, logIteration, currentTime };
        }

        case EVENT_SYNC_BEEP:
            // uint32 as UnsignedVB
            stream.readUnsignedVB();
            return { type: EVENT_SYNC_BEEP };

        case EVENT_INFLIGHT_ADJ: {
            // adjustmentFunction byte, then either 4-byte float or UnsignedVB
            const adjFunc = stream.readByte();
            if (adjFunc & 128) {
                // float — 4 bytes
                stream.readByte();
                stream.readByte();
                stream.readByte();
                stream.readByte();
            } else {
                stream.readUnsignedVB();
            }
            return { type: EVENT_INFLIGHT_ADJ };
        }

        case EVENT_DISARM:
            stream.readUnsignedVB();
            return { type: EVENT_DISARM };

        case EVENT_FLIGHTMODE:
            // flags + lastFlags, both UnsignedVB
            stream.readUnsignedVB();
            stream.readUnsignedVB();
            return { type: EVENT_FLIGHTMODE };

        default:
            // Unknown event — scan forward for the next valid frame marker.
            // This is a recovery heuristic for events we don't know the size of.
            return null; // signal the caller to scan
    }
}

/**
 * Is this byte a valid frame-start character?
 */
function isFrameMarker(byte) {
    return (
        byte === FRAME_TYPE_I ||
        byte === FRAME_TYPE_P ||
        byte === FRAME_TYPE_S ||
        byte === FRAME_TYPE_E ||
        byte === FRAME_TYPE_G ||
        byte === FRAME_TYPE_H
    );
}

/**
 * Scan forward from the current stream position to find the next valid
 * frame marker.  We look for a byte that is a frame marker AND is preceded
 * by at least one plausible data byte (i.e. we skip at most a few hundred
 * bytes of junk).
 */
function skipToNextFrame(stream) {
    const maxScan = 4096;
    for (let n = 0; n < maxScan && !stream.eof; n++) {
        const b = stream.readByte();
        if (b !== -1 && isFrameMarker(b)) {
            stream.unreadChar();
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Public API: parseChirpLog
// ---------------------------------------------------------------------------

/**
 * Parse a single flight log from a BBL file and extract chirp analysis data.
 *
 * @param {Uint8Array} data      The full BBL file as a Uint8Array.
 * @param {number}     logStart  Byte offset of the log start (from findLogBoundaries).
 * @param {number}     logEnd    Byte offset of the log end.
 * @returns {{ sysConfig: object, chirpData: object }}
 * @throws {Error} if the log is not a chirp/debug_mode=CHIRP log.
 */
export function parseChirpLog(data, logStart, logEnd) {
    // 1. Parse the text header
    const { sysConfig, frameDefs, dataStart } = parseHeader(data, logStart, logEnd);

    // 2. Validate debug_mode
    // DEBUG_CHIRP = 26 in the firmware enum (debug.h).  The header stores
    // the numeric value.
    const DEBUG_CHIRP = 26;
    if (sysConfig.debug_mode !== DEBUG_CHIRP) {
        throw new Error(
            `Log debug_mode is ${sysConfig.debug_mode}, expected ${DEBUG_CHIRP} (CHIRP). ` +
                "This log was not recorded with debug_mode = CHIRP.",
        );
    }

    // 3. Resolve field indices for the fields we care about
    const fi = sysConfig.fieldIndices;

    const setpointIdx = [fi["setpoint[0]"] ?? -1, fi["setpoint[1]"] ?? -1, fi["setpoint[2]"] ?? -1];
    const gyroIdx = [fi["gyroADC[0]"] ?? -1, fi["gyroADC[1]"] ?? -1, fi["gyroADC[2]"] ?? -1];
    const debugIdx = [fi["debug[0]"] ?? -1, fi["debug[1]"] ?? -1, fi["debug[2]"] ?? -1, fi["debug[3]"] ?? -1];

    // Verify essential fields exist
    for (let axis = 0; axis < 3; axis++) {
        if (setpointIdx[axis] === -1) {
            throw new Error(`Missing setpoint[${axis}] field in log header`);
        }
        if (gyroIdx[axis] === -1) {
            throw new Error(`Missing gyroADC[${axis}] field in log header`);
        }
    }
    for (let d = 0; d < 4; d++) {
        if (debugIdx[d] === -1) {
            throw new Error(`Missing debug[${d}] field in log header`);
        }
    }

    // Find motor[0] index for the MOTOR_0 predictor
    const motor0Index = fi["motor[0]"] ?? -1;

    // Find flightModeFlags index in S-frame
    const sFrameFlightModeFlagsIdx = frameDefs.S.name.indexOf("flightModeFlags");

    // 4. Prepare frame history buffers
    const fieldCount = frameDefs.I.count;
    const sFieldCount = frameDefs.S.count;

    // Current and history frames for I/P decoding
    let current = new Int32Array(fieldCount);
    let previous = null;
    let previous2 = null;
    let lastIFrame = null;

    // S-frame
    let sFrameCurrent = new Int32Array(sFieldCount);

    // Track chirp-active state from S-frame flightModeFlags
    let chirpActive = false;

    // Track last main frame time for PREDICTOR_LAST_MAIN_FRAME_TIME
    let lastMainFrameTime = 0;

    // High-resolution scaling factor: if high_resolution=1, gyro and
    // setpoint values are stored 10x, so divide by 10 before analysis.
    const hiResScale = sysConfig.blackbox_high_resolution ? 0.1 : 1.0;

    // 5. Collect samples during chirp-active periods
    // We accumulate into regular arrays, then convert to Float32Array at the end.
    const rawSetpoint = [[], [], []];
    const rawGyro = [[], [], []];
    const rawDebug = [[], [], [], []];
    const segments = []; // { axis, startIdx, endIdx }

    let currentAxis = -1;

    // 6. Parse binary frames
    const stream = new ArrayDataStream(data, dataStart, logEnd);
    let frameCount = 0;
    let corruptFrameCount = 0;
    const maxCorrupt = 500; // bail out if too many corrupt frames

    while (!stream.eof && corruptFrameCount < maxCorrupt) {
        const frameType = stream.readByte();
        if (frameType === -1) break; // EOF

        switch (frameType) {
            case FRAME_TYPE_I: {
                // --- Intraframe ---
                const saved = stream.pos;
                const ok = parseFrame(
                    stream,
                    frameDefs.I,
                    current,
                    lastIFrame,
                    null,
                    0,
                    sysConfig,
                    motor0Index,
                    lastMainFrameTime,
                );

                if (!ok) {
                    stream.pos = saved;
                    if (!skipToNextFrame(stream)) stream.pos = stream.end;
                    corruptFrameCount++;
                    break;
                }

                // Update history
                previous2 = previous;
                previous = current;
                lastIFrame = new Int32Array(current);
                current = new Int32Array(fieldCount);

                // Update time tracking
                const timeIdx = fi["time"] ?? fi["time(us)"] ?? 1;
                lastMainFrameTime = previous[timeIdx];
                // loopIteration tracking removed — sequential parsing doesn't need skippedFrames

                // Collect sample if chirp is active
                if (chirpActive) {
                    collectSample(previous, setpointIdx, gyroIdx, debugIdx, rawSetpoint, rawGyro, rawDebug, hiResScale);
                    updateSegments(previous, debugIdx, segments, rawSetpoint[0].length - 1, currentAxis);
                    currentAxis = previous[debugIdx[1]];
                }

                frameCount++;
                break;
            }

            case FRAME_TYPE_P: {
                // --- Interframe ---
                if (!previous) {
                    // No preceding I-frame yet — skip
                    if (!skipToNextFrame(stream)) stream.pos = stream.end;
                    break;
                }

                // Calculate skipped frames.
                // In the stream, the P-frame does not store loopIteration
                // (it uses PREDICTOR_INC). The number of skipped P-frames
                // between the last frame and this one is encoded implicitly.
                // The parser reads the INC predictor during parseFrame, so
                // skippedFrames just needs to be 0 for a normal sequential P-frame.
                // The blackbox viewer sets skippedFrames to the count of
                // absent P-frames since the last frame; for our purposes
                // (chirp data), we decode sequentially and set 0.
                const skippedFrames = 0;

                const saved = stream.pos;
                const ok = parseFrame(
                    stream,
                    frameDefs.P,
                    current,
                    previous,
                    previous2,
                    skippedFrames,
                    sysConfig,
                    motor0Index,
                    lastMainFrameTime,
                );

                if (!ok) {
                    stream.pos = saved;
                    if (!skipToNextFrame(stream)) stream.pos = stream.end;
                    corruptFrameCount++;
                    break;
                }

                // Update history
                previous2 = previous;
                previous = current;
                current = new Int32Array(fieldCount);

                // Update time
                const timeIdx = fi["time"] ?? fi["time(us)"] ?? 1;
                lastMainFrameTime = previous[timeIdx];

                // Collect sample if chirp is active
                if (chirpActive) {
                    collectSample(previous, setpointIdx, gyroIdx, debugIdx, rawSetpoint, rawGyro, rawDebug, hiResScale);
                    updateSegments(previous, debugIdx, segments, rawSetpoint[0].length - 1, currentAxis);
                    currentAxis = previous[debugIdx[1]];
                }

                frameCount++;
                break;
            }

            case FRAME_TYPE_S: {
                // --- Slow frame ---
                const saved = stream.pos;
                const ok = parseFrame(stream, frameDefs.S, sFrameCurrent, null, null, 0, sysConfig, -1, 0);

                if (!ok) {
                    stream.pos = saved;
                    if (!skipToNextFrame(stream)) stream.pos = stream.end;
                    corruptFrameCount++;
                    break;
                }

                // Update chirp-active flag from flightModeFlags
                if (sFrameFlightModeFlagsIdx >= 0) {
                    const flags = sFrameCurrent[sFrameFlightModeFlagsIdx];
                    const wasActive = chirpActive;
                    chirpActive = (flags & (1 << BOXCHIRP_BIT)) !== 0;

                    // If chirp just became active, start a new segment
                    if (chirpActive && !wasActive) {
                        currentAxis = -1; // will be set from debug[1] on next data frame
                    }
                    // If chirp just became inactive, close any open segment
                    if (!chirpActive && wasActive) {
                        closeSegment(segments, rawSetpoint[0].length - 1, currentAxis);
                        currentAxis = -1;
                    }
                }
                break;
            }

            case FRAME_TYPE_E: {
                // --- Event frame ---
                const event = parseEventFrame(stream, sysConfig);

                if (!event) {
                    // Unknown event — scan for next frame
                    if (!skipToNextFrame(stream)) stream.pos = stream.end;
                    corruptFrameCount++;
                } else if (event.type === EVENT_LOG_END) {
                    // End of this log
                    stream.pos = stream.end;
                } else if (event.type === EVENT_LOGGING_RESUME) {
                    // After a logging resume, the frame history is invalid
                    previous = null;
                    previous2 = null;
                    lastIFrame = null;
                    lastMainFrameTime = event.currentTime;
                }
                break;
            }

            case FRAME_TYPE_G:
            case FRAME_TYPE_H:
                // GPS frames — skip by scanning to the next frame marker.
                // We don't need GPS data for chirp analysis.
                if (!skipToNextFrame(stream)) stream.pos = stream.end;
                break;

            default:
                // Unknown frame type — likely corruption. Scan ahead.
                if (!skipToNextFrame(stream)) stream.pos = stream.end;
                corruptFrameCount++;
                break;
        }
    }

    // Close any open segment at end of data
    if (currentAxis >= 0) {
        closeSegment(segments, rawSetpoint[0].length - 1, currentAxis);
    }

    // 7. Convert accumulated arrays to Float32Arrays
    const sampleCount = rawSetpoint[0].length;
    const chirpData = {
        setpoint: [
            new Float32Array(rawSetpoint[0]),
            new Float32Array(rawSetpoint[1]),
            new Float32Array(rawSetpoint[2]),
        ],
        gyro: [new Float32Array(rawGyro[0]), new Float32Array(rawGyro[1]), new Float32Array(rawGyro[2])],
        debug: [
            new Float32Array(rawDebug[0]),
            new Float32Array(rawDebug[1]),
            new Float32Array(rawDebug[2]),
            new Float32Array(rawDebug[3]),
        ],
        segments,
        sampleCount,
        totalFrames: frameCount,
        corruptFrames: corruptFrameCount,
    };

    return { sysConfig, chirpData };
}

// ---------------------------------------------------------------------------
// Sample collection helpers
// ---------------------------------------------------------------------------

/**
 * Extract the setpoint, gyro, and debug values from a decoded frame and
 * append them to the accumulation arrays.
 */
function collectSample(frame, setpointIdx, gyroIdx, debugIdx, rawSetpoint, rawGyro, rawDebug, hiResScale) {
    for (let axis = 0; axis < 3; axis++) {
        rawSetpoint[axis].push(frame[setpointIdx[axis]] * hiResScale);
        rawGyro[axis].push(frame[gyroIdx[axis]] * hiResScale);
    }
    for (let d = 0; d < 4; d++) {
        rawDebug[d].push(frame[debugIdx[d]]);
    }
}

/**
 * Track axis-based segment boundaries. debug[1] holds the current chirp
 * axis (0=roll, 1=pitch, 2=yaw) or -1 when chirp is inactive.
 *
 * When the axis changes (or first appears), close the old segment and
 * start a new one.
 */
function updateSegments(frame, debugIdx, segments, sampleIdx, prevAxis) {
    const axis = frame[debugIdx[1]];

    if (axis < 0) {
        // Chirp signal is not active in this frame (debug[1] = -1)
        if (prevAxis >= 0) {
            closeSegment(segments, sampleIdx - 1, prevAxis);
        }
        return;
    }

    if (axis !== prevAxis) {
        // Axis changed — close old segment, open new one
        if (prevAxis >= 0) {
            closeSegment(segments, sampleIdx - 1, prevAxis);
        }
        segments.push({ axis, startIdx: sampleIdx, endIdx: sampleIdx });
    }
}

/**
 * Close the most recent segment by setting its endIdx.
 */
function closeSegment(segments, endIdx, axis) {
    if (segments.length > 0) {
        const last = segments[segments.length - 1];
        if (last.axis === axis) {
            last.endIdx = endIdx;
        }
    }
}
