class SoundEffectManager {
    constructor() { this.sounds = {}; this.basePath = 'sound-effects/'; }
    playSFX(filename) {
        try {
            let audio = this.sounds[filename];
            if(!audio) { audio = new Audio(this.basePath + filename); this.sounds[filename] = audio; }
            audio.currentTime = 0;
            audio.volume = 0.2;
            audio.play().catch(() => {});
        } catch(err) { originalWarn('Error playing sound ' + filename + ':', err); }
    }
    playUIOpen()  { this.playSFX('ui-open-sf.mp3'); }
    playUIClose() { this.playSFX('ui-close-sf.mp3'); }
    playError()   { this.playSFX('error-sf.mp3'); }
    playWarning() { this.playSFX('warning-sf.mp3'); }
}

const sfxManager = new SoundEffectManager();

function showLoading(text = 'Loading...') {
    const screen = document.getElementById('loadingScreen');
    const textEl = document.getElementById('loadingText');
    if(screen && textEl) { textEl.textContent = text; screen.style.display = 'flex'; }
}
function hideLoading() {
    const screen = document.getElementById('loadingScreen');
    if(screen) screen.style.display = 'none';
}

let errorPopupTimer = null;
function showErrorPopup(message, durationMs = 3200) {
    const popup = document.getElementById('errorPopup');
    const textEl = document.getElementById('errorPopupText');
    if (!popup || !textEl) return;
    textEl.textContent = message;
    popup.style.display = 'block';
    popup.style.opacity = '1';
    popup.style.transition = '';
    popup.style.pointerEvents = 'auto';
    popup.onclick = () => {
        if (errorPopupTimer) clearTimeout(errorPopupTimer);
        popup.style.transition = 'opacity 0.2s ease';
        popup.style.opacity = '0';
        setTimeout(() => {
            popup.style.display = 'none';
            popup.style.opacity = '1';
            popup.style.transition = '';
            popup.style.pointerEvents = 'none';
            popup.onclick = null;
        }, 220);
    };
    if (errorPopupTimer) clearTimeout(errorPopupTimer);
    errorPopupTimer = setTimeout(() => {
        popup.style.transition = 'opacity 0.4s ease';
        popup.style.opacity = '0';
        setTimeout(() => {
            popup.style.display = 'none';
            popup.style.opacity = '1';
            popup.style.transition = '';
            popup.style.pointerEvents = 'none';
            popup.onclick = null;
        }, 420);
    }, durationMs);
}

const originalError = console.error;
const originalWarn  = console.warn;
console.error = function(...args) {
    originalError.apply(console, args);
    if(args[0] && typeof args[0] === 'string' && args[0].toLowerCase().includes('error'))
        try { sfxManager.playError(); } catch(e) {}
};
console.warn = function(...args) {
    originalWarn.apply(console, args);
    if(args[0] && typeof args[0] === 'string')
        try { sfxManager.playWarning(); } catch(e) {}
};
window.addEventListener('error',             () => { try { sfxManager.playError(); } catch(e) {} });
window.addEventListener('unhandledrejection',() => { try { sfxManager.playError(); } catch(e) {} });

export { SoundEffectManager, sfxManager, showLoading, hideLoading, showErrorPopup };
