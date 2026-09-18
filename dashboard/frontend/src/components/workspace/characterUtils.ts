import type { NarrationSegment, VideoCharacter } from '../../localWorkspaceApi';

export interface NarrationReplacement { segmentIndex: number; before: string; after: string; linked: boolean }

function replaceName(text: string, aliases: string[], name: string): string {
  const ordered = [...new Set(aliases.map(alias => alias.trim()).filter(alias => alias && alias !== name))].sort((a, b) => b.length - a.length);
  const isLatinWord = (value: string) => /[\p{Script=Latin}\d_]/u.test(value);
  let result = '';
  for (let index = 0; index < text.length;) {
    if (text.startsWith(name, index)) { result += name; index += name.length; continue; }
    const matched = ordered.find(alias => {
      if (!text.startsWith(alias, index)) return false;
      if (isLatinWord(alias[0]) && isLatinWord(text[index - 1] ?? '')) return false;
      if (isLatinWord(alias.at(-1) ?? '') && isLatinWord(text[index + alias.length] ?? '')) return false;
      return true;
    });
    result += matched ? name : text[index];
    index += matched?.length ?? 1;
  }
  return result;
}

export function proposeCharacterRenames(previous: VideoCharacter, next: VideoCharacter, jobId: string, segments: NarrationSegment[]): NarrationReplacement[] {
  if (!next.preferred_name.trim()) return [];
  const related = new Set([...previous.occurrences, ...next.occurrences].filter(item => item.job_id === jobId).map(item => item.segment_index));
  return segments.flatMap(segment => {
    const sourceTime = segment.source_start ?? segment.start_time;
    const name = sourceTime < (next.name_available_from ?? 0) ? (next.before_name?.trim() || next.appearance.trim()) : next.preferred_name.trim();
    if (!name) return [];
    const linked = related.has(segment.segment_index) || Boolean(segment.character_ids?.includes(previous.id));
    const after = replaceName(segment.dvi_text, [previous.preferred_name, previous.before_name ?? '', ...previous.aliases, ...next.aliases], name);
    return after === segment.dvi_text ? [] : [{ segmentIndex: segment.segment_index, before: segment.dvi_text, after, linked }];
  });
}
