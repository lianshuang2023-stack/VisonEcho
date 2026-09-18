"""Authoritative segment review tied to saved narration and its dependencies."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .lifecycle import require_video, video_running
from .projects import _get_result, _transcript


class SegmentReviewChange(BaseModel):
    model_config = ConfigDict(extra='forbid')
    segment_index: int = Field(ge=0, strict=True)
    state: Literal['approved', 'needs_rewrite', 'draft']


class ReviewChanges(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=0, strict=True)
    transcript_revision: int = Field(ge=0, strict=True)
    changes: list[SegmentReviewChange] = Field(min_length=1, max_length=120)


def _finite(value, default=0):
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (ValueError, TypeError, OverflowError):
        return default


def _default_state(store, job, segment):
    text = str(segment.get('dvi_text', '')).strip()
    if 'evidence_description' in segment and text != str(segment['evidence_description']).strip():
        return 'modified'
    ancestor_id = job.get('source_execution_id') or job['result'].get('source_execution_id')
    ancestor = store.data['executions'].get(ancestor_id, {})
    if ancestor.get('video_id') == job['video_id']:
        previous = next((item for item in ancestor.get('result', {}).get('segments', [])
                         if item.get('segment_index') == segment['segment_index']), None)
        if previous and text != str(previous.get('dvi_text', '')).strip():
            return 'modified'
    return 'draft'


def _document_locked(store, job_id):
    """Read-only calculation. Caller holds the non-reentrant store lock."""
    job, result, directory = _get_result(store, job_id)
    if job.get('deleted') or job.get('deleted_at'):
        raise HTTPException(404, 'Video version not found.')
    source = require_video(store.data, job['video_id'])
    raw_segments = result.get('segments', [])
    if not isinstance(raw_segments, list) or len(raw_segments) > 120:
        raise HTTPException(409, 'Saved narration segments are invalid.')
    indices = [segment.get('segment_index') for segment in raw_segments if isinstance(segment, dict)]
    if len(indices) != len(raw_segments) or len(set(indices)) != len(indices) or any(type(index) is not int or index < 0 for index in indices):
        raise HTTPException(409, 'Saved narration segment identifiers are invalid.')
    transcript_available = True
    try:
        transcript = _transcript(store, job_id)
    except HTTPException:
        transcript_available = False
        transcript = {'revision': job.get('transcript_revision', 0), 'cues': []}
    transcript_revision = transcript.get('revision', 0)
    if type(transcript_revision) is not int or transcript_revision < 0:
        transcript_available = False
        transcript_revision = 0
    cues = transcript.get('cues', [])
    dialogue = []
    if not isinstance(cues, list):
        cues = []
        transcript_available = False
    for cue in cues:
        if not isinstance(cue, dict):
            transcript_available = False
            continue
        start, end = _finite(cue.get('start'), -1), _finite(cue.get('end'), -1)
        if start < 0 or end <= start:
            transcript_available = False
        elif str(cue.get('text', '')).strip():
            dialogue.append((start, end))
    quality = transcript.get('quality', {})
    known_no_speech = (transcript.get('dialogue_status') == 'no_speech' and transcript.get('dialogue_reason') in
                       ('silent_audio', 'no_audio_track', 'user_declared_no_dialogue'))
    confirmed_empty = known_no_speech and isinstance(quality, dict) and quality.get('review_required') is False
    uncertain_transcript = isinstance(quality, dict) and not confirmed_empty and (quality.get('review_required') is True or any(
        type(quality.get(key)) is int and quality[key] > 0
        for key in ('low_confidence_phrase_count', 'low_confidence_word_count', 'no_match_count')))
    output = Path(result.get('output_path') or '').resolve()
    output_exists = output.is_relative_to(directory) and output.is_file()
    output_signature = None
    if output_exists:
        try:
            stats = output.stat()
            output_signature = [stats.st_size, stats.st_mtime_ns]
        except OSError:
            output_exists = False
    # Effective subtitles are in the exported timeline, including inserted
    # pauses. Never compare source_start/source_end against shifted subtitles.
    fingerprint = hashlib.sha256(json.dumps({
        'segments': raw_segments, 'transcript': transcript, 'transcript_available': transcript_available,
        'feedback': job.get('evidence_feedback', {}), 'insertions': result.get('insertions', []),
        'characters': source.get('character_cards', {'revision': 0, 'characters': []}),
        'source_execution_id': job.get('source_execution_id'),
        'output_signature': output_signature,
    }, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()
    saved = job.get('segment_review') or {}
    valid_saved = saved.get('fingerprint') == fingerprint
    saved_revision = saved.get('revision', 0)
    if type(saved_revision) is not int or saved_revision < 0:
        raise HTTPException(409, 'Saved review revision is invalid.')
    # Before any review is saved, and after each independent dependency edit,
    # a stale client must not be able to approve newly changed content using
    # the same nominal revision. A 52-bit fingerprint token is a safe integer
    # in JavaScript; consumers treat it as opaque, not a user-facing counter.
    revision = saved_revision if valid_saved else int(hashlib.sha256(
        (fingerprint + ':' + str(saved_revision)).encode()).hexdigest()[:13], 16)
    states = saved.get('states', {}) if valid_saved else {}
    rows = []
    required = []
    high_codes = {'empty_text', 'unrendered_audio', 'duration_conflict', 'dialogue_overlap', 'name_spoiler',
                  'narration_overlap', 'invalid_timing', 'evidence_feedback', 'unverified_transcript'}
    feedback = job.get('evidence_feedback', {})
    for segment in raw_segments:
        index = segment['segment_index']
        text = str(segment.get('dvi_text', '')).strip()
        start = _finite(segment.get('start_time'), -1)
        end = _finite(segment.get('end_time'), -1)
        window = _finite(segment.get('silence_duration'))
        available = max(0.0, min(end - start, window)) if window > 0 else max(0.0, end - start)
        measured = _finite(segment.get('audio_duration'))
        if measured > 0:
            speech, timing_source = measured, 'measured'
        else:
            from .pipeline import _word_count
            language = result.get('language', job.get('language', 'en-US'))
            speech, timing_source = (_word_count(text) / (3.8 if language == 'zh-CN' else 2.15) if text else 0), 'estimated'
        risks = []
        if not text:
            risks.append('empty_text')
        if start < 0 or end <= start or available <= 0:
            risks.append('invalid_timing')
        if not segment.get('pass') or measured <= 0:
            risks.append('unrendered_audio')
        if speech > available + .03:
            risks.append('duration_conflict')
        if speech > 0 and any(min(start + speech, right) - max(start, left) > .03 for left, right in dialogue):
            risks.append('dialogue_overlap')
        if speech > 0 and any(other.get('segment_index') != index and other.get('pass') and
            min(start + speech, _finite(other.get('start_time')) + _finite(other.get('audio_duration'))) -
            max(start, _finite(other.get('start_time'))) > .03 for other in raw_segments):
            risks.append('narration_overlap')
        evidence = segment.get('visual_evidence')
        if not isinstance(evidence, list) or not evidence or not segment.get('frame_timestamps'):
            risks.append('unverified_visual_evidence')
        elif 'evidence_description' in segment and str(segment['evidence_description']).strip() != text:
            risks.append('unverified_visual_evidence')
        if segment.get('uncertain') or segment.get('review_required') or any(
                isinstance(item, dict) and (item.get('uncertain') or item.get('confidence') in ('low', 'uncertain'))
                for item in (evidence if isinstance(evidence, list) else [])):
            risks.append('uncertain_visual_evidence')
        source_start = _finite(segment.get('source_start', segment.get('start_time')))
        for card in source.get('character_cards', {}).get('characters', []):
            if source_start >= _finite(card.get('name_available_from')):
                continue
            before_name = str(card.get('before_name', '')).strip().casefold()
            names = [card.get('preferred_name', '')] + (card.get('aliases') if isinstance(card.get('aliases'), list) else [])
            for value in names:
                name = str(value).strip()
                if not name or name.casefold() == before_name:
                    continue
                pattern = re.escape(name)
                if name.isascii():
                    pattern = r'(?<![A-Za-z0-9_])' + pattern + r'(?![A-Za-z0-9_])'
                if re.search(pattern, text, re.IGNORECASE):
                    risks.append('name_spoiler')
                    break
            if 'name_spoiler' in risks:
                break
        notes = feedback.get(str(index), {})
        if notes.get('issues') or str(notes.get('note', '')).strip():
            risks.append('evidence_feedback')
        if not transcript_available:
            risks.append('unverified_transcript')
        elif uncertain_transcript:
            risks.append('uncertain_transcript')
        state = states.get(str(index), _default_state(store, job, segment))
        if state not in ('draft', 'modified', 'approved', 'needs_rewrite'):
            state = _default_state(store, job, segment)
        high_risk = bool(high_codes.intersection(risks))
        if state == 'approved' and high_risk:
            state = _default_state(store, job, segment)
        row = {'segment_index': index, 'state': state, 'text': text,
               'available_seconds': round(available, 3), 'speech_seconds': round(speech, 3),
               'timing_source': timing_source, 'margin_seconds': round(available - speech, 3),
               'risks': risks, 'high_risk': high_risk}
        rows.append(row)
        # Every planned narration window needs a saved, voiced, reviewed text.
        # Empty or skipped windows cannot disappear from the export checklist.
        required.append(row)
    counts = {'total': len(required), 'pending': sum(row['state'] != 'approved' for row in required),
              'approved': sum(row['state'] == 'approved' for row in required),
              'conflicts': sum(any(code in row['risks'] for code in ('duration_conflict', 'dialogue_overlap', 'narration_overlap', 'invalid_timing')) for row in required),
              'uncertain': sum(any(code in row['risks'] for code in ('unverified_visual_evidence', 'uncertain_visual_evidence', 'evidence_feedback', 'uncertain_transcript')) for row in required)}
    blockers = []
    if not required or not any(segment.get('pass') and str(segment.get('dvi_text', '')).strip() for segment in raw_segments):
        blockers.append('no_narration')
    if counts['pending']:
        blockers.append('pending_review')
    if any(row['high_risk'] for row in required):
        blockers.append('high_risk_segments')
    if not transcript_available:
        blockers.append('unverified_transcript')
    if not output_exists:
        blockers.append('missing_output')
    if source.get('archived'):
        blockers.append('archived_video')
    if video_running(store.data, job['video_id']):
        blockers.append('processing')
    return {'revision': revision, 'transcript_revision': transcript_revision, 'segments': rows,
            'counts': counts, 'review_complete': not blockers, 'can_export': output_exists, 'blockers': blockers}, fingerprint


def get_review_document(store, job_id):
    with store.lock:
        return _document_locked(store, job_id)[0]


def require_review_complete(store, job_id):
    """Caller holds store.lock. Review is advisory and never authorizes exports."""
    document = _document_locked(store, job_id)[0]
    if not document['review_complete']:
        raise HTTPException(409, '请逐段确认口述稿并解决待处理问题后，再标记审校完成。这不影响导出已保存的文件。')
    return document


def register_review_routes(app, store, settings):
    @app.get('/api/videos/{job_id}/review-state')
    def get_review(job_id: str):
        return get_review_document(store, job_id)

    @app.put('/api/videos/{job_id}/review-state')
    def update_review(job_id: str, payload: ReviewChanges):
        with store.lock:
            document, fingerprint = _document_locked(store, job_id)
            job, _, _ = _get_result(store, job_id)
            source = require_video(store.data, job['video_id'])
            if source.get('archived') or video_running(store.data, job['video_id']):
                raise HTTPException(409, '请等待处理完成并恢复归档视频后，再保存校对状态。')
            if payload.revision != document['revision'] or payload.transcript_revision != document['transcript_revision']:
                raise HTTPException(409, '口述稿或字幕已变化，请重新加载后校对。')
            indices = [change.segment_index for change in payload.changes]
            rows = {row['segment_index']: row for row in document['segments']}
            if len(indices) != len(set(indices)) or any(index not in rows for index in indices):
                raise HTTPException(422, 'Each change must refer to one existing narration segment.')
            if any(change.state == 'approved' and rows[change.segment_index]['high_risk'] for change in payload.changes):
                raise HTTPException(409, '存在未配音、空白文本、时长或对白冲突，或待处理的画面纠错；请先修正。')
            before = deepcopy(store.data)
            states = {str(row['segment_index']): row['state'] for row in document['segments']}
            states.update({str(change.segment_index): change.state for change in payload.changes})
            job['segment_review'] = {'revision': document['revision'] + 1, 'fingerprint': fingerprint, 'states': states}
            job.update(reviewed=False, transcript_revision=document['transcript_revision'])
            job.pop('reviewed_at', None)
            job.pop('reviewed_transcript_revision', None)
            source['updated_at'] = datetime.now(timezone.utc).isoformat()
            try:
                store.save()
            except Exception:
                store.data.clear()
                store.data.update(before)
                raise HTTPException(500, '无法保存校对状态，请检查磁盘空间后重试。') from None
            return _document_locked(store, job_id)[0]
