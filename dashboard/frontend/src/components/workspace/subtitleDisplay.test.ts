import { describe, expect, it } from 'vitest';
import { activeSubtitleCues, hasSpeakerMetadata, invalidSubtitleCues, speakerLabel, subtitleSpeakerOptions } from './subtitleDisplay';
import type { TranscriptCue } from '../../localWorkspaceApi';
const cues: TranscriptCue[] = [{ id: 'a', start: 1, end: 4, text: 'Hello', speaker: 'speaker_1' }, { id: 'b', start: 2, end: 3, text: 'Welcome', speaker: 'speaker_2' }];

describe('speaker-aware subtitle display', () => {
  it('returns all simultaneous cues with exclusive end timestamps', () => {
    expect(activeSubtitleCues(cues, 2.5).map(cue => cue.id)).toEqual(['a', 'b']);
    expect(activeSubtitleCues(cues, 3).map(cue => cue.id)).toEqual(['a']);
  });
  it('allows overlaps only when both speakers are known and different', () => {
    expect(invalidSubtitleCues(cues, 10)).toBe(false);
    expect(invalidSubtitleCues([cues[0], { ...cues[1], speaker: 'speaker_1' }], 10)).toBe(true);
    expect(invalidSubtitleCues([cues[0], { ...cues[1], speaker: null }], 10)).toBe(true);
    expect(invalidSubtitleCues([cues[0], { ...cues[1], speaker: undefined }], 10)).toBe(true);
  });
  it('checks an earlier long cue even when the immediately previous speaker is different', () => {
    expect(invalidSubtitleCues([...cues, { id: 'c', start: 3.1, end: 5, text: 'Again', speaker: 'speaker_1' }], 10)).toBe(true);
    expect(invalidSubtitleCues([cues[1], cues[0]], 10)).toBe(true);
  });
  it('distinguishes unknown metadata from legacy cues and labels speakers without identities', () => {
    expect(hasSpeakerMetadata([{ id: 'old', start: 0, end: 1, text: 'Old' }])).toBe(false);
    expect(hasSpeakerMetadata([{ id: 'new', start: 0, end: 1, text: 'New', speaker: null }])).toBe(true);
    expect(speakerLabel('speaker_2', (_zh, en) => en)).toBe('Speaker 2');
    expect(speakerLabel(null, zh => zh)).toBe('待确认说话人');
    expect(subtitleSpeakerOptions(cues)).toContain('speaker_20');
  });
});
