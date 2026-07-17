import { settings } from './settings.js';
import { sfxManager } from './sound-effects.js';
import { t, loadLanguage, updateLangButton, toggleLangDropdown, langDropdownVisible } from './i18n.js';
import { midiManager, updateMIDIStatus, updateMIDIDeviceList } from './midi-manager.js';
import { midiPlayer } from './midi-player.js';
import { ensureAudio, resumeAudioSilently, applyAudioLimiterSettings, updateAudioGain, audioContext } from './audio-engine.js';
import { showErrorPopup } from './sound-effects.js';

function setupSettingsUI() {
    const toggle  = document.getElementById('settingsToggle');
    const close   = document.getElementById('settingsClose');
    const panel   = document.getElementById('settingsPanel');
    const overlay = document.getElementById('settingsOverlay');
    if(!toggle || !close || !panel || !overlay) { 
        console.warn('Settings UI elements not found'); 
        return; 
    }

    toggle.addEventListener('click', () => {
        const wasOpen = panel.classList.contains('active');
        panel.classList.toggle('active');
        overlay.classList.toggle('active');
        if (!wasOpen) {
            if (typeof sfxManager !== 'undefined') sfxManager.playUIOpen();
        } else {
            if (typeof sfxManager !== 'undefined') sfxManager.playUIClose();
        }
    });

    if (close) {
        close.addEventListener('click', () => {
            if (panel.classList.contains('active') && typeof sfxManager !== 'undefined') sfxManager.playUIClose();
            panel.classList.remove('active');
            overlay.classList.remove('active');
        });
    }

    if (overlay) {
        overlay.addEventListener('click', () => {
            if (panel.classList.contains('active') && typeof sfxManager !== 'undefined') sfxManager.playUIClose();
            panel.classList.remove('active');
            overlay.classList.remove('active');
        });
    }

    const langBtnEl = document.getElementById('langBtn');
    const langDdEl  = document.getElementById('langDropdown');
    if (langBtnEl) langBtnEl.addEventListener('click', (e) => { e.stopPropagation(); toggleLangDropdown(); });
    document.addEventListener('click', (e) => {
        if (langDdEl && !langDdEl.contains(e.target) && e.target !== langBtnEl) {
            langDdEl.classList.remove('visible'); langDropdownVisible.value = false;
        }
    });
    const savedLang = settings.get('language') || 'en';
    updateLangButton(savedLang);
    loadLanguage(savedLang);

    const noteSpeedSlider  = document.getElementById('noteSpeedSlider');
    const noteSpeedDisplay = document.getElementById('noteSpeedDisplay');
    const noteSpeedValue   = document.getElementById('noteSpeedValue');
    noteSpeedSlider.value  = settings.get('noteSpeed') * 100;
    noteSpeedDisplay.textContent = settings.get('noteSpeed').toFixed(1);
    noteSpeedValue.textContent   = settings.get('noteSpeed').toFixed(1) + 'x';
    noteSpeedSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) / 100;
        noteSpeedDisplay.textContent = val.toFixed(1);
        noteSpeedValue.textContent   = val.toFixed(1) + 'x';
        settings.set('noteSpeed', val);
    });

    const volumeSlider  = document.getElementById('volumeSlider');
    const volumeDisplay = document.getElementById('volumeDisplay');
    const volumeValue   = document.getElementById('volumeValue');
    volumeSlider.value  = settings.get('masterVolume');
    volumeDisplay.textContent = settings.get('masterVolume');
    volumeValue.textContent   = settings.get('masterVolume') + '%';
    volumeSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        volumeDisplay.textContent = val;
        volumeValue.textContent   = val + '%';
        settings.set('masterVolume', val);
        updateAudioGain();
    });

    const bgColorPicker = document.getElementById('bgColorPicker');
    const bgColorText   = document.getElementById('bgColorText');
    bgColorPicker.value = settings.get('backgroundColor');
    bgColorText.value   = settings.get('backgroundColor');
    bgColorPicker.addEventListener('input', (e) => { bgColorText.value = e.target.value; settings.set('backgroundColor', e.target.value); });
    bgColorText.addEventListener('input',   (e) => {
        if(/^#[0-9A-F]{6}$/i.test(e.target.value)) { bgColorPicker.value = e.target.value; settings.set('backgroundColor', e.target.value); }
    });

    const brightnessSlider  = document.getElementById('brightnessSlider');
    const brightnessDisplay = document.getElementById('brightnessDisplay');
    const brightnessValue   = document.getElementById('brightnessValue');
    brightnessSlider.value  = settings.get('brightness');
    brightnessDisplay.textContent = settings.get('brightness');
    brightnessValue.textContent   = settings.get('brightness') + '%';
    brightnessSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        brightnessDisplay.textContent = val;
        brightnessValue.textContent   = val + '%';
        settings.set('brightness', val);
    });

    const audioLimiterToggle = document.getElementById('audioLimiterToggle');
    audioLimiterToggle.checked = settings.get('audioLimiter') !== false;
    audioLimiterToggle.addEventListener('change', () => {
        settings.set('audioLimiter', audioLimiterToggle.checked);
        applyAudioLimiterSettings();
    });
    if (typeof applyAudioLimiterSettings === 'function') applyAudioLimiterSettings();

    const insertSoundFontBtn  = document.getElementById('insertSoundFontBtn');
    const soundFontFileInput  = document.getElementById('soundFontFileInput');
    const soundFontInfoEl     = document.getElementById('insertedSoundFontInfo');

    insertSoundFontBtn.addEventListener('click', () => soundFontFileInput.click());

    soundFontFileInput.addEventListener('change', async () => {
        const file = soundFontFileInput.files[0];
        if (!file) { soundFontFileInput.value = ''; return; }

        if (soundFontInfoEl) { soundFontInfoEl.textContent = 'Loading SoundFont...'; soundFontInfoEl.style.color = '#aaa'; }

        try {
            await ensureAudio();
            const arrayBuffer = await file.arrayBuffer();

            const sf2 = await loadSF2(arrayBuffer, audioContext);

            window.loadedSoundFont = {
                name: file.name,
                sf2,
                getZones: sf2.getZones,
                getSampleBuffer: sf2.getSampleBuffer,
                ensureSampleBuffers: sf2.ensureSampleBuffers,
            };

            if (audioContext && typeof sf2.ensureSampleBuffers === 'function') {
                sf2.ensureSampleBuffers().catch(() => {});
            }

            if (soundFontInfoEl) {
                soundFontInfoEl.textContent = `Using SoundFont: ${file.name}`;
                soundFontInfoEl.style.color = '#4c4';
            }

        } catch (err) {
            console.warn('Failed to load SoundFont:', err);
            if (soundFontInfoEl) {
                soundFontInfoEl.textContent = 'Failed: ' + (err.message || err);
                soundFontInfoEl.style.color = '#c44';
            }
        }

        soundFontFileInput.value = '';
    });

    const midiFileInput   = document.getElementById('midiFileInput');
    const loadMidiBtn     = document.getElementById('loadMidiBtn');
    const midiPlayerInfo  = document.getElementById('midiPlayerInfo');
    const midiPlayBtn     = document.getElementById('midiPlayBtn');
    const midiPauseBtn    = document.getElementById('midiPauseBtn');
    const midiStopBtn     = document.getElementById('midiStopBtn');
    const midiProgressBar = document.getElementById('midiProgressBar');
    const midiDuration    = document.getElementById('midiDuration');

    loadMidiBtn.addEventListener('click', () => midiFileInput.click());
    midiFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if(file) {
            const success = await midiPlayer.loadFile(file);
            if(success) {
                midiPlayer.computeAndStoreMidiInfo();
                const info = midiPlayer.midiInfo || {};
                let stats = `Loaded: ${file.name}`;
                if (info.trackCount) stats += `  |  Tracks: ${info.trackCount}`;
                if (info.ppq)        stats += `  |  PPQ: ${info.ppq}`;
                if (info.firstBPM)   stats += `  |  BPM: ${info.firstBPM.toFixed ? info.firstBPM.toFixed(1) : info.firstBPM}`;
                if (info.totalNoteOns)  stats += `  |  Notes: ${info.totalNoteOns}`;
                if (info.peakPolyphony) stats += `  |  Peak poly: ${info.peakPolyphony}`;
                midiPlayerInfo.textContent = stats;
                midiDuration.textContent   = midiPlayer.getTimeString(midiPlayer.duration);
                midiPlayer.stop();
                updateMIDIPlayerUI();
            } else {
                midiPlayerInfo.textContent = 'Error loading MIDI file';
                showErrorPopup('Failed to load MIDI file: unsupported or corrupted');
            }
            midiFileInput.value = '';
        }
    });
    midiPlayBtn.addEventListener('click', async () => { await ensureAudio(); midiPlayer.play(); updateMIDIPlayerUI(); });
    midiPauseBtn.addEventListener('click', () => { midiPlayer.pause(); updateMIDIPlayerUI(); });
    midiStopBtn.addEventListener('click',  () => { midiPlayer.stop();  updateMIDIPlayerUI(); });
    midiProgressBar.addEventListener('input', (e) => { midiPlayer.seek(e.target.value / 100); updateMIDIPlayerUI(); });

    let lastUiUpdate = 0;
    const uiUpdateInterval = 50;
    setInterval(() => {
        const now = performance.now();
        if (now - lastUiUpdate >= uiUpdateInterval && midiPlayer.isPlaying) { updateMIDIPlayerUI(); lastUiUpdate = now; }
    }, uiUpdateInterval);

    const gridToggle = document.getElementById('gridToggle');
    gridToggle.checked = settings.get('showGrid');
    gridToggle.addEventListener('change', (e) => settings.set('showGrid', e.target.checked));

    const midiDeviceSelect = document.getElementById('midiDeviceSelect');
    midiDeviceSelect.addEventListener('change', (e) => {
        const idx = e.target.value;
        if(idx) midiManager.selectInput(parseInt(idx));
        else { midiManager.selectedInput = null; settings.set('selectedMidiDevice', ''); }
    });

    document.getElementById('refreshMidiBtn').addEventListener('click', () => {
        midiManager.scanInputs();
        updateMIDIStatus(midiManager.isSupported, midiManager.isSupported ? 'Refreshed' : 'MIDI not supported');
    });

    document.getElementById('resetSettingsBtn').addEventListener('click', () => {
        if(confirm(t('resetConfirm'))) { settings.reset(); location.reload(); }
    });

    document.getElementById('exportSettingsBtn').addEventListener('click', () => {
        const blob = new Blob([settings.export()], {type:'application/json'});
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = `piano-settings-${Date.now()}.json`; a.click();
        URL.revokeObjectURL(url);
    });

    const importSettingsBtn  = document.getElementById('importSettingsBtn');
    const settingsFileInput  = document.getElementById('settingsFileInput');
    importSettingsBtn.addEventListener('click', () => settingsFileInput.click());
    settingsFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if(file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                if(settings.import(event.target.result)) { alert(t('settingsImported')); location.reload(); }
                else alert(t('settingsImportFailed'));
            };
            reader.readAsText(file);
        }
    });

    const settingsTabs = document.querySelectorAll('.settings-tab');
    settingsTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            settingsTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
            const target = document.getElementById('tab-' + tab.dataset.tab);
            if (target) target.classList.add('active');
        });
    });
}

function updateMIDIPlayerUI() {
    const midiProgressBar = document.getElementById('midiProgressBar');
    const midiCurrentTime = document.getElementById('midiCurrentTime');
    if(midiProgressBar) {
        midiProgressBar.value = midiPlayer.getProgress() * 100;
        midiCurrentTime.textContent = midiPlayer.getTimeString(midiPlayer.currentTime);
    }
}

function openSettingsPanel() {
    const panel = document.getElementById('settingsPanel');
    const overlay = document.getElementById('settingsOverlay');

    if (!panel.classList.contains('active')) {
        panel.classList.add('active');
        overlay.classList.add('active');

        try {
            sfxManager.playUIOpen();
        } catch(e) {}
    }
}

export { setupSettingsUI, updateMIDIPlayerUI, openSettingsPanel };
