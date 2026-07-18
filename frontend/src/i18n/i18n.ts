import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './zh.json';
import en from './en.json';

const saved = localStorage.getItem('ops-lang');
const detected = navigator.language.startsWith('zh') ? 'zh' : 'en';
const lng = saved ?? detected;

i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18n;
