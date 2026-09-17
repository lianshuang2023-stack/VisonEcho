import { duration } from './workspaceUtils';

export function frameTime(seconds: number): string {
  const milliseconds = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000);
  return duration(Math.floor(milliseconds / 1000)) + '.' + String(milliseconds % 1000).padStart(3, '0');
}
