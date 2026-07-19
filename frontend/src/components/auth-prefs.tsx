import { useTranslation } from 'react-i18next';
import { NavLangIcon } from './icons/nav-icons';
import { cn } from '../lib/utils';
import { useThemeStore } from '../stores/theme-store';
import { nextTheme, themeIcon, themeLabelKey } from '../stores/theme-prefs';

function PrefButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground',
        'transition-colors hover:bg-muted/70 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Compact theme + language controls for public pages (login / setup). */
export function AuthPrefs() {
  const { t, i18n } = useTranslation();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const toggleLang = () => {
    const next = i18n.language === 'zh' ? 'en' : 'zh';
    i18n.changeLanguage(next);
    localStorage.setItem('ops-lang', next);
  };

  const ThemeIcon = themeIcon(theme);
  const themeLabel = t(themeLabelKey(theme));

  return (
    <div className="flex items-center gap-0.5">
      <PrefButton onClick={toggleLang} label={t('nav.switch_lang')}>
        <NavLangIcon />
        <span className="text-xs font-medium">{t('nav.switch_lang')}</span>
      </PrefButton>
      <PrefButton onClick={() => setTheme(nextTheme(theme))} label={themeLabel}>
        <ThemeIcon />
        <span className="text-xs font-medium">{themeLabel}</span>
      </PrefButton>
    </div>
  );
}
