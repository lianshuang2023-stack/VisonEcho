import { createContext, useContext } from 'react';

export type UiLanguage = 'zh-CN' | 'en';
export type UiTheme = 'light' | 'dark';
export type Translate = (zh: string, en: string) => string;
export const UI_PREFERENCES_KEY = 'visionecho-ui-preferences';

export interface UiPreferences {
  language: UiLanguage;
  theme: UiTheme;
  setLanguage: (language: UiLanguage) => void;
  setTheme: (theme: UiTheme) => void;
  t: Translate;
}

export const UiPreferencesContext = createContext<UiPreferences>({
  language: 'zh-CN', theme: 'light',
  setLanguage: () => {}, setTheme: () => {}, t: zh => zh,
});

export function useUiPreferences() {
  return useContext(UiPreferencesContext);
}
