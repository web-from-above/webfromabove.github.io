import { settings } from './settings.js';
import { keyToMidi } from './piano-constants.js';

const MAX_ACTIVE_VOICES = 256;

const voicePool = new Array(MAX_ACTIVE_VOICES).fill(null).map(() => ({
    active: false,
    note: -1,
    velocity: 0,
    startedAt: 0,
    source: null,
    gain: null
}));

const activeVoices = [];
const sf2AudioBuffers = new Map();
const sf2Voices = new Map();

function stealOldestVoice() {
    if (activeVoices.length === 0) return null;

    let oldestIndex = 0;
    let oldestTime = activeVoices[0].startedAt;

    for (let i = 1; i < activeVoices.length; i++) {
        if (activeVoices[i].startedAt < oldestTime) {
            oldestTime = activeVoices[i].startedAt;
            oldestIndex = i;
        }
    }

    const v = activeVoices.splice(oldestIndex, 1)[0];

    try {
        v.source?.stop();
    } catch(e){}

    v.active = false;
    return v;
}

function allocateVoice() {
    for (let i = 0; i < voicePool.length; i++) {
        const v = voicePool[i];

        if (!v.active) {
            v.active = true;
            activeVoices.push(v);
            return v;
        }
    }

    stealOldestVoice();

    for (let i = 0; i < voicePool.length; i++) {
        const v = voicePool[i];

        if (!v.active) {
            v.active = true;
            activeVoices.push(v);
            return v;
        }
    }

    return null;
}

let audioContext = null;
let masterGain = null;
let audioCompressor = null;

async function initAudio() {
    audioContext = new AudioContext({ latencyHint: 'interactive' });
    masterGain = audioContext.createGain();
    const vol = settings.get('masterVolume') / 100;
    masterGain.gain.setValueAtTime(vol, audioContext.currentTime);

    const highPass = audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 35;
    highPass.Q.value = 0.7;

    const bassBoost = audioContext.createBiquadFilter();
    bassBoost.type = 'lowshelf';
    bassBoost.frequency.value = 120;
    bassBoost.gain.value = 3.5;

    audioCompressor = audioContext.createDynamicsCompressor();
    applyAudioLimiterSettings();

    const outputAtten = audioContext.createGain();
    outputAtten.gain.setValueAtTime(0.65, audioContext.currentTime);

    masterGain.connect(highPass);
    highPass.connect(bassBoost);
    bassBoost.connect(outputAtten);
    outputAtten.connect(audioCompressor);
    audioCompressor.connect(audioContext.destination);

    if (window.loadedSoundFont && window.loadedSoundFont.sf2) {
        const sf2 = window.loadedSoundFont.sf2;
        if (typeof sf2.ensureSampleBuffers === 'function') {
            sf2.ensureSampleBuffers();
        }
    }
}

async function ensureAudio() {
    if (!audioContext) await initAudio();
    if (audioContext.state === 'suspended') await audioContext.resume();
}

function resumeAudioSilently() {
    if (audioContext && audioContext.state === 'suspended')
        audioContext.resume().catch(() => {});
}

function applyAudioLimiterSettings() {
    if (!audioCompressor) return;
    const enabled = settings.get('audioLimiter') !== false;
    if (enabled) {
        audioCompressor.threshold.value = -1;
        audioCompressor.knee.value = 0;
        audioCompressor.ratio.value = 20;
        audioCompressor.attack.value = 0.001;
        audioCompressor.release.value = 0.08;
    } else {
        audioCompressor.threshold.value = -6;
        audioCompressor.knee.value = 8;
        audioCompressor.ratio.value = 1.5;
        audioCompressor.attack.value = 0.005;
        audioCompressor.release.value = 0.2;
    }
}

function updateAudioGain() {
    const vol = settings.get('masterVolume') / 100;
    if(masterGain) masterGain.gain.setValueAtTime(vol, audioContext.currentTime);
}

function playSoundFontNote(k, velocity = 127, when = null, cutPrevious = true) {
    if (!sf2Voices) return;
    if (!audioContext || !window.loadedSoundFont || !window.loadedSoundFont.sf2) return;

    const sf2 = window.loadedSoundFont.sf2;
    const midiNote = keyToMidi(k);

    const now = audioContext.currentTime;
    const startTime = (when != null && when > now) ? when : now;

    if (cutPrevious) {
        stopSoundFontNote(k, true);
    }

    let zones = sf2.getZones(0, 0, midiNote, velocity);
    if (!zones || zones.length === 0) {
        console.warn(`No zones for MIDI note ${midiNote} vel ${velocity}, trying default vel 64`);
        zones = sf2.getZones(0, 0, midiNote, 64) || [];
    }
    if (!zones || zones.length === 0) {
        console.warn(`No zones found for MIDI note ${midiNote} (any velocity)`);
        return;
    }

    let zone = zones
      .filter(z => z && z.audioBuffer)
      .sort((a, b) => {
        const scoreZone = (z) => {
          const range = Math.max(1, (z.velHi || 127) - (z.velLo || 0));
          const center = ((z.velLo || 0) + (z.velHi || 127)) / 2;
          const fit = 1 - Math.min(1, Math.abs(center - velocity) / (range / 2 + 1));
          return range * 2 + fit * 10;
        };
        return scoreZone(b) - scoreZone(a);
      })[0] || zones.find(z => z && z.audioBuffer) || zones[0];

    if (!zone || !zone.audioBuffer) {
        console.warn(`Zone(s) found for MIDI note ${midiNote} but no audioBuffer available`);
        return;
    }

    const source = audioContext.createBufferSource();
    source.buffer = zone.audioBuffer;

    const semitonesDiff = midiNote - zone.rootKey + (zone.coarseTune || 0);
    const centsDiff = (zone.fineTune || 0) + (zone.pitchCorrection || 0);
    const scale = (zone.scaleTuning != null ? zone.scaleTuning : 100) / 100;
    const total = (semitonesDiff * scale) + (centsDiff / 100);
    source.playbackRate.value = Math.pow(2, total / 12);

    if (zone.loopMode > 0 && zone.loopEnd > zone.loopStart) {
        source.loop = true;
        const sr = zone.sampleHeader.sampleRate || zone.audioBuffer.sampleRate;
        source.loopStart = zone.loopStart / sr;
        source.loopEnd   = zone.loopEnd   / sr;
    }

    const gain = audioContext.createGain();

    let vol = Math.pow(velocity / 127, 1.6) * 0.92;
    vol = Math.max(0.03, vol);
    const peak = Math.min(1.0, vol);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peak, startTime + 0.004);

    const filter = audioContext.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.max(800, 600 + Math.pow(velocity / 127, 1.2) * 16000);
    filter.Q.value = 0.5;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    source.start(startTime);

    const arr = sf2Voices.get(k) || [];
    arr.push({ source, gain, filter, zone, startTime });
    sf2Voices.set(k, arr);
}

function stopSoundFontNote(k, immediate = false, when = null) {
    if (!sf2Voices) return;
    const arr = sf2Voices.get(k);
    if (!arr || arr.length === 0 || !audioContext) return;

    const v = arr.shift();
    if (arr.length === 0) sf2Voices.delete(k);

    const now = audioContext.currentTime;
    const safeRelease = Math.max(now, (v.startTime || now) + 0.006);
    const t = (when != null && when > safeRelease) ? when : safeRelease;

    try {
        if (immediate) {
            v.gain.gain.cancelScheduledValues(t);
            v.gain.gain.setTargetAtTime(0.0001, t, 0.015);
            v.source.stop(t + 0.05);

            if (t <= now + 0.02) {
                if (v.filter) v.filter.disconnect();
                v.gain.disconnect();
                v.source.disconnect();
            } else {
                v.source.onended = () => {
                    try {
                        if (v.filter) v.filter.disconnect();
                        v.gain.disconnect();
                        v.source.disconnect();
                    } catch (e) {}
                };
            }
        } else {
            const sus = 0.8;
            const timeConstant = Math.max(0.08, sus / 3.5);
            v.gain.gain.cancelScheduledValues(t);
            v.gain.gain.setTargetAtTime(0.0001, t, timeConstant);
            v.source.stop(t + timeConstant * 5 + 0.05);
            v.source.onended = () => {
                try {
                    if (v.filter) v.filter.disconnect();
                    v.gain.disconnect();
                    v.source.disconnect();
                } catch (e) {}
            };
        }
    } catch (e) {}
}

function playKey(k, velocity = 127) {
    if (!sf2Voices) return;
    if (!audioContext) return;
    playSoundFontNote(k, velocity);
}

function stopKey(k) {
    if (!sf2Voices) return;
    stopSoundFontNote(k);
}

function stopAllVoices(immediate = false) {
    if (!sf2Voices) return;
    for (const [k, arr] of Array.from(sf2Voices.entries())) {
        while (arr && arr.length > 0) {
            const v = arr.pop();
            try {
                if (immediate) {
                    v.source.onended = null;
                    v.source.stop();
                    if (v.filter) v.filter.disconnect();
                    v.gain.disconnect();
                    v.source.disconnect();
                } else {
                    const t = audioContext.currentTime;
                    const sus = 0.28;
                    const tc = sus / 3.5;
                    v.gain.gain.cancelScheduledValues(t);
                    v.gain.gain.setTargetAtTime(0.0001, t, tc);
                    v.source.stop(t + tc * 5 + 0.05);
                }
            } catch (e) {}
        }
    }
    sf2Voices.clear();
}

export { voicePool, activeVoices, sf2AudioBuffers, sf2Voices,
         audioContext, masterGain, audioCompressor,
         stealOldestVoice, allocateVoice,
         initAudio, ensureAudio, resumeAudioSilently, applyAudioLimiterSettings, updateAudioGain,
         playSoundFontNote, stopSoundFontNote, playKey, stopKey, stopAllVoices };
