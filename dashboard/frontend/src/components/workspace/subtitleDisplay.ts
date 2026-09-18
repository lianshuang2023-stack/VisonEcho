import type { TranscriptCue } from '../../localWorkspaceApi';
import type { Translate } from '../../uiPreferences';

export function speakerLabel(speaker: string | null | undefined, t: Translate): string {
  const match = /^speaker_([1-9][0-9]*)$/.exec(speaker ?? '');
  return match ? t('说话人 ', 'Speaker ') + match[1] : t('待确认说话人', 'Unknown speaker');
}

export function hasSpeakerMetadata(cues: TranscriptCue[]): boolean {
  return cues.some(cue => Object.hasOwn(cue, 'speaker'));
}

export function activeSubtitleCues(cues: TranscriptCue[], time: number): TranscriptCue[] {
  return cues.filter(cue => time >= cue.start && time < cue.end);
}

export function subtitleSpeakerOptions(cues: TranscriptCue[]): string[] {
  const ids = new Set(cues.map(cue => cue.speaker).filter((speaker): speaker is string => typeof speaker === 'string' && /^speaker_[1-9][0-9]*$/.test(speaker)));
  for (let index = 1; index <= 20; index++) ids.add('speaker_' + index);
  return [...ids].sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
}

/** Different known speakers may overlap; unknown or identical speakers may not. */
export function invalidSubtitleCues(cues: TranscriptCue[], total: number): boolean {
  return cues.some((cue, index) => {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > total + .01 || !cue.text.trim()) return true;
    if (cue.speaker != null && !/^speaker_[1-9][0-9]*$/.test(cue.speaker)) return true;
    if (index > 0 && cue.start < cues[index - 1].start) return true;
    return cues.slice(0, index).some(previous => cue.start < previous.end && cue.end > previous.start && (!cue.speaker || !previous.speaker || cue.speaker === previous.speaker));
  });
}
