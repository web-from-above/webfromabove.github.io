const yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0));

const SharpRatio = 0.64;
const KeyMap = [
     0,  2,  4,  5,  7,  9, 11, 12, 14, 16, 17, 19, 21, 23, 24, 26,
    28, 29, 31, 33, 35, 36, 38, 40, 41, 43, 45, 47, 48, 50, 52, 53,
    55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81,
    83, 84, 86, 88, 89, 91, 93, 95, 96, 98,100,101,103,105,107,108,
   110,112,113,115,117,119,120,122,124,125,127,  1,  3,  6,  8, 10,
    13, 15, 18, 20, 22, 25, 27, 30, 32, 34, 37, 39, 42, 44, 46, 49,
    51, 54, 56, 58, 61, 63, 66, 68, 70, 73, 75, 78, 80, 82, 85, 87,
    90, 92, 94, 97, 99,102,104,106,109,111,114,116,118,121,123,126,
];
const MidiToKey = new Array(128).fill(-1);
for (let ki = 0; ki < 128; ki++) { const midi = KeyMap[ki]; if (midi >= 0 && midi < 128) MidiToKey[midi] = ki; }
function keyToMidi(k)  { return KeyMap[k]; }
function midiToKey(m)  { return MidiToKey[m]; }
function isSharp(n)    { const m = n % 12; return m===1||m===3||m===6||m===8||m===10; }

function whiteCount(startNote, upToNote) {
    let count = 0;
    for (let n = startNote; n < upToNote; n++) {
        if (!isSharp(n)) count++;
    }
    return count;
}

const GenKeyX = [0, 12, 18, 33, 36, 54, 66, 72, 85, 90, 105, 108];

const NoteColors = [
    0xFF0000,0x00FF00,0x0088FF,0xFFFF00,0xFF8800,0xFF00FF,0x00FFFF,0xFF4488,
    0x88FF44,0x4488FF,0xFFAA00,0xAA00FF,0x00FFAA,0xFF6644,0x44FF88,0xAACCFF,
];
const channelColors = NoteColors;

const trackColorIdx = { value: 0 };

function hslToInt(r, g, b) {
    return 0xFF000000 | ((b & 0xFF) << 16) | ((g & 0xFF) << 8) | (r & 0xFF);
}

function createSeededRNG(seed) {
    let s = (seed >>> 0) || 42;
    return function() {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function generateProceduralLayers(allEvents, params = {}) {
    const {
        intensity = 1.0,
        maxNotes = 150000,
        octaveSpread = 2,
        trillDensity = 0.6,
        decorativeDensity = 0.8,
        visualThickness = 1.8,
        glowStrength = 0.5,
        randomSeed = 42
    } = params;
    if (!allEvents || intensity <= 0) return [];
    if (allEvents.length > 2500) {
        console.warn('Too many events for procedural layering — skipping to avoid stack overflow');
        return [];
    }
    const rng = createSeededRNG(randomSeed | 0);
    const origNoteOns = [];
    for (let i = 0; i < allEvents.length; i++) {
        const e = allEvents[i];
        if (e.type === 'noteOn' && e.velocity > 0 && typeof e.absMs === 'number') {
            origNoteOns.push(Object.assign({}, e, {_id: i}));
        }
    }
    if (origNoteOns.length === 0) return [];
    const generated = [];
    let genCount = 0;
    const MAX_G = Math.min(maxNotes, 400000);
    const addSynth = (obj) => {
        if (genCount >= MAX_G) return false;
        generated.push(obj);
        genCount++;
        return true;
    };

    const BIN = 50;
    const t0 = origNoteOns[0].absMs;
    const t1 = origNoteOns[origNoteOns.length - 1].absMs + 1;
    const nBins = Math.max(8, Math.ceil((t1 - t0) / BIN) + 4);
    const dens = new Uint16Array(nBins);
    for (let ii = 0; ii < origNoteOns.length; ii++) {
        const bb = Math.max(0, Math.min(nBins - 1, Math.floor((origNoteOns[ii].absMs - t0) / BIN)));
        dens[bb]++;
    }
    const localDens = (t) => {
        const bb = Math.max(0, Math.min(nBins - 1, Math.floor((t - t0) / BIN)));
        let s = 0, cnt = 0;
        for (let d = -3; d <= 3; d++) {
            const b2 = bb + d; if (b2 >= 0 && b2 < nBins) { s += dens[b2]; cnt++; }
        }
        return cnt ? (s / cnt) : 0;
    };

    let effIntensity = intensity;
    const nNotes = origNoteOns.length;
    const spanMs = (origNoteOns[nNotes-1].absMs - origNoteOns[0].absMs) || 1;
    const roughDens = nNotes / (spanMs / 1200);
    if (nNotes < 900 || roughDens < 2.6) effIntensity *= 0.10;
    if (effIntensity < 0.035) return [];

    const octs = [-24, -12, 12, 24];
    const baseP = [0.65, 0.92, 0.88, 0.55];
    const nOct = Math.min(octaveSpread + 1, 3);
    for (let i = 0; i < origNoteOns.length && genCount < MAX_G; i++) {
        if ((i & 127) === 0) await yieldToMain();
        const o = origNoteOns[i];
        for (let j = 0; j < octs.length; j++) {
            if (j >= nOct * 2) break;
            if (rng() < baseP[j] * effIntensity * (1 - Math.abs(octs[j]) / 38)) {
                const np = Math.max(0, Math.min(127, o.note + octs[j]));
                const vs = 0.58 + rng() * 0.25 - Math.abs(octs[j]) / 52;
                const v = Math.max(18, Math.min(127, (o.velocity * vs) | 0));
                const dur = Math.max(8, o.durationMs * (0.65 + rng() * 0.7));
                if (!addSynth({
                    type: 'noteOn', note: np, velocity: v, channel: o.channel | 0, track: (o.track | 0) + 100,
                    absMs: o.absMs + (rng() - 0.5) * 1.5, durationMs: dur,
                    visualOnly: true, layerType: 'octave', originalNoteId: 'o' + o._id,
                    renderColor: null, opacity: 0.78 + rng() * 0.2, laneOffset: 0
                })) break;
            }
        }
    }

    const CH_W = 42;
    const chords = [];
    let grp = [], lt = -1e9;
    for (let i = 0; i < origNoteOns.length; i++) {
        const o = origNoteOns[i];
        if (o.absMs - lt > CH_W) { if (grp.length > 1) chords.push(grp); grp = [o]; }
        else grp.push(o);
        lt = o.absMs;
    }
    if (grp.length > 1) chords.push(grp);
    const chordFactor = effIntensity * (1.1 + Math.min(2, chords.length / 40));
    for (let ci = 0; ci < chords.length && genCount < MAX_G; ci++) {
        if ((ci & 31) === 0) await yieldToMain();
        const g = chords[ci];
        const per = (g.length > 4 ? 2.2 : 1.1) * chordFactor;
        const adds = 1 + (rng() * per * 1.5) | 0;
        for (let gi = 0; gi < g.length; gi++) {
            const o = g[gi];
            for (let a = 0; a < adds && genCount < MAX_G; a++) {
                let iv = [7, 12, -12, 19, -5, 4, 3, 2, -2, 1, -1][(a + (rng() * 11) | 0) % 11];
                if (rng() < 0.35) iv += (rng() < 0.5 ? 1 : -1);
                if (rng() < 0.2) iv = ((rng() * 25) | 0) - 12;
                const np = Math.max(0, Math.min(127, o.note + iv));
                const v = Math.max(12, (o.velocity * (0.35 + rng() * 0.35)) | 0);
                const d = 20 + rng() * Math.min(180, o.durationMs * 0.5);
                addSynth({
                    type: 'noteOn', note: np, velocity: v, channel: ((o.channel | 0) + a) % 16, track: -10,
                    absMs: o.absMs + (rng() - 0.5) * 6, durationMs: d,
                    visualOnly: true, layerType: 'chord', originalNoteId: 'o' + o._id,
                    renderColor: rng() < 0.25 ? 0xFFFFFF : null, opacity: 0.55 + rng() * 0.35, laneOffset: 0
                });
            }
        }
    }

    const tD = trillDensity * effIntensity;
    if (tD > 0.04) {
        const subs = [8, 16, 32, 64];
        for (let i = 0; i < origNoteOns.length && genCount < MAX_G; i++) {
            if ((i & 63) === 0) await yieldToMain();
            const o = origNoteOns[i];
            if (rng() > tD * 0.85) continue;
            const sub = subs[(rng() * subs.length) | 0];
            const beatMs = 480;
            const iv = beatMs / (sub / 4);
            const nT = Math.max(2, Math.min(90, ((o.durationMs || 180) / iv * tD * 1.3) | 0));
            let alt = 0, tt = o.absMs;
            for (let tr = 0; tr < nT && genCount < MAX_G; tr++) {
                const jitt = (rng() - 0.5) * iv * 0.45;
                const np = Math.max(0, Math.min(127, o.note + (alt ? ((rng() < 0.5) ? 1 : -1) : 0)));
                const vv = 25 + (rng() * 38) | 0;
                const dd = Math.max(6, iv * (0.55 + rng() * 0.9));
                addSynth({
                    type: 'noteOn', note: np, velocity: vv, channel: o.channel | 0, track: -20,
                    absMs: tt + jitt, durationMs: dd,
                    visualOnly: true, layerType: 'trill', originalNoteId: 'o' + o._id,
                    renderColor: null, opacity: 0.48, laneOffset: 0
                });
                tt += iv;
                alt = 1 - alt;
            }
        }
    }

    const decD = decorativeDensity * effIntensity;
    if (decD > 0.03) {
        const target = Math.min(18000, (origNoteOns.length * decD * 0.45) | 0);
        for (let d = 0; d < target && genCount < MAX_G; d++) {
            if ((d & 127) === 0) await yieldToMain();
            const bi = (rng() * origNoteOns.length) | 0;
            const base = origNoteOns[bi];
            const pat = (rng() * 5) | 0;
            let np0 = base.note + ((rng() * 11 - 5) | 0);
            let t0loc = base.absMs + (rng() - 0.5) * 280;
            const steps = 3 + ((rng() * (4 + decD * 7)) | 0);
            for (let s = 0; s < steps && genCount < MAX_G; s++) {
                let np = np0, tt = t0loc + s * 19;
                if (pat === 0) { np = 22 + ((rng() * 82) | 0); tt = base.absMs + (rng() - 0.5) * 420; }
                else if (pat === 1) { np = np0 + (s * (rng() < 0.6 ? 1 : 2)); }
                else if (pat === 2) { np = base.note + ((Math.sin(s * 0.9) * (3 + decD * 4)) | 0); tt += s * 7; }
                else if (pat === 3) { np = np0 + s; tt += s * 4; }
                else if (s % 2 === 1) continue;
                np = Math.max(0, Math.min(127, np));
                addSynth({
                    type: 'noteOn', note: np, velocity: 14 + ((rng() * 23) | 0), channel: 7, track: -30,
                    absMs: tt, durationMs: 18 + rng() * 55,
                    visualOnly: true, layerType: 'decor', originalNoteId: 'o' + base._id,
                    renderColor: 0xFF223344, opacity: 0.32 + rng() * 0.25, laneOffset: 0
                });
            }
        }
    }

    let lastG = -99999;
    for (let i = 0; i < origNoteOns.length && genCount < MAX_G; i++) {
        if ((i & 63) === 0) await yieldToMain();
        const o = origNoteOns[i];
        const ld = localDens(o.absMs);
        const strong = ld > 4.2 || o.velocity > 108 || rng() < 0.018;
        if (!strong || o.absMs - lastG < 160) continue;
        lastG = o.absMs;
        const dir = rng() < 0.5 ? 1 : -1;
        const glLen = 4 + ((effIntensity * (6 + ld * 0.6)) | 0);
        let cp = o.note - dir * ((glLen / 2) | 0);
        const stp = 11 + rng() * 7;
        for (let g = 0; g < glLen && genCount < MAX_G; g++) {
            const np = Math.max(0, Math.min(127, cp));
            const epos = g / glLen;
            const ve = Math.max(8, (o.velocity * 0.75 * (1 - Math.abs(epos - 0.5) * 1.75)) | 0);
            addSynth({
                type: 'noteOn', note: np, velocity: ve, channel: o.channel | 0, track: -40,
                absMs: o.absMs + g * stp + (rng() - 0.5) * 2, durationMs: 22 + rng() * 18,
                visualOnly: true, layerType: 'gliss', originalNoteId: 'o' + o._id,
                renderColor: null, opacity: 0.72, laneOffset: 0
            });
            cp += dir;
        }
    }

    const amp = effIntensity * 0.95;
    if (amp > 0.08) {
        for (let b = 0; b < nBins && genCount < MAX_G; b++) {
            if ((b & 31) === 0) await yieldToMain();
            if (dens[b] <= 2 && rng() < amp * 0.55) {
                const tB = t0 + b * BIN + rng() * BIN;
                const fills = 1 + ((rng() * (2 + amp * 5)) | 0);
                for (let f = 0; f < fills && genCount < MAX_G; f++) {
                    const np = 28 + ((rng() * 72) | 0);
                    addSynth({
                        type: 'noteOn', note: np, velocity: 16 + ((rng() * 20) | 0), channel: 10, track: -50,
                        absMs: tB + (f - fills / 2) * 22, durationMs: 35 + rng() * 90,
                        visualOnly: true, layerType: 'density', originalNoteId: 'dens' + b,
                        renderColor: 0xFF112211, opacity: 0.38, laneOffset: 0
                    });
                }
            }
        }
    }

    const lanes = Math.max(1, Math.floor(visualThickness));
    if (lanes > 1) {
        const sample = generated.length;
        for (let L = 1; L < lanes && genCount < MAX_G; L++) {
            const laneOff = (L - (lanes - 1) * 0.5) * 0.95;
            for (let si = 0; si < sample && genCount < MAX_G; si += (L > 1 ? 3 : 1)) {
                const base = generated[si];
                if (!base || !base.visualOnly) continue;
                const ghost = Object.assign({}, base, {
                    absMs: base.absMs + (rng() - 0.5) * 0.8,
                    layerType: (base.layerType || 'layer') + 'L',
                    originalNoteId: base.originalNoteId + 'L' + L,
                    laneOffset: laneOff + (rng() - 0.5) * 0.4,
                    opacity: Math.max(0.25, (base.opacity || 0.6) * 0.6)
                });
                if (rng() < 0.06) ghost.note = Math.max(0, Math.min(127, ghost.note + (rng() < 0.5 ? -1 : 1)));
                addSynth(ghost);
            }
        }
        for (let oi = 0; oi < origNoteOns.length && genCount < MAX_G; oi += 5) {
            const o = origNoteOns[oi];
            for (let L = 1; L < Math.min(3, lanes); L++) {
                const off = (L - 1) * 0.8 + (rng() - 0.5) * 0.2;
                addSynth({
                    type: 'noteOn', note: o.note, velocity: ((o.velocity * 0.55) | 0), channel: o.channel | 0,
                    absMs: o.absMs + L * 0.2, durationMs: o.durationMs || 60,
                    visualOnly: true, layerType: 'laneBase', originalNoteId: 'o' + o._id + 'Lb' + L,
                    renderColor: null, opacity: 0.5, laneOffset: off
                });
            }
        }
    }

    for (let gi = 0; gi < generated.length; gi++) {
        const g = generated[gi];
        if (g.layerType && (g.layerType.indexOf('gliss') >= 0 || g.layerType.indexOf('chord') >= 0 || g.layerType.indexOf('trill') >= 0 || rng() < 0.09)) {
            const h = ((g.note % 12) * 30) % 360;
            const rr = 130 + ((Math.sin(h * 0.017) * 95) | 0);
            const gg = 150 + ((Math.cos(h * 0.022) * 85) | 0);
            const bb = 195 + ((Math.sin(h * 0.013 + 1) * 70) | 0);
            g.renderColor = hslToInt(rr, gg, bb);
        }
    }

    return generated;
}

export { SharpRatio, KeyMap, MidiToKey, GenKeyX, NoteColors, channelColors, trackColorIdx,
         keyToMidi, midiToKey, isSharp, whiteCount, hslToInt, createSeededRNG, generateProceduralLayers,
         yieldToMain };
