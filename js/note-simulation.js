import { settings } from './settings.js';
import { keyToMidi, isSharp, channelColors } from './piano-constants.js';
import { WinW, WinH, createNote } from './webgl.js';
import { triggerKey, pressKeyVisual, releaseKeyVisual, releaseKey } from './keyboard.js';

let liveNotesPool = [];
let activeLiveNotes = 0;
let activeNotes = [];
let keyHoldCounts = new Array(128).fill(0);

const MAX_LIVE_NOTES = 28000;

let noteSimWorker = null;

function createNoteSimulationWorker() {
    const workerSrc = `
self.onmessage = function(e) {
    const data = e.data;
    if (data.type === 'findWorst') {
        const notes = data.notes;
        let worst = null, worstY = -Infinity;
        for (let i = 0; i < notes.length; i++) {
            const n = notes[i];
            if (n && n.active && n.yb > worstY) {
                worstY = n.yb;
                worst = n;
            }
        }
        self.postMessage({ type: 'worstResult', worstIndex: worst ? data.notes.indexOf(worst) : -1 });
    }
};
    `;
    const blob = new Blob([workerSrc], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

if (typeof Worker !== 'undefined') {
    try {
        noteSimWorker = createNoteSimulationWorker();
        noteSimWorker.onmessage = function(e) {
            const msg = e.data;
            if (msg.type === 'worstResult' && msg.worstIndex >= 0) {
                window.__lastWorkerWorstIndex = msg.worstIndex;
            }
        };
    } catch (e) {
        console.warn('Could not create Web Worker for multithreading support');
    }
}

function spawnLiveNote(midiK, velocity=127, eventTime=null, currentTime=null, durationMs=0, colorIdx = 0, layerInfo = null, midiPlayer = null){
    const c = channelColors[ colorIdx % channelColors.length ];
    addLiveNote(midiK, c, velocity, eventTime, currentTime, durationMs, colorIdx, layerInfo, midiPlayer);
}

function addLiveNote(k, color, velocity=127, eventTime=null, currentTime=null, durationMs=0, channel = 0, layerInfo = null, midiPlayer = null){
    const kbTop  = WinH - WinW * 82 / 1000;
    const pxPerMs = settings.get('noteSpeed') / 8;
    const hitTime = eventTime;
    let ybNow;
    let songTime = 0;
    if (midiPlayer && midiPlayer.isPlaying && midiPlayer.startTimestamp) {
        songTime = performance.now() - midiPlayer.startTimestamp;
    }
    if (hitTime != null && songTime > 0) {
        const msUntilHit = hitTime - songTime;
        ybNow = kbTop - msUntilHit * pxPerMs;
    } else {
        const msUntilHit = (eventTime !== null && currentTime !== null) ? (eventTime - currentTime) : -9999;
        ybNow = kbTop - msUntilHit * pxPerMs;
    }
    const noteLenPx = (durationMs > 0) ? (durationMs * pxPerMs) : 20;
    const makeNote = (n) => {
        n.k = k; n.color = color; n.channel = channel; n.velocity = velocity;
        n.yb = ybNow; n.ye = ybNow - noteLenPx; n.active = true;
        n.spawnTime = performance.now(); n.ybAtSpawn = ybNow;
        n.keyPressed = false; n.hitTime = hitTime; n.eventTime = eventTime;
        n.durationMs = durationMs || 0;
        if (layerInfo) {
            n.originalNoteId = layerInfo.originalNoteId || null; n.layerType = layerInfo.layerType || null;
            n.visualOnly = !!layerInfo.visualOnly; n.renderColor = layerInfo.renderColor || null;
            n.opacity = (typeof layerInfo.opacity === 'number') ? layerInfo.opacity : 1.0;
            n.laneOffset = (typeof layerInfo.laneOffset === 'number') ? layerInfo.laneOffset : 0;
        } else {
            n.originalNoteId = null; n.layerType = null; n.visualOnly = false;
            n.renderColor = null; n.opacity = 1.0; n.laneOffset = 0;
        }
    };
    if(activeLiveNotes >= MAX_LIVE_NOTES){
        if (noteSimWorker) {
            const poolSnapshot = liveNotesPool.map(n => n ? {active: n.active, yb: n.yb, index: liveNotesPool.indexOf(n)} : null);
            noteSimWorker.postMessage({ type: 'findWorst', notes: poolSnapshot });

            let worst = null, worstY = -Infinity;
            for (let i = 0; i < liveNotesPool.length; i++) {
                const n = liveNotesPool[i];
                if (n && n.active && n.yb > worstY) { worstY = n.yb; worst = n; }
            }
            if (worst) makeNote(worst);
        } else {
            let worst = null, worstY = -Infinity;
            for (let i = 0; i < liveNotesPool.length; i++) {
                const n = liveNotesPool[i];
                if (n && n.active && n.yb > worstY) { worstY = n.yb; worst = n; }
            }
            if (worst) makeNote(worst);
        }
        return;
    }
    let note = liveNotesPool.find(n => !n.active);
    if(!note){ note = {}; liveNotesPool.push(note); }
    makeNote(note);
    activeNotes.push(note);
    activeLiveNotes++;
}

function updateLiveNotes(midiPlayer = null, now = performance.now()){
    const kbTop = WinH - WinW * 82 / 1000;
    const highNoteDensity = activeLiveNotes > 2200;
    const pxPerMs = settings.get('noteSpeed') / 8;

    const isPaused = midiPlayer && !midiPlayer.isPlaying;

    let playbackTime = 0;
    if (midiPlayer && midiPlayer.isPlaying && midiPlayer.startTimestamp) {
        playbackTime = performance.now() - midiPlayer.startTimestamp;
    }

    const retireMarginLong  = 400;
    const retireMarginShort = 260;
    const glowStrength = (typeof settings !== 'undefined' && settings.get) ? (settings.get('glowStrength') || 0) : 0.5;

    for (let i = activeNotes.length - 1; i >= 0; i--) {
        const n = activeNotes[i];
        if (!n || !n.active) {
            activeNotes[i] = activeNotes[activeNotes.length - 1];
            activeNotes.pop();
            continue;
        }

        if (!isPaused) {
            if (n.hitTime != null && playbackTime > 0) {
                const timeToHit = n.hitTime - playbackTime;
                n.yb = kbTop - timeToHit * pxPerMs;
            } else {
                const elapsed = now - n.spawnTime;
                n.yb = n.ybAtSpawn + elapsed * pxPerMs;
            }
            if (n.durationMs > 0) {
                n.ye = n.yb - n.durationMs * pxPerMs;
            } else {
                n.ye = n.yb - 20;
            }

            if (!n.visualOnly) {
                if (n.durationMs > 0) {
                    if (!n.keyPressed && n.yb >= kbTop) {
                        n.keyPressed = true;
                        keyHoldCounts[n.k] = (keyHoldCounts[n.k] || 0) + 1;
                        if (keyHoldCounts[n.k] === 1) {
                            const noteColor = (n.channel != null) ? channelColors[n.channel % channelColors.length] : n.color;
                            if (midiPlayer && midiPlayer.isPlaying) {
                                pressKeyVisual(n.k, noteColor);
                            } else {
                                triggerKey(n.k, n.velocity, noteColor);
                            }
                        }
                    }
                    if (n.keyPressed && n.ye >= kbTop) {
                        keyHoldCounts[n.k] = Math.max(0, (keyHoldCounts[n.k] || 0) - 1);
                        n.keyPressed = false;
                        if (keyHoldCounts[n.k] === 0) {
                            if (midiPlayer && midiPlayer.isPlaying) {
                                releaseKeyVisual(n.k);
                            } else {
                                releaseKey(n.k);
                            }
                        }
                    }
                } else {
                    if (!n.keyPressed && n.yb >= kbTop) {
                        n.keyPressed = true;
                        if (midiPlayer && midiPlayer.isPlaying) {
                            pressKeyVisual(n.k, n.color);
                        } else {
                            triggerKey(n.k, n.velocity, n.color);
                        }
                    }
                }
            }

            const retireMargin = (n.durationMs > 0 ? retireMarginLong : retireMarginShort);
            if (n.ye >= kbTop + retireMargin) {
                if (n.keyPressed) {
                    keyHoldCounts[n.k] = Math.max(0, (keyHoldCounts[n.k] || 0) - 1);
                    if (keyHoldCounts[n.k] === 0) {
                        if (midiPlayer && midiPlayer.isPlaying) {
                            releaseKeyVisual(n.k);
                        } else {
                            releaseKey(n.k);
                        }
                    }
                    n.keyPressed = false;
                }
                n.active = false;
                activeLiveNotes--;
                activeNotes[i] = activeNotes[activeNotes.length - 1];
                activeNotes.pop();
                continue;
            }
            if (n.yb < -12000 && !n.keyPressed) {
                n.active = false;
                activeLiveNotes--;
                activeNotes[i] = activeNotes[activeNotes.length - 1];
                activeNotes.pop();
                continue;
            }
        }

        if (n.yb > 0 && n.ye < WinH) {
            const midiNote = keyToMidi(n.k);
            n._isSharp = isSharp(midiNote);
        }
    }

    const notesCY = kbTop;
    const fadeDuration = 1500;
    const fadeAlpha = playbackTime > 0 ? Math.max(0, 255 - Math.round(255 * Math.min(fadeDuration, playbackTime) / fadeDuration)) : 255;

    for (let i = 0; i < activeNotes.length; i++) {
        const n = activeNotes[i];
        if (!n.active || !n.yb || n.yb <= 0 || n.ye >= WinH || n._isSharp) continue;

        let noteColor = n.renderColor != null ? n.renderColor : (n.channel != null ? channelColors[n.channel % channelColors.length] : n.color);
        if (n.opacity != null && n.opacity < 1) {
            const r = (noteColor >> 16) & 0xFF, g = (noteColor >> 8) & 0xFF, b = noteColor & 0xFF;
            const op = Math.max(0.15, Math.min(1, n.opacity));
            noteColor = 0xFF000000 | (((b * op) | 0) << 16) | (((g * op) | 0) << 8) | ((r * op) | 0);
        }
        createNote(n.k, n.yb, Math.max(0, n.ye), noteColor, highNoteDensity, n.laneOffset || 0, n.opacity || 1, n.layerType, n.velocity ?? 127, glowStrength, notesCY, fadeAlpha);
    }

    for (let i = 0; i < activeNotes.length; i++) {
        const n = activeNotes[i];
        if (!n.active || !n.yb || n.yb <= 0 || n.ye >= WinH || !n._isSharp) continue;

        let noteColor = n.renderColor != null ? n.renderColor : (n.channel != null ? channelColors[n.channel % channelColors.length] : n.color);
        if (n.opacity != null && n.opacity < 1) {
            const r = (noteColor >> 16) & 0xFF, g = (noteColor >> 8) & 0xFF, b = noteColor & 0xFF;
            const op = Math.max(0.15, Math.min(1, n.opacity));
            noteColor = 0xFF000000 | (((b * op) | 0) << 16) | (((g * op) | 0) << 8) | ((r * op) | 0);
        }
        createNote(n.k, n.yb, Math.max(0, n.ye), noteColor, highNoteDensity, n.laneOffset || 0, n.opacity || 1, n.layerType, n.velocity ?? 127, glowStrength, notesCY, fadeAlpha);
    }
}

export { liveNotesPool, activeNotes, activeLiveNotes, keyHoldCounts, MAX_LIVE_NOTES,
         addLiveNote, spawnLiveNote, updateLiveNotes, noteSimWorker };
