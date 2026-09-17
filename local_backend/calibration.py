"""Re-recognize a video's original dialogue with precise word timestamps."""
from dataclasses import replace
from datetime import datetime, timezone
import copy
import json
from pathlib import Path
from typing import Literal
import uuid

from fastapi import BackgroundTasks, HTTPException
from pydantic import BaseModel, Field
from .projects import _transcript, _transcript_quality, _validate_cues
from .lifecycle import require_video


class CalibrationRequest(BaseModel):
    language: Literal['auto', 'en-US', 'zh-CN'] = 'auto'
    revision: int = Field(ge=0, strict=True)


def _now():
    return datetime.now(timezone.utc).isoformat()


def calibrate_audio(input_path, output_dir, settings):
    from .pipeline import _run, probe_media
    from .transcription import CUE_FORMAT_VERSION, transcribe_audio, transcript_cues
    media = probe_media(input_path, settings)
    if not media['has_audio']:
        return {'text': '', 'words': [], 'phrases': [], 'cues': [], 'language': settings.dialogue_language,
                'timing_source': 'no_audio_track'}
    output_dir.mkdir(parents=True, exist_ok=True)
    audio = output_dir / 'dialogue.wav'
    _run([settings.ffmpeg_bin, '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
          '-i', str(input_path), '-map', '0:a:0', '-vn', '-ac', '1',
          '-af', 'aresample=16000:async=1:first_pts=0,apad', '-ar', '16000',
          '-t', str(media['duration']), '-c:a', 'pcm_s16le', str(audio)], '字幕校准音频提取')
    transcript = transcribe_audio(audio, settings)
    transcript['cues'] = transcript_cues(transcript)
    transcript['cue_format_version'] = CUE_FORMAT_VERSION
    return transcript


def register_calibration_routes(app, store, settings):
    with store.lock:
        tasks = store.data.setdefault('calibrations', {})
        for task in tasks.values():
            if task['status'] == 'RUNNING':
                task.update(status='FAILED', error='服务重启中断了字幕校准，请重新发起。')
        store.save()

    def run(task_id, job_id, language, expected_revision):
        try:
            with store.lock:
                job = copy.deepcopy(store.data['executions'][job_id])
                duration = store.data['inputs'][job['video_id']]['duration']
            task_dir = store.root / 'calibrations' / task_id
            transcript = calibrate_audio(store.root / 'input' / (job['video_id'] + '.mp4'),
                                         task_dir, replace(settings, dialogue_language=language))
            if job['result'].get('insertions'):
                from .extended import shift_transcript
                transcript = shift_transcript(transcript, job['result']['insertions'])
            duration = job['result'].get('summary', {}).get('video_duration') or duration
            cues = _validate_cues(transcript['cues'], duration)
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / 'transcript.json').write_text(json.dumps(transcript, ensure_ascii=False, indent=2))
            with store.lock:
                current = _transcript(store, job_id)
                if current['revision'] != expected_revision:
                    raise ValueError('校准期间字幕已被修改，已保留现有字幕；请重新校准。')
                draft = {'cues': cues, 'revision': expected_revision + 1,
                         'language': transcript.get('language', language), 'dialogue_language': language}
                if _transcript_quality(transcript):
                    draft['quality'] = _transcript_quality(transcript)
                directory = (store.root / 'runs' / job_id).resolve()
                target = directory / 'transcript-edits.json'
                if not target.resolve().is_relative_to(directory):
                    raise ValueError('字幕文件路径无效。')
                temporary = directory / ('calibration-' + task_id + '.tmp')
                temporary.write_text(json.dumps(draft, ensure_ascii=False, indent=2))
                temporary.replace(target)
                store.data['executions'][job_id].update(reviewed=False, reviewed_at=None,
                                                       reviewed_transcript_revision=None,
                                                       transcript_revision=draft['revision'])
                store.data['inputs'][job['video_id']]['updated_at'] = _now()
                store.data['calibrations'][task_id].update(status='SUCCEEDED', result=draft, stop_date=_now())
                store.save()
        except Exception as exc:
            with store.lock:
                message = exc.detail if isinstance(exc, HTTPException) else str(exc)
                store.data['calibrations'][task_id].update(status='FAILED', error=settings.redact(message), stop_date=_now())
                store.save()
        finally:
            store.busy.release()

    @app.post('/api/videos/{job_id}/transcript/calibrate')
    def start(job_id: str, payload: CalibrationRequest, background: BackgroundTasks):
        if not settings.azure_speech_key or not (settings.azure_speech_region or settings.azure_speech_endpoint):
            raise HTTPException(503, '请先配置 Azure Speech 服务。')
        with store.lock:
            current = _transcript(store, job_id)
            if current['revision'] != payload.revision:
                raise HTTPException(409, '字幕已在其他窗口更新，请刷新后再校准。')
            job = store.data['executions'][job_id]
            if store.data['inputs'][job['video_id']].get('archived'):
                raise HTTPException(409, '请先恢复归档项目。')
        if not store.busy.acquire(blocking=False):
            raise HTTPException(409, '当前有任务正在处理，请完成后再校准字幕。')
        task_id = uuid.uuid4().hex
        try:
            with store.lock:
                require_video(store.data, job['video_id'])
                store.data['calibrations'][task_id] = {
                    'calibration_id': task_id, 'job_id': job_id, 'language': payload.language,
                    'status': 'RUNNING', 'start_date': _now(), 'stop_date': None,
                    'error': None, 'result': None,
                }
                store.save()
            background.add_task(run, task_id, job_id, payload.language, payload.revision)
        except Exception as exc:
            with store.lock:
                store.data['calibrations'].pop(task_id, None)
            store.busy.release()
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(500, '无法保存校准任务，请检查磁盘空间。') from None
        return {'calibration_id': task_id, 'status': 'RUNNING'}

    @app.get('/api/transcript-calibrations/{task_id}')
    def status(task_id: str):
        with store.lock:
            task = store.data['calibrations'].get(task_id)
            if not task:
                raise HTTPException(404, '字幕校准任务不存在。')
            job = store.data['executions'].get(task.get('job_id'))
            if not job:
                raise HTTPException(404, '视频版本不存在。')
            require_video(store.data, job.get('video_id'))
            return copy.deepcopy(task)
