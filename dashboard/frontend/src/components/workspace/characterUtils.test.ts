import { describe, expect, it } from 'vitest';
import { proposeCharacterRenames } from './characterUtils';
import type { NarrationSegment, VideoCharacter } from '../../localWorkspaceApi';

const character: VideoCharacter = { id: 'person-1', preferred_name: 'Ann', appearance: 'Red coat', aliases: ['red-coat woman'], status: 'confirmed', thumbnail: null, occurrences: [{ job_id: 'job-1', segment_index: 0 }] };
const segment = (segment_index: number, dvi_text: string, character_ids?: string[]): NarrationSegment => ({ segment_index, dvi_text, character_ids, start_time: 0, end_time: 3, silence_duration: 3, audio_duration: 2, pass: true });

describe('character name review', () => {
  it('separates linked segments from possible matches and never replaces inside a longer name', () => {
    const proposals = proposeCharacterRenames(character, { ...character, preferred_name: 'Alice' }, 'job-1', [
      segment(0, 'Ann looks at Anna.'), segment(1, 'Ann sits.'), segment(2, 'Anna smiles.'), segment(3, 'The red-coat woman walks.', ['person-1']),
    ]);
    expect(proposals).toEqual([
      { segmentIndex: 0, before: 'Ann looks at Anna.', after: 'Alice looks at Anna.', linked: true },
      { segmentIndex: 1, before: 'Ann sits.', after: 'Alice sits.', linked: false },
      { segmentIndex: 3, before: 'The red-coat woman walks.', after: 'The Alice walks.', linked: true },
    ]);
  });
  it('handles Chinese aliases and metacharacters as literal text', () => {
    const previous = { ...character, preferred_name: '红衣女子', aliases: ['A+B'] };
    const result = proposeCharacterRenames(previous, { ...previous, preferred_name: '小林' }, 'job-1', [segment(0, '红衣女子转身，A+B举起手。')]);
    expect(result[0].after).toBe('小林转身，小林举起手。');
  });
  it('can check aliases again after a saved name change without cascading replacements', () => {
    const next = { ...character, preferred_name: 'Ann Smith', aliases: ['Ann'] };
    const result = proposeCharacterRenames(next, next, 'other-job', [segment(0, 'Ann waits. Ann Smith sits.')]);
    expect(result).toEqual([{ segmentIndex: 0, before: 'Ann waits. Ann Smith sits.', after: 'Ann Smith waits. Ann Smith sits.', linked: false }]);
  });
});
