import { settings } from './settings.js';
import { sfxManager } from './sound-effects.js';
import { ensureAudio, resumeAudioSilently, audioContext } from './audio-engine.js';
import { WGL, resize, drawKeyboard, drawGrid, drawMeasureGrid, getBackgroundColor, WinW, WinH, canvas } from './webgl.js';
import { triggerKey, releaseKey, hitKey } from './keyboard.js';
import { midiPlayer } from './midi-player.js';
import { updateLiveNotes } from './note-simulation.js';
import { setupSettingsUI, updateMIDIPlayerUI, openSettingsPanel } from './ui.js';

// Render state
let frameCount = 0, lastFpsTime = 0, currentFps = 0, lastFrameTime = 0;
let bZoomMove = false, bInstructions = false, iShowTop10 = -1;
let eGameMode = 'practice';

// Keyboard/mouse input
const pianoInputEnabled = true;
let held = new Set();

// ============ TEXT OVERLAYS ============
function updateTextOverlays(now) {
    const statusEl = document.getElementById('statusOverlay');
    const msgEl = document.getElementById('messageOverlay');
    const top10El = document.getElementById('top10Overlay');
    if (!statusEl) return;

    let html = '';

    let timeStr = '--:-- / --:--';
    if (midiPlayer && midiPlayer.isLoaded) {
        const cur = midiPlayer.currentTime || 0;
        const dur = midiPlayer.duration || 0;
        const fmt = (ms) => {
            const neg = ms < 0;
            ms = Math.abs(ms);
            const min = Math.floor(ms / 60000);
            const sec = ((ms % 60000) / 1000).toFixed(1).padStart(4, '0');
            return (neg ? '-' : '') + min + ':' + sec;
        };
        timeStr = fmt(cur) + ' / ' + fmt(dur);
    }

    const shadow = 'text-shadow:1px 1px 0 #404040;';
    const white = 'color:#fff;';
    const dark  = 'color:#404040;';

    html += `<div style="display:flex;justify-content:space-between;${white}"><span>Time:</span><span>${timeStr}</span></div>`;
    html += `<div style="display:flex;justify-content:space-between;${dark};margin-top:-1.1em;margin-left:1px;"><span>Time:</span><span>${timeStr}</span></div>`;

    const fpsStr = currentFps.toFixed(1);
    html += `<div style="display:flex;justify-content:space-between;margin-top:1px;${white}"><span>FPS:</span><span>${fpsStr}</span></div>`;
    html += `<div style="display:flex;justify-content:space-between;margin-top:-1.1em;margin-left:1px;${dark}"><span>FPS:</span><span>${fpsStr}</span></div>`;

    if (eGameMode === 'learn') {
        const learnStr = 'All Tracks';
        const modeStr = 'Waiting';
        html += `<div style="display:flex;justify-content:space-between;margin-top:1px;${white}"><span>Learning:</span><span>${learnStr}</span></div>`;
        html += `<div style="display:flex;justify-content:space-between;margin-top:-1.1em;margin-left:1px;${dark}"><span>Learning:</span><span>${learnStr}</span></div>`;
        html += `<div style="display:flex;justify-content:space-between;margin-top:1px;${white}"><span></span><span>${modeStr}</span></div>`;
        html += `<div style="display:flex;justify-content:space-between;margin-top:-1.1em;margin-left:1px;${dark}"><span></span><span>${modeStr}</span></div>`;
    } else {
        html += `<div style="display:flex;justify-content:space-between;margin-top:1px;${white}"><span>Score:</span><span>N/A</span></div>`;
        html += `<div style="display:flex;justify-content:space-between;margin-top:-1.1em;margin-left:1px;${dark}"><span>Score:</span><span>N/A</span></div>`;
    }

    statusEl.innerHTML = html;
    statusEl.style.display = 'block';

    let showMsg = false;
    let msgText = '';

    if (bZoomMove) {
        showMsg = true;
        msgText = '- Left-click and drag to move the screen\n- Right-click and drag to zoom horizontally\n- Press Escape to abort changes\n- Press Ctrl+V to save changes';
    } else if (bInstructions) {
        showMsg = true;
        if (eGameMode === 'play') {
            msgText = 'You will be scored. Good luck.\n\nPlay any note when ready.';
        } else if (eGameMode === 'learn') {
            msgText = 'This mode will teach you a song, one track at a time.\nIn Adaptive mode, poorly played sections repeat at a slower rate.\nIn Waiting mode, notes will pause and wait to be played.\n\nPlay any note when ready.';
        } else {
            msgText = 'Practice mode.\n\nPress Space to play/pause.';
        }
    } else if (iShowTop10 >= 0) {
        showMsg = true;
        msgText = 'Top 10 Scores\n(Score system disabled for development)\n\nScore: N/A';
    }

    if (showMsg && msgText) {
        msgEl.innerHTML = msgText;
        msgEl.style.display = 'block';
    } else {
        msgEl.style.display = 'none';
    }

    if (iShowTop10 >= 0) {
        top10El.innerHTML = '<div style="font-weight:bold;margin-bottom:4px;">Top 10</div><div style="opacity:0.7;">(Disabled for development - Score: N/A)</div>';
        top10El.style.display = 'block';
    } else {
        top10El.style.display = 'none';
    }
}

// ============ RENDER LOOP ============
function render(now = performance.now()){
    lastFrameTime = now;

    if (midiPlayer && typeof midiPlayer.update === 'function' && midiPlayer.isPlaying) midiPlayer.update(now);
    if(WGL.enabled){
        WGL.clear(0, 0, 0);
        const bg = getBackgroundColor();
        WGL.drawRect(0, 0, WinW, WinH - WinW * 82 / 1000, bg, bg, bg, bg);
        if (settings.get('showGrid')) {
            drawGrid();
        }
        if (midiPlayer && midiPlayer.allEvents && midiPlayer.allEvents.length > 0) {
            drawMeasureGrid(midiPlayer);
        }
        WGL.flushRects();
        updateLiveNotes(midiPlayer);
        drawKeyboard();
        WGL.flushRects();
    }
    frameCount++;
    if (now - lastFpsTime >= 1000) {
        currentFps = frameCount;
        frameCount = 0;
        lastFpsTime = now;
    }

    updateTextOverlays(now);

    requestAnimationFrame(render);
}

// ============ INIT ============
WGL.init();

// User gesture → audio
['pointerdown', 'keydown', 'touchstart'].forEach(type => {
    document.addEventListener(type, () => {
        if (!audioContext) ensureAudio().catch(() => {});
        else if (audioContext.state === 'suspended') resumeAudioSilently();
    }, { passive: true });
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audioContext) {
        if (audioContext.state === 'suspended') resumeAudioSilently();
        if (!audioContext) ensureAudio().catch(() => {});
    }
});

window.addEventListener('resize', resize);

// Mouse events
canvas.addEventListener('mousedown', async e => {
    await ensureAudio();
    if(!pianoInputEnabled) return;
    const r = canvas.getBoundingClientRect();
    const k = hitKey(e.clientX - r.left, e.clientY - r.top);
    if(k >= 0 && k < 128) { held.clear(); held.add(k); triggerKey(k, 127); }
});
window.addEventListener('mouseup', e => { for(const k of held) releaseKey(k); held.clear(); });
canvas.addEventListener('mousemove', e => {
    if(!pianoInputEnabled) return;
    if(!e.buttons) return;
    const r = canvas.getBoundingClientRect();
    const k = hitKey(e.clientX - r.left, e.clientY - r.top);
    if(k >= 0 && k < 128) {
        if(!held.has(k)) { for(const h of held) releaseKey(h); held.clear(); held.add(k); triggerKey(k, 127); }
    } else { for(const h of held) releaseKey(h); held.clear(); }
});

// Touch events
canvas.addEventListener('touchstart', async e => {
    await ensureAudio();
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    Array.from(e.changedTouches).forEach(t => {
        const k = hitKey(t.clientX - r.left, t.clientY - r.top);
        if(k >= 0 && k < 128) { if(!held.has(k)) { held.clear(); held.add(k); triggerKey(k, 127); } }
    });
}, {passive:false});
canvas.addEventListener('touchend', e => { for(const k of held) releaseKey(k); held.clear(); });
canvas.addEventListener('touchcancel', e => { for(const k of held) releaseKey(k); held.clear(); });
canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    for(const t of e.touches) {
        const k = hitKey(t.clientX - r.left, t.clientY - r.top);
        if(k >= 0 && k < 128) {
            if(!held.has(k)) { for(const h of held) releaseKey(h); held.clear(); held.add(k); triggerKey(k, 127); }
        }
    }
}, {passive:false});

// Keyboard events
document.addEventListener('keydown', async e => {
    await ensureAudio();

    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const panel   = document.getElementById('settingsPanel');
        const overlay = document.getElementById('settingsOverlay');
        if (panel && overlay) {
            const isOpen = panel.classList.contains('active');
            if (isOpen) {
                panel.classList.remove('active');
                overlay.classList.remove('active');
                if (typeof sfxManager !== 'undefined') sfxManager.playUIClose();
            } else {
                panel.classList.add('active');
                overlay.classList.add('active');
                if (typeof sfxManager !== 'undefined') sfxManager.playUIOpen();
            }
        }
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (midiPlayer && typeof midiPlayer.isPlaying !== 'undefined') {
            if (midiPlayer.isPlaying) {
                midiPlayer.pause();
            } else if (midiPlayer.isLoaded) {
                midiPlayer.play();
            }
        }
    }

    if (midiPlayer && midiPlayer.isLoaded && (midiPlayer.duration || 0) > 0) {
        let delta = 0;
        if (e.key === 'ArrowLeft') {
            delta = e.ctrlKey ? -5000 : -3000;
        } else if (e.key === 'ArrowRight') {
            delta = e.ctrlKey ? 10000 : 5000;
        }
        if (delta !== 0) {
            e.preventDefault();
            const dur = midiPlayer.duration;
            let newTime = (midiPlayer.currentTime || 0) + delta;
            newTime = Math.max(0, Math.min(dur, newTime));
            const fraction = newTime / dur;
            midiPlayer.seek(fraction);
            if (typeof updateMIDIPlayerUI === 'function') updateMIDIPlayerUI();
        }
    }

    if (e.key.toLowerCase() === 'i') {
        bInstructions = !bInstructions;
    }
    if (e.key === 'Escape') {
        bZoomMove = false;
        bInstructions = false;
        iShowTop10 = -1;
    }
});
document.addEventListener('keyup', e => {});

// Two-finger gesture handlers
let twoFingerGesture = {
    active: false,
    startX: 0,
    startY: 0,
    triggered: false
};
const TWO_FINGER_MIN_DISTANCE = 60;
const TWO_FINGER_MAX_VERTICAL = 120;

document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const avgX = (t1.clientX + t2.clientX) / 2;
    const avgY = (t1.clientY + t2.clientY) / 2;
    if (avgX > window.innerWidth * 0.55) {
        twoFingerGesture.active = true;
        twoFingerGesture.startX = avgX;
        twoFingerGesture.startY = avgY;
        twoFingerGesture.triggered = false;
    }
}, { passive: false });

document.addEventListener('touchmove', (e) => {
    if (!twoFingerGesture.active) return;
    if (twoFingerGesture.triggered) return;
    if (e.touches.length !== 2) return;
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const avgX = (t1.clientX + t2.clientX) / 2;
    const avgY = (t1.clientY + t2.clientY) / 2;
    const deltaX = avgX - twoFingerGesture.startX;
    const deltaY = Math.abs(avgY - twoFingerGesture.startY);
    if (deltaX < -TWO_FINGER_MIN_DISTANCE && deltaY < TWO_FINGER_MAX_VERTICAL) {
        e.preventDefault();
        twoFingerGesture.triggered = true;
        openSettingsPanel();
    }
}, { passive: false });

document.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
        twoFingerGesture.active = false;
    }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
    const panel = document.getElementById('settingsPanel');
    if (!panel.classList.contains('active')) return;
    if (!twoFingerGesture.active) return;
    if (twoFingerGesture.triggered) return;
    if (e.touches.length !== 2) return;
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const avgX = (t1.clientX + t2.clientX) / 2;
    const avgY = (t1.clientY + t2.clientY) / 2;
    const deltaX = avgX - twoFingerGesture.startX;
    const deltaY = Math.abs(avgY - twoFingerGesture.startY);
    if (deltaX > TWO_FINGER_MIN_DISTANCE && deltaY < TWO_FINGER_MAX_VERTICAL) {
        e.preventDefault();
        twoFingerGesture.triggered = true;
        panel.classList.remove('active');
        document.getElementById('settingsOverlay').classList.remove('active');
        try { sfxManager.playUIClose(); } catch(e) {}
    }
}, { passive: false });

// Start
resize();
setupSettingsUI();
render();
