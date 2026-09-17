import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { UI_PREFERENCES_KEY, UiPreferencesContext } from './uiPreferences';
import type { UiLanguage, UiTheme } from './uiPreferences';

function readPreferences(): { language: UiLanguage; theme: UiTheme } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) || '{}');
    return { language: saved.language === 'en' ? 'en' : 'zh-CN', theme: saved.theme === 'dark' ? 'dark' : 'light' };
  } catch { return { language: 'zh-CN', theme: 'light' }; }
}

export default function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const { language, theme } = preferences;
  const setLanguage = useCallback((next: UiLanguage) => setPreferences(current => ({ ...current, language: next })), []);
  const setTheme = useCallback((next: UiTheme) => setPreferences(current => ({ ...current, theme: next })), []);
  const t = useCallback((zh: string, en: string) => language === 'en' ? en : zh, [language]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.uiTheme = theme;
    document.documentElement.style.colorScheme = theme;
    document.title = language === 'en' ? 'VisionEcho · Audio Description Studio' : 'VisionEcho · 视频无障碍工作室';
    try { window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Preferences still work when storage is unavailable. */ }
  }, [preferences, language, theme]);
  const value = useMemo(() => ({ language, theme, setLanguage, setTheme, t }), [language, theme, setLanguage, setTheme, t]);
  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}
