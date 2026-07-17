import { settings } from './settings.js';
import { midiToKey, keyToMidi, channelColors, trackColorIdx } from './piano-constants.js';
import { parseMIDI } from '../parser/midi-parser.js';
import { playSoundFontNote, stopSoundFontNote, stopAllVoices, stopKey, sf2Voices, audioContext } from './audio-engine.js';
import { spawnLiveNote, addLiveNote, liveNotesPool, keyHoldCounts } from './note-simulation.js';
import { releaseKey } from './keyboard.js';
import { WinW, WinH } from './webgl.js';

function mul64to128(a, b) {
    if (typeof BigInt === 'function') {
        const A = BigInt(a >>> 0), B = BigInt(b >>> 0);
        const prod = A * B;
        const hi = Number((prod >> 64n) & 0xFFFFFFFFFFFFFFFFn);
        const lo = Number(prod & 0xFFFFFFFFFFFFFFFFn);
        return { lo: lo >>> 0, hi: hi >>> 0 };
    }
    const lo_lo = (a & 0xFFFFFFFF) * (b & 0xFFFFFFFF);
    const hi_lo = (a >>> 32) * (b & 0xFFFFFFFF);
    const lo_hi = (a & 0xFFFFFFFF) * (b >>> 32);
    const hi_hi = (a >>> 32) * (b >>> 32);
    const cross = (lo_lo >>> 32) + (hi_lo & 0xFFFFFFFF) + lo_hi;
    const hi = hi_hi + (cross >>> 32) + (hi_lo >>> 32) + (lo_hi >>> 32);
    const lo = ((cross & 0xFFFFFFFF) << 32) | (lo_lo & 0xFFFFFFFF);
    return { lo: lo >>> 0, hi: hi >>> 0 };
}

function collectSingleMidiInfo(data) {
    const out = { ppq: 480, firstTempo: 500000, firstBPM: 120, trackCount: 0,
                  totalNoteOns: 0, totalNoteOffs: 0, peakPolyphony: 0, durationTicks: 0 };
    if (!data || data.length < 14) return out;
    try {
        let off = 0;
        if (data[off] !== 0x4D || data[off+1] !== 0x54 || data[off+2] !== 0x68 || data[off+3] !== 0x64) return out;
        off += 4 + 4 + 2;
        const ntrks = (data[off] << 8) | data[off+1]; off += 2;
        out.ppq = (data[off] << 8) | data[off+1]; off += 2;
        out.trackCount = ntrks;
        let currentPoly = 0, maxPoly = 0;
        const noteStack = new Map();
        for (let t = 0; t < ntrks && off < data.length; t++) {
            if (off + 8 > data.length || data[off] !== 0x4D || data[off+1] !== 0x54 || data[off+2] !== 0x72 || data[off+3] !== 0x6B) { off++; continue; }
            off += 4;
            const trkLen = (data[off] << 24) | (data[off+1] << 16) | (data[off+2] << 8) | data[off+3]; off += 4;
            const trackEnd = Math.min(data.length, off + trkLen);
            let tick = 0, running = 0;
            while (off < trackEnd) {
                let delta = 0, b, cnt = 0;
                do { if (off >= data.length) break; b = data[off++]; delta = (delta << 7) | (b & 0x7F); cnt++; } while ((b & 0x80) && cnt < 4);
                tick += delta;
                if (off >= trackEnd) break;
                let status = data[off++];
                if (status < 0x80) { off--; status = running; } else if (status < 0xF0) running = status;
                if (status >= 0x80 && status < 0xF0) {
                    const cmd = status & 0xF0;
                    let p1 = 0, p2 = 0;
                    if (cmd === 0xC0 || cmd === 0xD0) { if (off < trackEnd) p1 = data[off++]; }
                    else { if (off < trackEnd) p1 = data[off++]; if (off < trackEnd) p2 = data[off++]; }
                    if (cmd === 0x90) {
                        if (p2 > 0) {
                            out.totalNoteOns++; currentPoly++;
                            if (currentPoly > maxPoly) maxPoly = currentPoly;
                            const key = p1; noteStack.set(key, (noteStack.get(key) || 0) + 1);
                        } else {
                            out.totalNoteOffs++; currentPoly = Math.max(0, currentPoly - 1);
                            const key = p1; const c = noteStack.get(key) || 0;
                            if (c <= 1) noteStack.delete(key); else noteStack.set(key, c - 1);
                        }
                    } else if (cmd === 0x80) {
                        out.totalNoteOffs++; currentPoly = Math.max(0, currentPoly - 1);
                        const key = p1; const c = noteStack.get(key) || 0;
                        if (c <= 1) noteStack.delete(key); else noteStack.set(key, c - 1);
                    }
                } else if (status === 0xFF) {
                    const metaType = data[off++];
                    let len = 0, c2 = 0;
                    do { if (off >= data.length) break; b = data[off++]; len = (len << 7) | (b & 0x7F); c2++; } while ((b & 0x80) && c2 < 4);
                    const ds = off; off += len;
                    if (metaType === 0x51 && len >= 3) {
                        if (out.firstTempo === 500000) { out.firstTempo = (data[ds] << 16) | (data[ds+1] << 8) | data[ds+2]; out.firstBPM = 60000000 / out.firstTempo; }
                    }
                } else if (status === 0xF0 || status === 0xF7) {
                    let len = 0, c = 0;
                    do { if (off >= data.length) break; b = data[off++]; len = (len << 7) | (b & 0x7F); c++; } while ((b & 0x80) && c < 4);
                    off += len;
                }
            }
            out.durationTicks = Math.max(out.durationTicks, tick);
            off = trackEnd;
        }
        out.peakPolyphony = maxPoly;
    } catch (e) {}
    return out;
}

class MIDIPlayer {
    constructor() {
        this.isPlaying      = false;
        this.isPaused       = false;
        this.currentFile    = null;
        this.isLoaded       = false;
        this.currentTime    = 0;
        this.duration       = 0;
        this.activeNotes    = new Set();
        this.sustainOn      = new Array(16).fill(false);
        this.pedalHeldNotes = new Set();
        this.isParsedWithWasm = false;
        this.allEvents      = null;
        this.division       = 480;
        this.currentTempo   = 500000;
        this.eventIndex     = 0;
        this.currentTimer   = null;
        this.currentRafId   = null;
        this.startTimestamp = 0;
        this.currentTime = 0;
        this.eventIndex = 0;
        this.audioBaseTime = 0;
        if (typeof stopAllVoices === 'function') stopAllVoices(true);
    }

    play() {
        if (!this.isLoaded || !this.allEvents || this.allEvents.length === 0) return;
        this.clearTimer();
        const resuming = this.isPaused && this.currentTime > 0;
        if (!resuming) { 
            this.currentTime = 0; 
            this.eventIndex = 0; 
        }
        this.startTimestamp = performance.now() - this.currentTime;
        this.isPlaying = true;
        this.isPaused = false;

        if (audioContext) {
            this.audioBaseTime = audioContext.currentTime - (this.currentTime / 1000);
        } else {
            this.audioBaseTime = 0;
        }
    }

    pause() {
        if (!this.isPlaying) return;
        this.currentTime = performance.now() - this.startTimestamp;
        this.isPlaying = false;
        this.isPaused = true;
        this.clearTimer();
        if (typeof stopAllVoices === 'function') stopAllVoices(true);
    }

    stop() {
        this.clearTimer();
        this.isPlaying = false;
        this.isPaused = false;
        this.currentTime = 0;
        this.eventIndex = 0;
        this.startTimestamp = 0;
        if (typeof stopAllVoices === 'function') stopAllVoices(true);

        for (let i = 0; i < liveNotesPool.length; i++) {
            const n = liveNotesPool[i];
            if (n && n.active && n.keyPressed) {
                const kk = n.k;
                if (typeof releaseKey === 'function') releaseKey(kk);
                n.keyPressed = false;
                keyHoldCounts[kk] = Math.max(0, (keyHoldCounts[kk] || 0) - 1);
            }
        }
        keyHoldCounts.fill(0);
        this.sustainOn.fill(false);
        this.pedalHeldNotes.clear();
    }

    seek(fraction) {
        if (!this.allEvents || this.allEvents.length === 0) return;
        const target = Math.max(0, Math.min(1, fraction)) * (this.duration || 0);
        const wasPlaying = this.isPlaying;
        this.isPlaying = false;
        this.isPaused = true;
        this.currentTime = target;
        this.eventIndex = 0;
        if (typeof stopAllVoices === 'function') stopAllVoices(true);
        while (this.eventIndex < this.allEvents.length) {
            const ev = this.allEvents[this.eventIndex];
            const ems = ev.absMs != null ? ev.absMs : this.getTimeForTick(ev.time);
            if (ems > target) break;
            this.eventIndex++;
        }
        if (wasPlaying) this.play();
    }

    getProgress() {
        return this.duration > 0 ? Math.max(0, Math.min(1, this.currentTime / this.duration)) : 0;
    }

    update(now = performance.now()) {
        if (!this.isPlaying || !this.allEvents || this.allEvents.length === 0) return;
        const songTime = now - this.startTimestamp;
        this.currentTime = songTime;
        let leadMs = 2000;
        try {
            if (typeof WinH !== 'undefined' && typeof WinW !== 'undefined' && typeof settings !== 'undefined') {
                const kbTop = WinH - WinW * 82 / 1000;
                const pxPerMs = settings.get('noteSpeed') / 8;
                if (pxPerMs > 0.1) leadMs = Math.max(300, (kbTop + 20) / pxPerMs);
            }
        } catch (e) {}
        while (this.eventIndex < this.allEvents.length) {
            const ev = this.allEvents[this.eventIndex];
            const evMs = ev.absMs != null ? ev.absMs : this.getTimeForTick(ev.time);
            if (evMs > songTime + leadMs) break;
            if (ev.type === 'noteOn') {
                const midiK = ev.note;
                const vel = (ev.velocity != null ? ev.velocity : 80);
                const k = midiToKey(midiK);
                if (k >= 0 && k < 128) {
                    const isVisualLayer = !!(ev && ev.visualOnly);
                    if (!isVisualLayer) this.activeNotes.add(midiK);
                    trackColorIdx.value = (trackColorIdx.value + 1) % 16
                    const noteDuration = ev.durationMs || 0;
                    const colorIdx = ((ev.track || 0) + (ev.channel || 0)) % channelColors.length;
                    spawnLiveNote(k, vel, evMs, songTime, noteDuration, colorIdx, ev, this);

                    if (typeof playSoundFontNote === 'function' && this.audioBaseTime != null) {
                        const when = this.audioBaseTime + (evMs / 1000);
                        playSoundFontNote(k, vel, when, false);
                    }
                }
            } else if (ev.type === 'noteOff') {
                const midiK = ev.note;
                const ch = ev.channel || 0;
                const k = midiToKey(midiK);
                if (this.sustainOn[ch]) {
                    this.pedalHeldNotes.add(midiK);
                } else if (this.activeNotes.has(midiK) && k >= 0) {
                    this.activeNotes.delete(midiK);
                    if (typeof stopSoundFontNote === 'function' && this.audioBaseTime != null) {
                        const when = Math.max(
                            audioContext.currentTime + 0.001,
                            this.audioBaseTime + (evMs / 1000)
                        );
                        stopSoundFontNote(k, false, when);
                    } else if (typeof stopKey === 'function') {
                        stopKey(k);
                    }
                }
            } else if ((ev.type === 'control' || ev.type === 'controlChange') && ev.controller === 64) {
                const ch = ev.channel || 0;
                const on = (ev.value || 0) >= 64;
                const wasOn = this.sustainOn[ch];
                this.sustainOn[ch] = on;
                if (wasOn && !on) {
                    for (const m of Array.from(this.pedalHeldNotes)) {
                        const kk = midiToKey(m);
                        if (kk >= 0) {
                            if (typeof stopSoundFontNote === 'function') {
                                const arr = sf2Voices.get(kk);
                                while (arr && arr.length > 0) {
                                    stopSoundFontNote(kk, false);
                                }
                            } else if (typeof stopKey === 'function') {
                                stopKey(kk);
                            }
                        }
                    }
                    for (const m of Array.from(this.pedalHeldNotes)) this.activeNotes.delete(m);
                    this.pedalHeldNotes.clear();
                }
            }
            this.eventIndex++;
        }
        if (this.eventIndex >= this.allEvents.length && songTime > (this.duration + 500)) this.stop();
    }

    getTimeForTick(targetTick) {
        if (!this.allEvents || this.allEvents.length === 0) return 0;
        const evs = this.allEvents;
        let lo = 0, hi = evs.length - 1, baseIdx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (evs[mid].time <= targetTick) { baseIdx = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        if (baseIdx < 0) return 0;
        const baseEv = evs[baseIdx];
        const baseTick = baseEv.time;
        const baseMs = baseEv.absMs || 0;
        let uSpb = 500000;
        for (let j = baseIdx; j >= 0; j--) {
            if (evs[j].type === 'tempo' && evs[j].tempo > 0) { uSpb = evs[j].tempo; break; }
        }
        const delta = targetTick - baseTick;
        return baseMs + delta * (uSpb / this.division / 1000.0);
    }

    computeDurationFromEvents() {
        if (this.allEvents && this.allEvents.length > 0) {
            const last = this.allEvents[this.allEvents.length - 1];
            this.duration = (last && last.absMs != null) ? last.absMs : this.getTimeForTick(last ? last.time : 0);
        }
    }

    clearTimer() {
        if (this.currentTimer)  { clearTimeout(this.currentTimer);        this.currentTimer  = null; }
        if (this.currentRafId)  { cancelAnimationFrame(this.currentRafId); this.currentRafId  = null; }
    }

    getTimeString(time) {
        const minutes = Math.floor(time / 60000);
        const seconds = Math.floor((time % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
}

MIDIPlayer.prototype.computeAndStoreMidiInfo = function() {
    if (!this.rawData) return null;
    this.midiInfo = collectSingleMidiInfo(this.rawData);
    return this.midiInfo;
};

MIDIPlayer.prototype.loadFile = async function(file) {
    if (!file) return false;
    try {
        this.currentFile = file;
        const arrayBuffer = await file.arrayBuffer();
        this.rawData = new Uint8Array(arrayBuffer);
        this.isLoaded = false;
        this.allEvents = [];
        this.duration = 0;
        this.eventIndex = 0;

        this.computeAndStoreMidiInfo();

        const parsed = parseMIDI(arrayBuffer);
        this.division = parsed.timeDivision;
        this.duration = parsed.durationSeconds * 1000;
        this.tempoMap = parsed.tempoMap;

        const baseTick = 0;
        
        const pendingNotes = new Map();
        
        parsed.allEvents.forEach((ev, idx) => {
            let evType = ev.type;
            if (evType === 'controlChange') evType = 'control';
            const playerEv = {
                time: ev.tick,
                absMs: Math.round(ev.timeSeconds * 1000),
                type: evType,
                channel: ev.channel != null ? ev.channel : 0,
                track: ev.track,
                note: ev.note,
                velocity: ev.velocity,
                controller: ev.controller,
                value: ev.value,
                tempo: ev.microsecondsPerBeat,
                durationMs: 0
            };
            
            if (ev.type === 'noteOn' && ev.velocity > 0) {
                const key = `${playerEv.channel}_${ev.note}`;
                this.allEvents.push(playerEv);
                if (!pendingNotes.has(key)) pendingNotes.set(key, []);
                pendingNotes.get(key).push(playerEv);
            } else if (ev.type === 'noteOff' || (ev.type === 'noteOn' && ev.velocity === 0)) {
                const key = `${playerEv.channel}_${ev.note}`;
                const stack = pendingNotes.get(key);
                if (stack && stack.length > 0) {
                    const startEv = stack.shift();
                    startEv.durationMs = playerEv.absMs - startEv.absMs;
                    if (stack.length === 0) pendingNotes.delete(key);
                }
                this.allEvents.push(playerEv);
            } else {
                this.allEvents.push(playerEv);
            }
        });
        
        for (const [, stack] of pendingNotes) {
            for (const startEv of stack) {
                if (startEv.durationMs <= 0) {
                    startEv.durationMs = Math.max(500, this.duration - startEv.absMs);
                }
            }
        }

        this.allEvents.sort((a, b) => {
            if (a.absMs !== b.absMs) return a.absMs - b.absMs;
            const aIsNote = a.type === 'noteOn' || a.type === 'noteOff';
            const bIsNote = b.type === 'noteOn' || b.type === 'noteOff';
            if (aIsNote && !bIsNote) return -1;
            if (!aIsNote && bIsNote) return 1;
            return 0;
        });

        this.isLoaded = true;
        return true;
    } catch (e) {
        console.error('MIDI load failed:', e);
        this.isLoaded = false;
        return false;
    }
};

const midiPlayer = new MIDIPlayer();

export { MIDIPlayer, midiPlayer, mul64to128, collectSingleMidiInfo };
