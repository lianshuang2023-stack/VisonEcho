"""Local video projects, transcript review, and portable subtitle exports."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import html
import json
import math
from pathlib import Path
import re
import subprocess
from threading import Lock
from typing import Literal
from urllib.parse import quote
import uuid

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from .lifecycle import require_video, require_collection, video_deleted, video_running


class ProjectUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str | None = Field(default=None, min_length=1, max_length=120)
    archived: StrictBool | None = None
    collection_id: str | None = Field(default=None, min_length=1, max_length=100, strict=True)


class ReviewUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reviewed: StrictBool
    transcript_revision: int | None = Field(default=None, ge=0, strict=True)


class TranscriptCue(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=80)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(gt=0, allow_inf_nan=False)
    text: str = Field(min_length=1, max_length=5000)


class TranscriptUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    cues: list[TranscriptCue] = Field(max_length=10000)
    revision: int = Field(ge=0, strict=True)
    language: Literal['auto', 'en-US', 'zh-CN'] | None = None
    dialogue_language: Literal['auto', 'en-US', 'zh-CN'] | None = None


def _now():
    return datetime.now(timezone.utc).isoformat()


def _safe_child(root: Path, *parts: str) -> Path:
    """Keep derived and indexed paths within the expected storage directory."""
    root = root.resolve()
    path = root.joinpath(*parts).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(404, 'Media file not found.')
    return path


def _job_directory(store, job_id: str) -> Path:
    if not re.fullmatch(r'[A-Za-z0-9_-]+', job_id):
        raise HTTPException(404, 'Result not found.')
    return _safe_child(store.root, 'runs', job_id)


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        raise HTTPException(409, 'The saved transcript cannot be read. Restore the local transcript file and retry.') from None


def _job_reviewed(job, transcript_revision=None):
    if not job or job.get('status') != 'SUCCEEDED' or not isinstance(job.get('result'), dict) or not job['result']:
        return False
    revision = job.get('transcript_revision', 0) if transcript_revision is None else transcript_revision
    return bool(job.get('reviewed') and job.get('reviewed_transcript_revision') == revision)


def _project_record(data, video_id: str, settings=None):
    source = data['inputs'].get(video_id)
    if source is None:
        raise HTTPException(404, 'Video project not found.')
    jobs = sorted((j for j in data['executions'].values() if j.get('video_id') == video_id),
                  key=lambda j: j.get('start_date', ''), reverse=True)
    latest = jobs[0] if jobs else None
    successful = next((j for j in jobs if j.get('status') == 'SUCCEEDED'), None)
    status = 'draft'
    if latest:
        status = {'RUNNING': 'processing', 'SUCCEEDED': 'ready'}.get(latest.get('status'), 'failed')
    reviewed = _job_reviewed(latest)
    workflow_status = ('exportable' if reviewed else 'review') if status == 'ready' else status
    latest_result = (latest or {}).get('result', {})
    summary = latest_result.get('summary', {})
    narration_available = (summary.get('passed_segments', 0) > 0) if 'total_segments' in summary else None
    narration_notice = None
    if narration_available is False:
        narration_notice = '仅生成字幕，尚无口述配音。可使用自动或扩展口述模式重新生成。'
        workflow_status = 'failed'
        reviewed = False
    failure = next((job for job in jobs if job.get('status') not in ('RUNNING', 'SUCCEEDED')), None)
    last_error = None
    if failure:
        # Some legacy indexes predate provider-error redaction. Only routes with
        # the current settings may expose their cause; other callers get a safe label.
        message = failure.get('cause') or failure.get('error') or '生成未完成，请查看原因后重试。'
        last_error = settings.redact(message) if settings is not None else '生成未完成，请查看原因后重试。'
    if narration_notice:
        last_error = narration_notice
    collection_id = source.get('collection_id', 'default')
    filename = source.get('filename') or f'{video_id}.mp4'
    created = source.get('created_at') or source.get('last_modified', '')
    updated = max([source.get('updated_at') or created] +
                  [j.get('stop_date') or j.get('start_date', '') for j in jobs])
    return {
        'video_id': video_id, 'title': source.get('title') or Path(filename).stem,
        'collection_id': collection_id,
        'collection_title': data.get('collections', {}).get(collection_id, {}).get('title', ''),
        'filename': filename, 'archived': bool(source.get('archived', False)),
        'duration': source.get('duration', 0), 'size_mb': source.get('size_mb', 0),
        'created_at': created, 'updated_at': updated, 'last_modified': updated,
        'status': status, 'workflow_status': workflow_status,
        'narration_available': narration_available, 'narration_notice': narration_notice,
        'narration_mode': latest_result.get('narration_mode', 'standard'),
        'reviewed': reviewed, 'last_error': last_error, 'execution_count': len(jobs),
        'latest_execution_id': latest.get('execution_arn') if latest else None,
        'latest_result_id': successful.get('execution_arn') if successful else None,
        'thumbnail_url': f'/api/projects/{quote(video_id, safe="")}/thumbnail',
    }


def _execution_record(job, settings):
    # Never serialize result paths or arbitrary provider payloads to the browser.
    fields = ('execution_arn', 'video_id', 'status', 'start_date', 'stop_date',
              'language', 'dialogue_language', 'voice', 'source_execution_id', 'min_silence_duration', 'kind', 'detect_characters')
    result = {field: job[field] for field in fields if field in job}
    result['error'] = settings.redact(job['error']) if job.get('error') else None
    result['cause'] = settings.redact(job['cause']) if job.get('cause') else None
    result['steps'] = [{key: step.get(key) for key in ('name', 'status', 'entered_at', 'exited_at')}
                       for step in job.get('steps', [])]
    return result


def _get_result(store, job_id):
    job = store.data['executions'].get(job_id)
    if not job:
        raise HTTPException(404, 'Result not found.')
    require_video(store.data, job.get('video_id'))
    if job.get('status') != 'SUCCEEDED' or not isinstance(job.get('result'), dict) or not job['result']:
        raise HTTPException(409, 'This video result is not ready for review.')
    return job, job['result'], _job_directory(store, job_id)


def _duration(store, job, result):
    source = store.data['inputs'].get(job.get('video_id'), {})
    raw = result.get('summary', {}).get('video_duration') or source.get('duration')
    try:
        duration = float(raw)
    except (TypeError, ValueError, OverflowError):
        duration = 0
    if not math.isfinite(duration) or duration <= 0:
        raise HTTPException(409, 'The video duration is unavailable; transcript timing cannot be checked.')
    return duration


def _validate_cues(cues, duration):
    normalized, ids = [], set()
    cursor = 0.0
    for cue in cues:
        item = cue.model_dump() if isinstance(cue, TranscriptCue) else dict(cue)
        try:
            start, end = float(item['start']), float(item['end'])
            cue_id = str(item['id']).strip()
            text = ' '.join(str(item['text']).split())
        except (KeyError, TypeError, ValueError, OverflowError):
            raise HTTPException(422, 'Every subtitle needs an ID, text, and valid start/end times.') from None
        if not cue_id or cue_id in ids:
            raise HTTPException(422, 'Subtitle IDs must be nonempty and unique.')
        if not text:
            raise HTTPException(422, 'Remove an empty subtitle row instead of saving blank text.')
        if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start < end <= duration:
            raise HTTPException(422, 'Subtitle times must be within the video duration, with end after start.')
        if start < cursor:
            raise HTTPException(422, 'Subtitles must be ordered by start time and must not overlap.')
        ids.add(cue_id)
        normalized.append({'id': cue_id, 'start': start, 'end': end, 'text': text})
        cursor = end
    return normalized


def _source_cues(payload):
    if (payload.get('timing_source') == 'azure_speech_continuous'
            and payload.get('phrases') and payload.get('words')):
        from .transcription import CUE_FORMAT_VERSION, transcript_cues
        if payload.get('cue_format_version') != CUE_FORMAT_VERSION:
            # Refresh machine formatting only. _transcript returns saved edits
            # before reaching this path, and no original file is rewritten.
            return transcript_cues(payload)
    if isinstance(payload.get('cues'), list):
        return payload['cues']
    phrases = payload.get('phrases') or []
    if phrases:
        return [{'id': f'cue-{index + 1}', 'start': p['start'], 'end': p['end'], 'text': p['text']}
                for index, p in enumerate(phrases) if str(p.get('text', '')).strip()]
    # Older normalized transcripts can contain word timing without phrases.
    cues, group = [], []
    def flush():
        if group:
            cues.append({'id': f'cue-{len(cues) + 1}', 'start': group[0]['start'],
                         'end': group[-1]['end'], 'text': ' '.join(str(w['text']) for w in group)})
            group.clear()
    for word in payload.get('words') or []:
        if not str(word.get('text', '')).strip():
            continue
        if group and (float(word['start']) - float(group[-1]['end']) >= 0.7 or
                      float(word['end']) - float(group[0]['start']) > 6 or len(group) >= 12):
            flush()
        group.append(word)
        if re.search(r'[.!?。！？]["\'”’]?$', str(word['text'])):
            flush()
    flush()
    return cues


def _transcript_quality(payload):
    quality = payload.get('quality') or {}
    if not isinstance(quality, dict):
        return {}
    # Only expose review signals, never arbitrary Speech provider payloads.
    signals = {key: quality[key] for key in ('review_required', 'low_confidence_phrase_count',
               'low_confidence_word_count', 'no_match_count') if isinstance(quality.get(key), (bool, int))}
    if 'review_required' not in signals and any(
            signals.get(key, 0) > 0 for key in ('low_confidence_phrase_count', 'low_confidence_word_count', 'no_match_count')):
        signals['review_required'] = True
    return signals


def _transcript(store, job_id):
    job, result, directory = _get_result(store, job_id)
    draft = _safe_child(directory, 'transcript-edits.json')
    if draft.is_file():
        saved = _read_json(draft)
        if not isinstance(saved, dict) or not isinstance(saved.get('cues'), list) or type(saved.get('revision')) is not int:
            raise HTTPException(409, 'The saved transcript has an invalid format.')
        return saved
    raw_path = result.get('transcript_path')
    if not raw_path:
        raise HTTPException(404, 'A dialogue transcript is not available for this result.')
    path = Path(raw_path).resolve()
    if not path.is_relative_to(directory) or not path.is_file():
        raise HTTPException(404, 'The dialogue transcript file is unavailable.')
    payload = _read_json(path)
    try:
        cues = _source_cues(payload)
    except (KeyError, TypeError, ValueError, AttributeError):
        raise HTTPException(409, 'The original transcript contains invalid timing data.') from None
    # Preserve original phrase boundaries for review; edited timelines are
    # checked strictly on save.
    transcript = {'cues': cues, 'revision': 0}
    if payload.get('language') in ('auto', 'en-US', 'zh-CN'):
        transcript['language'] = payload['language']
    if result.get('dialogue_language') in ('auto', 'en-US', 'zh-CN'):
        transcript['dialogue_language'] = result['dialogue_language']
    if _transcript_quality(payload):
        transcript['quality'] = _transcript_quality(payload)
    return transcript


def _review_state(store, job_id):
    """Return review metadata for the saved subtitles; caller holds store.lock."""
    job, _, _ = _get_result(store, job_id)
    try:
        revision = _transcript(store, job_id)['revision']
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        revision = 0
    reviewed = _job_reviewed(job, revision)
    return {'reviewed': reviewed, 'reviewed_at': job.get('reviewed_at') if reviewed else None,
            'transcript_revision': revision}


def _subtitle_time(seconds, separator):
    milliseconds = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02}{separator}{milliseconds:03}'


def _export_text(cues, format):
    lines = ['WEBVTT', ''] if format == 'vtt' else []
    for index, cue in enumerate(cues, 1):
        separator = ',' if format == 'srt' else '.'
        times = f'{_subtitle_time(cue["start"], separator)} --> {_subtitle_time(cue["end"], separator)}'
        text = ' '.join(str(cue['text']).split())
        if format == 'srt':
            lines.extend([str(index), times, html.escape(text, quote=False), ''])
        elif format == 'vtt':
            lines.extend([times, html.escape(text, quote=False), ''])
        else:
            lines.extend([times, text, ''])
    return '\n'.join(lines) + ('\n' if lines else '')


def register_project_routes(app, store, settings):
    thumbnail_lock = Lock()

    @app.get('/api/projects')
    def projects(search: str = '', status: Literal['all', 'draft', 'processing', 'ready', 'failed', 'archived'] = 'all', collection_id: str | None = None):
        with store.lock:
            if collection_id is not None:
                require_collection(store.data, collection_id)
            rows = [_project_record(store.data, video_id, settings) for video_id, source in store.data['inputs'].items()
                    if not video_deleted(store.data, video_id) and
                    (collection_id is None or source.get('collection_id', 'default') == collection_id)]
        search = search.casefold().strip()
        rows = [row for row in rows if row['archived'] == (status == 'archived') and
                (status in ('all', 'archived') or row['status'] == status) and
                (not search or search in row['title'].casefold() or search in row['filename'].casefold() or
                 search in row['collection_title'].casefold())]
        return {'projects': sorted(rows, key=lambda row: row['updated_at'], reverse=True)}

    @app.get('/api/projects/{video_id}')
    def project(video_id: str):
        with store.lock:
            require_video(store.data, video_id)
            record = _project_record(store.data, video_id, settings)
            jobs = sorted((j for j in store.data['executions'].values() if j.get('video_id') == video_id),
                          key=lambda j: j.get('start_date', ''), reverse=True)
            executions = [_execution_record(job, settings) for job in jobs]
        return {'project': record, 'executions': executions, 'latest_result_id': record['latest_result_id']}

    @app.patch('/api/projects/{video_id}')
    def update_project(video_id: str, payload: ProjectUpdate):
        if not payload.model_fields_set or any(getattr(payload, key) is None for key in payload.model_fields_set):
            raise HTTPException(422, 'Supply a video title, project, or an archived flag.')
        title = ' '.join(payload.title.split()) if payload.title is not None else None
        if title is not None and not title:
            raise HTTPException(422, 'The project title cannot be blank.')
        with store.lock:
            source = require_video(store.data, video_id)
            previous_collection_id = source.get('collection_id', 'default')
            if payload.collection_id is not None:
                require_collection(store.data, previous_collection_id)
                require_collection(store.data, payload.collection_id)
                if payload.collection_id != previous_collection_id and video_running(store.data, video_id):
                    raise HTTPException(409, '视频正在生成或校准字幕，请完成后再移动。')
            before = copy.deepcopy(store.data)
            if title is not None:
                source['title'] = title
            if payload.archived is not None:
                source['archived'] = payload.archived
            if payload.collection_id is not None:
                source['collection_id'] = payload.collection_id
            updated_at = _now()
            source['updated_at'] = updated_at
            for collection_id in {previous_collection_id, source.get('collection_id', 'default')}:
                collection = store.data.get('collections', {}).get(collection_id)
                if collection is not None:
                    collection['updated_at'] = updated_at
            try:
                store.save()
            except Exception:
                store.data.clear()
                store.data.update(before)
                raise HTTPException(500, 'Cannot save the project. Check local disk space and retry.') from None
            return _project_record(store.data, video_id, settings)

    @app.get('/api/projects/{video_id}/thumbnail')
    def thumbnail(video_id: str):
        with store.lock:
            require_video(store.data, video_id)
            record = _project_record(store.data, video_id)
        if not re.fullmatch(r'[A-Za-z0-9_-]+', video_id):
            raise HTTPException(404, 'Video preview not found.')
        source = _safe_child(store.root, 'input', f'{video_id}.mp4')
        directory = _safe_child(store.root, 'thumbnails')
        path = _safe_child(directory, f'{video_id}.jpg')
        if not source.is_file():
            raise HTTPException(404, 'The source video is unavailable.')
        with thumbnail_lock:
            if not path.is_file() or path.stat().st_mtime_ns < source.stat().st_mtime_ns:
                directory.mkdir(exist_ok=True)
                temporary = directory / f'{video_id}-{uuid.uuid4().hex}.jpg'
                try:
                    offset = min(1.0, max(0.0, float(record['duration']) / 4))
                    subprocess.run([settings.ffmpeg_bin, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                                    '-ss', str(offset), '-protocol_whitelist', 'file,pipe', '-i', str(source),
                                    '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', str(temporary)],
                                   check=True, capture_output=True, timeout=30)
                    if not temporary.is_file() or not temporary.stat().st_size:
                        raise OSError('Thumbnail was not generated.')
                    temporary.replace(path)
                except (OSError, subprocess.SubprocessError, ValueError):
                    raise HTTPException(422, 'A thumbnail could not be created for this video.') from None
                finally:
                    temporary.unlink(missing_ok=True)
        return FileResponse(path, media_type='image/jpeg', headers={'Cache-Control': 'private, max-age=3600'})

    @app.delete('/api/projects/{video_id}')
    def delete_video(video_id: str):
        with store.lock:
            source = store.data['inputs'].get(video_id)
            if not source:
                raise HTTPException(404, '视频不存在。')
            if source.get('deleted'):
                return {'video_id': video_id, 'deleted': True}
            require_video(store.data, video_id)
            if video_running(store.data, video_id):
                raise HTTPException(409, '视频正在处理或校准，请完成后再删除。')
            previous = copy.deepcopy(source)
            source.update(deleted=True, deleted_at=_now(), updated_at=_now())
            try:
                store.save()
            except OSError:
                store.data['inputs'][video_id] = previous
                raise HTTPException(500, '无法删除视频，请检查磁盘空间后重试。') from None
            return {'video_id': video_id, 'deleted': True}

    @app.get('/api/videos/{job_id}/transcript')
    def transcript(job_id: str, source: bool = False):
        with store.lock:
            saved = _transcript(store, job_id)
            if source:
                _, result, _ = _get_result(store, job_id)
                from .timeline import cues_to_source
                return {**saved, 'cues': cues_to_source(saved['cues'], result.get('insertions', []))}
            return saved

    @app.post('/api/videos/{job_id}/review')
    def review(job_id: str, payload: ReviewUpdate):
        with store.lock:
            job, _, _ = _get_result(store, job_id)
            summary = job['result'].get('summary', {})
            if payload.reviewed and 'total_segments' in summary and not summary.get('passed_segments'):
                raise HTTPException(409, '本版本没有口述配音，请重新生成后再确认校对。')
            if video_running(store.data, job['video_id']):
                raise HTTPException(409, '视频正在生成或校准字幕，请完成后再确认校对。')
            state = _review_state(store, job_id)
            if payload.reviewed:
                if payload.transcript_revision is None:
                    raise HTTPException(422, '确认校对时请提交当前字幕版本。')
                if payload.transcript_revision != state['transcript_revision']:
                    raise HTTPException(409, '字幕已在其他窗口更新，请重新检查后确认校对。')
            before = copy.deepcopy(store.data)
            updated_at = _now()
            job.update(reviewed=payload.reviewed, transcript_revision=state['transcript_revision'])
            if payload.reviewed:
                job.update(reviewed_at=updated_at, reviewed_transcript_revision=state['transcript_revision'])
            else:
                job.pop('reviewed_at', None)
                job.pop('reviewed_transcript_revision', None)
            source = store.data['inputs'][job['video_id']]
            source['updated_at'] = updated_at
            try:
                store.save()
            except Exception:
                store.data.clear()
                store.data.update(before)
                raise HTTPException(500, '无法保存校对状态，请检查本地磁盘空间后重试。') from None
            return {'reviewed': payload.reviewed, 'reviewed_at': job.get('reviewed_at'),
                    'transcript_revision': state['transcript_revision']}

    @app.put('/api/videos/{job_id}/transcript')
    def save_transcript(job_id: str, payload: TranscriptUpdate):
        with store.lock:
            current = _transcript(store, job_id)
            if payload.revision != current['revision']:
                raise HTTPException(409, 'This transcript changed in another window. Reload it before saving.')
            job, result, directory = _get_result(store, job_id)
            cues = _validate_cues(payload.cues, _duration(store, job, result)) if payload.cues else []
            saved = {'cues': cues, 'revision': current['revision'] + 1}
            # Text edits must not change recognition language metadata.
            for key in ('language', 'dialogue_language', 'quality'):
                if key in current:
                    saved[key] = current[key]
            draft = _safe_child(directory, 'transcript-edits.json')
            temporary = _safe_child(directory, 'transcript-edits.json.tmp')
            before = copy.deepcopy(store.data)
            index_saved = False
            try:
                temporary.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding='utf-8')
                job.update(reviewed=False, transcript_revision=saved['revision'])
                job.pop('reviewed_at', None)
                job.pop('reviewed_transcript_revision', None)
                store.data['inputs'][job['video_id']]['updated_at'] = _now()
                # Commit invalidation first, so an interrupted two-file save can
                # never leave newly edited subtitles marked as already reviewed.
                store.save()
                index_saved = True
                temporary.replace(draft)
            except Exception:
                store.data.clear()
                store.data.update(before)
                if index_saved:
                    try:
                        store.save()
                    except Exception:
                        # The saved index already clears review. Keep memory
                        # conservative too if restoring it also fails.
                        store.data['executions'][job_id]['reviewed'] = False
                raise HTTPException(500, 'Cannot save the transcript. Check local disk space and retry.') from None
            finally:
                temporary.unlink(missing_ok=True)
            return saved

    @app.get('/api/videos/{job_id}/export')
    def export(job_id: str, kind: Literal['dialogue', 'description'] = 'dialogue',
               format: Literal['srt', 'vtt', 'txt'] = 'srt'):
        with store.lock:
            job, result, _ = _get_result(store, job_id)
            if kind == 'dialogue':
                cues = _transcript(store, job_id)['cues']
            else:
                cues = [{'id': str(s.get('segment_index', index)), 'start': s['start_time'],
                         'end': s.get('end_time', s['start_time'] + s['silence_duration']), 'text': s['dvi_text']}
                        for index, s in enumerate(result.get('segments', [])) if s.get('pass') and str(s.get('dvi_text', '')).strip()]
                cues.sort(key=lambda cue: cue['start'])
            filename = store.data['inputs'].get(job.get('video_id'), {}).get('filename', 'video.mp4')
        stem = Path(filename).stem
        filename = f'{stem}-{kind}.{format}'
        ascii_name = re.sub(r'[^a-zA-Z0-9._-]', '-', filename)
        mime = 'text/vtt' if format == 'vtt' else ('application/x-subrip' if format == 'srt' else 'text/plain')
        return Response(_export_text(cues, format), media_type=mime,
                        headers={'Content-Disposition': f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'} )
