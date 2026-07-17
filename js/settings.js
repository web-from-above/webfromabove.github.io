class Settings {
    constructor() {
        this.defaults = {
            noteSpeed: 80,
            masterVolume: 100,
            brightness: 50,
            backgroundColor: '#464646',
            showGrid: true,
            selectedMidiDevice: '',
            language: 'en',
            audioLimiter: true
        };
        this.current = { ...this.defaults };
        this.load();
    }
    load() {
        const saved = localStorage.getItem('pianoSettings');
        if(saved) {
            try { this.current = { ...this.defaults, ...JSON.parse(saved) }; }
            catch(e) { console.warn('Failed to load settings:', e); this.current = { ...this.defaults }; }
        }
    }
    save() { localStorage.setItem('pianoSettings', JSON.stringify(this.current)); }
    reset() { this.current = { ...this.defaults }; this.save(); }
    export() { return JSON.stringify(this.current, null, 2); }
    import(json) {
        try { const imported = JSON.parse(json); this.current = { ...this.defaults, ...imported }; this.save(); return true; }
        catch(e) { console.warn('Failed to import settings:', e); return false; }
    }
    get(key) { return this.current[key] !== undefined ? this.current[key] : this.defaults[key]; }
    set(key, value) { this.current[key] = value; this.save(); }
}

const settings = new Settings();

export { Settings, settings };
