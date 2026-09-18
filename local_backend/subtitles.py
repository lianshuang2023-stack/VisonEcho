"""Subtitle-only presentation normalization; raw Speech words stay unchanged."""
from __future__ import annotations

from copy import deepcopy
import re
import unicodedata

SPEAKER_PATTERN = r'speaker_[1-9][0-9]{0,5}'
_SPEAKER = re.compile(SPEAKER_PATTERN)


def _cjk(character):
    return bool(character) and ('㐀' <= character <= '鿿' or '぀' <= character <= 'ヿ' or '가' <= character <= '힯')


def normalize_subtitle_text(value: str) -> str:
    """Remove spoken-line punctuation, retaining contractions and numeric form."""
    text = str(value)
    output = []
    for index, character in enumerate(text):
        previous = text[index - 1] if index else ''
        following = text[index + 1] if index + 1 < len(text) else ''
        category = unicodedata.category(character)
        if not category.startswith('P'):
            output.append(character)
            continue
        if character in ("'", '’') and previous.isalpha() and following.isalpha() and not _cjk(previous) and not _cjk(following):
            output.append(character)
        elif character in ('.', ',') and previous.isdigit() and following.isdigit():
            output.append(character)
        elif category == 'Pd':
            output.append(' ')
        else:
            left, right = index - 1, index + 1
            while left >= 0 and unicodedata.category(text[left]).startswith('P'):
                left -= 1
            while right < len(text) and unicodedata.category(text[right]).startswith('P'):
                right += 1
            previous = text[left] if left >= 0 else ''
            following = text[right] if right < len(text) else ''
            if previous and following and not previous.isspace() and not following.isspace() and not (_cjk(previous) and _cjk(following)):
                output.append(' ')
    return ' '.join(''.join(output).split())


def _safe_quality(item):
    quality = {}
    confidence = item.get('confidence')
    if type(confidence) in (int, float) and 0 <= confidence <= 1:
        quality['confidence'] = confidence
    for field in ('uncertain', 'low_confidence'):
        if type(item.get(field)) is bool:
            quality[field] = item[field]
    return quality


def subtitle_cue_view(cues):
    """Return a presentation copy without rewriting a historical transcript."""
    result = []
    for cue in cues:
        item = deepcopy(cue)
        item['text'] = normalize_subtitle_text(item.get('text', ''))
        speaker = item.get('speaker')
        if speaker is not None and (not isinstance(speaker, str) or not _SPEAKER.fullmatch(speaker)):
            item['speaker'] = None
        for field in ('confidence', 'uncertain', 'low_confidence'):
            item.pop(field, None)
        item.update(_safe_quality(cue))
        result.append(item)
    return result


def speaker_label(speaker, language='en-US'):
    if not isinstance(speaker, str) or not _SPEAKER.fullmatch(speaker):
        return None
    index = speaker.split('_', 1)[1]
    return f'说话人 {index}' if language == 'zh-CN' else f'Speaker {index}'
