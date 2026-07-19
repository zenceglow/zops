import { useEffect } from 'react';
import { initTheme } from '../stores/theme-store';

export function ThemeProvider() {
  useEffect(() => initTheme(), []);
  return null;
}
