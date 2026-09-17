import type { SpeechLanguage, SpeechVoice } from '../../types';
import type { DialogueLanguage, VideoLanguage } from '../../localWorkspaceApi';

export const defaultSpeechLanguages: SpeechLanguage[] = [
  { id: 'en-US', label: 'English · 英语', voices: [
    { id: 'en-US-JennyNeural', label: 'Jenny · 女声' },
    { id: 'en-US-GuyNeural', label: 'Guy · 男声' },
    { id: 'en-US-AriaNeural', label: 'Aria · 女声' },
  ] },
  { id: 'zh-CN', label: '中文 · 普通话', voices: [
    { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声' },
    { id: 'zh-CN-YunxiNeural', label: '云希 · 男声' },
    { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声' },
  ] },
];

export function voicesForLanguage(languages: SpeechLanguage[], language: VideoLanguage): SpeechVoice[] {
  const option = languages.find(item => item.id === language);
  if (option?.voices?.length) return option.voices;
  if (option?.voice) return [{ id: option.voice, label: option.voice }];
  return defaultSpeechLanguages.find(item => item.id === language)?.voices ?? [];
}

export function languageLabel(language: VideoLanguage, uiLanguage: 'zh-CN' | 'en' = 'zh-CN'): string {
  return uiLanguage === 'en' ? language === 'zh-CN' ? 'Chinese · Mandarin' : 'English' : language === 'zh-CN' ? '中文 · 普通话' : 'English · 英语';
}

export function dialogueLanguageLabel(language: DialogueLanguage, uiLanguage: 'zh-CN' | 'en' = 'zh-CN'): string {
  if (language === 'auto') return uiLanguage === 'en' ? 'Auto · Chinese / English' : '自动识别 · 中 / 英';
  return languageLabel(language, uiLanguage);
}

export function voiceLabel(voice: SpeechVoice, uiLanguage: 'zh-CN' | 'en' = 'zh-CN'): string {
  if (uiLanguage !== 'en') return voice.label;
  const labels: Record<string, string> = {
    'en-US-JennyNeural': 'Jenny · Female', 'en-US-GuyNeural': 'Guy · Male',
    'en-US-AriaNeural': 'Aria · Female', 'zh-CN-XiaoxiaoNeural': 'Xiaoxiao · Female',
    'zh-CN-YunxiNeural': 'Yunxi · Male', 'zh-CN-XiaoyiNeural': 'Xiaoyi · Female',
  };
  return labels[voice.id] || voice.id;
}
