import type { TimelineInsertion, TranscriptCue } from '../../localWorkspaceApi';

export function toSourceTime(value: number, insertions: TimelineInsertion[] = []) {
  let offset = 0;
  for (const pause of [...insertions].sort((a, b) => a.output_start - b.output_start)) {
    if (value < pause.output_start) break;
    if (value < pause.output_end) return pause.source_time;
    offset += pause.duration;
  }
  return Math.max(0, value - offset);
}

export function toOutputTime(value: number, insertions: TimelineInsertion[] = []) {
  return value + insertions.reduce((sum, pause) => sum + (value >= pause.source_time ? pause.duration : 0), 0);
}

export function sourceCues(cues: TranscriptCue[], insertions: TimelineInsertion[] = []) {
  return cues.map(cue => ({ ...cue, start: toSourceTime(cue.start, insertions), end: toSourceTime(cue.end, insertions) })).filter(cue => cue.end > cue.start);
}
