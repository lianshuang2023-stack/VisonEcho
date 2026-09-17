export function duration(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(value / 3600);
  return (hours ? hours + ':' : '') + String(Math.floor(value / 60) % 60).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}
export function dateTime(value: string, locale: 'zh-CN' | 'en' = 'zh-CN') {
  if (!value) return locale === 'en' ? 'Just now' : '刚刚';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString(locale === 'en' ? 'en-GB' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
export const errorMessage = (error: unknown, locale: 'zh-CN' | 'en' = 'zh-CN') => error instanceof Error ? error.message : locale === 'en' ? 'The operation could not be completed. Try again.' : '操作未完成，请重试。';
