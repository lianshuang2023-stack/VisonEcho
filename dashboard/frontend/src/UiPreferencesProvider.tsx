import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FluentProvider, webLightTheme, webDarkTheme } from '@fluentui/react-components';
import { UI_PREFERENCES_KEY, UiPreferencesContext } from './uiPreferences';
import type { UiLanguage, UiTheme } from './uiPreferences';
import { isOverviewHash } from './pageNavigation';

function readPreferences(): { language: UiLanguage; theme: UiTheme } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) || '{}');
    // A fresh visit to the introduction always starts in English. Language
    // switches still apply for the current visit; direct studio visits remember them.
    return { language: !isOverviewHash(window.location.hash) && saved.language === 'zh-CN' ? 'zh-CN' : 'en', theme: saved.theme === 'dark' ? 'dark' : 'light' };
  } catch { return { language: 'en', theme: 'light' }; }
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
  const fluentTheme = useMemo(() => ({ ...(theme === 'dark' ? webDarkTheme : webLightTheme),
    colorBrandBackground: theme === 'dark' ? '#87c8b2' : '#29604a',
    colorBrandBackgroundHover: theme === 'dark' ? '#a7dcc5' : '#214e3d',
    colorBrandBackgroundPressed: theme === 'dark' ? '#b9e2d2' : '#193d2f',
    colorNeutralForegroundOnBrand: theme === 'dark' ? '#11271b' : '#ffffff',
    colorBrandForeground1: theme === 'dark' ? '#a7dcc5' : '#29604a',
    colorBrandStroke1: theme === 'dark' ? '#87c8b2' : '#29604a',
    colorCompoundBrandStroke: theme === 'dark' ? '#87c8b2' : '#29604a',
    colorCompoundBrandForeground1: theme === 'dark' ? '#a7dcc5' : '#29604a',
    colorCompoundBrandForeground1Hover: theme === 'dark' ? '#b9e2d2' : '#214e3d',
    fontFamilyBase: '"Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
  }), [theme]);
  return <UiPreferencesContext.Provider value={value}><FluentProvider theme={fluentTheme} style={{ background: 'transparent', minHeight: '100dvh' }}>{children}</FluentProvider></UiPreferencesContext.Provider>;
}
