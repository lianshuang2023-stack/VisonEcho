"""Version-scoped visual references and human correction notes.

Saved model frames are references, not an independent factual verification. Old
versions without those assets receive explicitly labelled local review frames.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from threading import Lock
from typing import Literal

from fastapi import HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from .lifecycle import require_video, video_running

_cache_lock = Lock()
_SAFE_ID = re.compile(r'[A-Za-z0-9_-]{1,120}\Z')
_ISSUES = ('wrong_person', 'wrong_action', 'missing_content')


class EvidenceFeedbackUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    revision: int = Field(ge=0)
    issues: list[Literal['wrong_person', 'wrong_action', 'missing_content']] = Field(max_length=3)
    note: str = Field(default='', max_length=2000)


def _safe_path(root: Path, *parts: str) -> Path:
    """Only fixed children of our data root; reject symlinked assets too."""
    root = root.resolve()
    path = root
    for part in parts:
        if not part or part in ('.', '..') or Path(part).name != part or '\\' in part:
            raise HTTPException(409, 'The visual reference path is invalid.')
        path = path / part
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise HTTPException(409, 'The visual reference path is outside its video version.')
    return path


def _run_dir(store, job_id: str) -> Path:
    if not _SAFE_ID.fullmatch(job_id):
        raise HTTPException(404, 'Video version not found.')
    return _safe_path(store.root, 'runs', job_id)


def _segment(job: dict, index: int) -> dict:
    matches = [segment for segment in job.get('result', {}).get('segments', [])
               if isinstance(segment, dict) and segment.get('segment_index') == index]
    if len(matches) != 1 or index < 0:
        raise HTTPException(404, 'Narration segment not found.')
    return matches[0]


def _job(store, job_id: str, index: int | None = None):
    if not isinstance(job_id, str) or not _SAFE_ID.fullmatch(job_id):
        raise HTTPException(404, 'Video version not found.')
    job = store.data.get('executions', {}).get(job_id)
    if (not job or job.get('status') != 'SUCCEEDED' or not job.get('result')
            or job.get('deleted') or job.get('deleted_at')):
        raise HTTPException(404, 'Completed video version not found.')
    source = require_video(store.data, job.get('video_id'))
    if index is not None:
        _segment(job, index)
    return job, source


def _source_bounds(segment: dict, source: dict, result: dict) -> tuple[float, float]:
    try:
        # Output times include inserted narration in extended exports.
        if result.get('narration_mode') == 'extended':
            start, end = float(segment['source_start']), float(segment['source_end'])
        else:
            start = float(segment.get('source_start', segment['start_time']))
            end = float(segment.get('source_end', segment['end_time']))
        duration = float(source.get('duration') or result.get('summary', {}).get('source_video_duration')
                         or result.get('summary', {}).get('video_duration') or end)
        if not all(math.isfinite(value) for value in (start, end, duration)) or not 0 <= start < end <= duration + .002:
            raise ValueError
        return start, end
    except (KeyError, TypeError, ValueError):
        raise HTTPException(409, 'Original-video timing is missing for this segment.') from None


def _feedback(job: dict, index: int) -> dict:
    saved = job.get('evidence_feedback', {}).get(str(index))
    if saved is None:
        return {'revision': 0, 'issues': [], 'note': ''}
    try:
        return EvidenceFeedbackUpdate.model_validate(saved).model_dump()
    except ValueError:
        raise HTTPException(409, 'Saved correction notes are invalid.') from None


def _snapshots(store, job_id: str, index: int):
    with store.lock:
        job, source = _job(store, job_id, index)
        current, source = deepcopy(job), deepcopy(source)
        chain, visited, candidate_id = [], set(), job_id
        while (isinstance(candidate_id, str) and _SAFE_ID.fullmatch(candidate_id)
               and candidate_id not in visited and len(visited) < 100):
            visited.add(candidate_id)
            candidate = store.data.get('executions', {}).get(candidate_id)
            if (not candidate or candidate.get('video_id') != current['video_id']
                    or candidate.get('status') != 'SUCCEEDED' or candidate.get('deleted') or candidate.get('deleted_at')):
                break
            chain.append((candidate_id, deepcopy(candidate)))
            candidate_id = candidate.get('source_execution_id') or candidate.get('result', {}).get('source_execution_id')
        return current, source, chain


def _saved_frames(store, chain, index, source, bounds):
    for owner_id, owner in chain:
        try:
            segment = _segment(owner, index)
            owner_bounds = _source_bounds(segment, source, owner['result'])
            if any(abs(left - right) > .002 for left, right in zip(bounds, owner_bounds)):
                continue
            timestamps = segment.get('frame_timestamps')
            if not isinstance(timestamps, list) or not 1 <= len(timestamps) <= 24:
                continue
            directory = _run_dir(store, owner_id)
            frames = []
            for ordinal, timestamp in enumerate(timestamps):
                if (type(timestamp) not in (int, float) or not math.isfinite(timestamp)
                        or not bounds[0] - .002 <= timestamp <= bounds[1] + .002):
                    raise ValueError
                path = _safe_path(directory, 'frames', f'segment-{index:03d}-{ordinal}.jpg')
                if not path.is_file() or not path.stat().st_size:
                    raise ValueError
                frames.append({'id': f'f{ordinal}', 'timestamp': timestamp, 'path': path})
            return frames, segment
        except (ValueError, OSError):
            continue
        except HTTPException as exc:
            if exc.status_code == 404:
                continue
            raise
    return None, None


def _read_review_cache(directory: Path, bounds) -> list[dict] | None:
    manifest = _safe_path(directory, 'manifest.json')
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text(encoding='utf-8'))
        if data.get('source_bounds') != list(bounds) or not 1 <= len(data['frames']) <= 24:
            return None
        frames = []
        for ordinal, frame in enumerate(data['frames']):
            timestamp = frame['timestamp']
            if (type(timestamp) not in (int, float) or not math.isfinite(timestamp)
                    or not bounds[0] - .002 <= timestamp <= bounds[1] + .002):
                return None
            # Never consume a path from a cache manifest.
            path = _safe_path(directory, f'frame-{ordinal}.jpg')
            if not path.is_file() or not path.stat().st_size:
                return None
            frames.append({'id': f'r{ordinal}', 'timestamp': timestamp, 'path': path})
        return frames
    except (OSError, ValueError, TypeError, KeyError):
        return None


def _review_frames(store, job_id, video_id, index, bounds, settings):
    from .pipeline import PipelineError, _extract_frames

    if not _SAFE_ID.fullmatch(video_id):
        raise HTTPException(409, 'The source video reference is invalid.')
    directory = _safe_path(_run_dir(store, job_id), 'evidence-review', f'segment-{index:03d}')
    with _cache_lock:
        cached = _read_review_cache(directory, bounds)
        if cached:
            return cached
        input_path = _safe_path(store.root, 'input', f'{video_id}.mp4')
        if not input_path.is_file():
            raise HTTPException(409, 'The original video is missing; review frames cannot be generated.')
        directory.mkdir(parents=True, exist_ok=True)
        try:
            # Extraction is local only. A manifest is published last, so partial
            # thumbnails from an interrupted process never count as a cache.
            with TemporaryDirectory(prefix='extract-', dir=directory) as temporary:
                extracted = _extract_frames(input_path, Path(temporary),
                    {'start_time': bounds[0], 'silence_duration': bounds[1] - bounds[0]}, index, settings)
                if not extracted or len(extracted) > 24:
                    raise ValueError('Invalid review frames')
                manifest = {'source_bounds': list(bounds), 'frames': []}
                for ordinal, frame in enumerate(extracted):
                    path = Path(frame['path']).resolve()
                    if not path.is_relative_to(Path(temporary).resolve()) or not path.is_file():
                        raise ValueError('Invalid extracted path')
                    target = _safe_path(directory, f'frame-{ordinal}.jpg')
                    path.replace(target)
                    manifest['frames'].append({'timestamp': round(frame['timestamp'], 3)})
                pending = _safe_path(directory, 'manifest.json.tmp')
                pending.write_text(json.dumps(manifest), encoding='utf-8')
                pending.replace(_safe_path(directory, 'manifest.json'))
            cached = _read_review_cache(directory, bounds)
            if not cached:
                raise ValueError('Invalid review-frame timestamps')
            return cached
        except (OSError, ValueError, PipelineError):
            raise HTTPException(503, 'Cannot prepare local review frames. Check the original video and FFmpeg, then retry.') from None


def _observations(segment: dict, frames: list[dict]) -> list[dict]:
    observations = []
    source = segment.get('visual_evidence', [])
    if not isinstance(source, list):
        return []
    for item in source[:24]:
        if not isinstance(item, dict) or not isinstance(item.get('fact'), str) or not item['fact'].strip():
            continue
        timestamps = item.get('frame_timestamps')
        if not isinstance(timestamps, list) or not timestamps:
            continue
        ids = []
        for timestamp in timestamps:
            if type(timestamp) not in (int, float) or not math.isfinite(timestamp):
                break
            matching = [frame['id'] for frame in frames if abs(frame['timestamp'] - timestamp) < .002]
            if not matching:
                break
            ids.extend(matching)
        else:
            observations.append({'fact': item['fact'][:2000], 'frame_ids': list(dict.fromkeys(ids))})
    return observations


def _resolve_evidence(store, job_id, index, settings):
    current, source, chain = _snapshots(store, job_id, index)
    segment = _segment(current, index)
    bounds = _source_bounds(segment, source, current['result'])
    frames, owner_segment = _saved_frames(store, chain, index, source, bounds)
    provenance = 'model'
    observations = []
    if frames:
        evidence_text = owner_segment.get('evidence_description', owner_segment.get('evidence_text', owner_segment.get('dvi_text', '')))
        # A revoice can reuse original facts. An edited text cannot inherit a
        # claim that the previous model checked that new wording.
        if ' '.join(str(evidence_text).split()) == ' '.join(str(segment.get('dvi_text', '')).split()):
            observations = _observations(owner_segment, frames)
        else:
            provenance = 'review'
    else:
        provenance = 'review'
        frames = _review_frames(store, job_id, current['video_id'], index, bounds, settings)
    with store.lock:
        # The original may have been trashed while a local thumbnail was made.
        latest, _ = _job(store, job_id, index)
        feedback = _feedback(latest, index)
        from .projects import _transcript
        from .timeline import cues_to_source
        try:
            transcript = _transcript(store, job_id)
            source_cues = cues_to_source(transcript['cues'], current['result'].get('insertions', []))
        except HTTPException:
            source_cues = []
        nearby_dialogue = [{'start': cue['start'], 'end': cue['end'], 'text': str(cue['text'])[:2000]}
                           for cue in source_cues if cue['end'] >= max(0, bounds[0] - 6)
                           and cue['end'] <= bounds[1]][-8:]
    document = {'segment_index': index, 'source_start': bounds[0], 'source_end': bounds[1],
                'provenance': provenance, 'frames': [
                    {'id': frame['id'], 'timestamp': frame['timestamp'],
                     'url': f'/api/videos/{job_id}/segments/{index}/frames/{frame["id"]}'}
                    for frame in frames], 'observations': observations, 'feedback': feedback}
    document.update(
        generation_reason='visual_context' if provenance == 'model' else 'review_reference',
        window_reason='extended_pause' if current['result'].get('narration_mode') == 'extended' else 'dialogue_gap',
        nearby_dialogue=nearby_dialogue)
    return document, {frame['id']: frame['path'] for frame in frames}


def get_evidence_document(store, job_id: str, segment_index: int, settings) -> dict:
    """Public evidence contract, also used to validate character frame links.

    Acquires store.lock internally; callers must not already hold that lock.
    """
    return _resolve_evidence(store, job_id, segment_index, settings)[0]


def register_evidence_routes(app, store, settings):
    @app.get('/api/videos/{job_id}/segments/{segment_index}/evidence')
    def evidence(job_id: str, segment_index: int):
        return get_evidence_document(store, job_id, segment_index, settings)

    @app.get('/api/videos/{job_id}/segments/{segment_index}/frames/{frame_id}')
    def evidence_frame(job_id: str, segment_index: int, frame_id: str):
        if not re.fullmatch(r'[fr]\d{1,2}', frame_id):
            raise HTTPException(404, 'Visual reference not found.')
        _, paths = _resolve_evidence(store, job_id, segment_index, settings)
        path = paths.get(frame_id)
        if path is None:
            raise HTTPException(404, 'Visual reference not found.')
        return FileResponse(path, media_type='image/jpeg', headers={'Cache-Control': 'private, no-cache'})

    @app.put('/api/videos/{job_id}/segments/{segment_index}/feedback')
    def save_feedback(job_id: str, segment_index: int, payload: EvidenceFeedbackUpdate):
        with store.lock:
            job, source = _job(store, job_id, segment_index)
            if source.get('archived'):
                raise HTTPException(409, 'Restore the archived video before saving corrections.')
            busy = getattr(store, 'busy', None)
            if ((busy is not None and busy.locked()) or video_running(store.data, job['video_id'])
                    or any(task.get('status') == 'RUNNING' and task.get('video_id') == job['video_id']
                           for task in store.data.get('calibrations', {}).values())):
                raise HTTPException(409, 'Wait for generation or subtitle calibration before saving corrections.')
            current = _feedback(job, segment_index)
            if payload.revision != current['revision']:
                raise HTTPException(409, 'These correction notes changed in another window. Reload before saving.')
            before = deepcopy(store.data)
            saved = {'revision': current['revision'] + 1,
                     'issues': [issue for issue in _ISSUES if issue in payload.issues], 'note': payload.note.strip()}
            job.setdefault('evidence_feedback', {})[str(segment_index)] = saved
            job['reviewed'] = False
            job.pop('reviewed_at', None)
            job.pop('reviewed_transcript_revision', None)
            source['updated_at'] = datetime.now(timezone.utc).isoformat()
            try:
                store.save()
            except Exception:
                store.data.clear()
                store.data.update(before)
                raise HTTPException(500, 'Cannot save correction notes. Check local disk space and retry.') from None
            return saved
