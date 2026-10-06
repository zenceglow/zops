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

// 改了 zh/en.json 之后把新资源灌回去。
//
// 不加这段，dev 下热更新只换了模块，i18next 里还是启动时那份 —— 页面上会冒出一排
// 形如 `deploy.title` 的原始 key，看起来像"没做本地化"，其实只是没重新载入。
if (import.meta.hot) {
  import.meta.hot.accept(['./zh.json', './en.json'], (mods) => {
    const [zhMod, enMod] = mods ?? [];
    const zhNext = (zhMod as { default?: Record<string, unknown> } | undefined)?.default;
    const enNext = (enMod as { default?: Record<string, unknown> } | undefined)?.default;
    if (zhNext) i18n.addResourceBundle('zh', 'translation', zhNext, true, true);
    if (enNext) i18n.addResourceBundle('en', 'translation', enNext, true, true);
  });
}
