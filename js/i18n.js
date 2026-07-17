import { settings } from './settings.js';

const supportedLanguages = ['en','de','fr','es','pt','ro','ru','ar','hi','kr','zh-CN','zh-TW'];
const langDisplayNames = {
  'en': 'English', 'de': 'Deutsch', 'fr': 'Français', 'es': 'Español',
  'pt': 'Português', 'ro': 'Română', 'ru': 'Русский', 'ar': 'العربية',
  'hi': 'हिन्दी', 'kr': '한국어', 'zh-CN': '中文(简)', 'zh-TW': '中文(繁)'
};
let currentTranslations = {};
const langDropdownVisible = { value: false };

async function loadLanguage(langCode) {
  if (!supportedLanguages.includes(langCode)) langCode = 'en';
  try {
    const res = await fetch(`lang/${langCode}.json`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    currentTranslations = await res.json();
    settings.set('language', langCode);
    applyTranslations();
    updateLangButton(langCode);
  } catch (e) {
    console.warn('[i18n] Failed to load', langCode, e);
    if (langCode !== 'en') return loadLanguage('en');
  }
}

function t(key) {
  return (currentTranslations.settings && currentTranslations.settings[key]) || key;
}

function updateLangButton(langCode) {
  const btn = document.getElementById('langBtn');
  if (btn) btn.textContent = (langCode || 'en').toUpperCase().slice(0,5);
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  const title = document.getElementById('settingsTitle');
  if (title) title.textContent = t('title');
  document.documentElement.lang = settings.get('language') || 'en';
}

function toggleLangDropdown() {
  const dd = document.getElementById('langDropdown');
  if (!dd) return;
  langDropdownVisible.value = !langDropdownVisible.value;
  if (!langDropdownVisible.value) { dd.classList.remove('visible'); return; }
  dd.innerHTML = '';
  const current = settings.get('language') || 'en';
  supportedLanguages.forEach(code => {
    const b = document.createElement('button');
    b.textContent = `${langDisplayNames[code] || code} (${code})`;
    if (code === current) b.classList.add('active');
    b.onclick = async () => { dd.classList.remove('visible'); langDropdownVisible.value = false; await loadLanguage(code); };
    dd.appendChild(b);
  });
  dd.classList.add('visible');
}

export { t, loadLanguage, updateLangButton, applyTranslations, toggleLangDropdown,
         currentTranslations, langDropdownVisible, supportedLanguages, langDisplayNames };
