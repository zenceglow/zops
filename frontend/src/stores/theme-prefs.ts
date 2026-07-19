import type { ComponentType } from 'react';
import {
  NavDesktopIcon,
  NavMoonIcon,
  NavSunIcon,
} from '../components/icons/nav-icons';
import type { Theme } from './theme-store';

const THEME_CYCLE: Record<Theme, Theme> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

export function nextTheme(theme: Theme): Theme {
  return THEME_CYCLE[theme];
}

export function themeIcon(theme: Theme): ComponentType<{ className?: string }> {
  if (theme === 'dark') return NavMoonIcon;
  if (theme === 'light') return NavSunIcon;
  return NavDesktopIcon;
}

/** i18n keys: theme.light / theme.dark / theme.system */
export function themeLabelKey(theme: Theme): 'theme.light' | 'theme.dark' | 'theme.system' {
  if (theme === 'dark') return 'theme.dark';
  if (theme === 'light') return 'theme.light';
  return 'theme.system';
}
