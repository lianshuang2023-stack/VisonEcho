"""Loopback-only API adapter for the dashboard and Azure pipeline."""
from datetime import datetime, timezone
from dataclasses import replace
from typing import Literal
from pathlib import Path
from threading import Lock
import copy
import json
import re
import secrets
import subprocess
import uuid

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .config import Settings, LANGUAGES, validate_voice
from .lifecycle import require_collection, require_video, video_deleted

STEPS = ['ValidateInput', 'TranscribeVideo', 'SilenceDetection',
         'AnalyzeSilenceSegments', 'GenerateDVI', 'SynthesizeAudio',
         'MixAudioTracks', 'RecordSummary']

def now():
    return datetime.now(timezone.utc).isoformat()

class UploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=240)
    collection_id: str = Field(default='default', min_length=1, max_length=100)

class ExecutionRequest(BaseModel):
    video_id: str
    language: Literal["en-US", "zh-CN"] | None = None
    dialogue_language: Literal["auto", "en-US", "zh-CN"] | None = None
    voice: str | None = None
    narration_mode: Literal['auto', 'standard', 'extended'] = 'auto'

class Store:
    def __init__(self, settings):
        self.settings = settings
        self.root = settings.data_dir
        self.root.mkdir(parents=True, exist_ok=True)
        self.root.chmod(0o700)
        (self.root / 'input').mkdir(exist_ok=True)
        (self.root / 'runs').mkdir(exist_ok=True)
        self.lock = Lock()
        self.busy = Lock()
        self.pending = {}
        self.active_uploads = {}
        index = self.root / 'index.json'
        self.data = json.loads(index.read_text()) if index.exists() else {
            'inputs': {}, 'executions': {}, 'outputs': {},
        }
        for job in self.data['executions'].values():
            if job['status'] == 'RUNNING':
                job.update(status='ABORTED', stop_date=now(), cause='Local server restarted during processing. Start a new run.')
        self.save()

    def save(self):
        temporary = self.root / 'index.json.tmp'
        temporary.write_text(json.dumps(self.data, indent=2))
        temporary.replace(self.root / 'index.json')

    def snapshot(self, key):
        with self.lock:
            return copy.deepcopy(self.data[key])

def process_video(*args, **kwargs):
    from .pipeline import process_video as run
    return run(*args, **kwargs)

def validate_upload(path, settings):
    try:
        result = subprocess.run(
            [settings.ffprobe_bin, '-v', 'error', '-protocol_whitelist', 'file,pipe',
             '-show_format', '-show_streams', '-of', 'json', str(path)],
            check=True, capture_output=True, text=True, timeout=30,
        )
        metadata = json.loads(result.stdout)
        streams = metadata.get('streams', [])
        duration = float(metadata.get('format', {}).get('duration', 0))
        if not any(s.get('codec_type') == 'video' for s in streams):
            raise ValueError('The file has no video stream.')
        if not 0 < duration <= settings.max_video_seconds:
            raise ValueError(f'Video duration must be between 0 and {settings.max_video_seconds:g} seconds.')
        return duration
    except (subprocess.SubprocessError, ValueError, OSError) as exc:
        if isinstance(exc, ValueError):
            raise HTTPException(400, str(exc)) from None
        raise HTTPException(400, 'Cannot read this MP4. Check the file and FFmpeg installation.') from None

def run_job(store, job_id, video_id, min_gap, source_result=None, edits=None):
    with store.lock:
        job_config = copy.deepcopy(store.data['executions'][job_id])
    settings = replace(store.settings,
                       speech_language=job_config.get('language', store.settings.speech_language),
                       dialogue_language=job_config.get('dialogue_language', store.settings.dialogue_language),
                       azure_speech_voice=job_config.get('voice', store.settings.azure_speech_voice),
                       narration_mode=job_config.get('narration_mode', 'auto'))
    def update_step(name, status, detail):
        with store.lock:
            job = store.data['executions'][job_id]
            step = next((s for s in job['steps'] if s['name'] == name), None)
            if step is None:
                step = {'name': name, 'status': 'pending', 'entered_at': None, 'exited_at': None}
                job['steps'].append(step)
            step['status'] = status.lower()
            step['detail'] = {k: v for k, v in detail.items() if k in ('completed_segments', 'num_segments', 'frame_count') and isinstance(v, (int, float))}
            step['entered_at'] = step['entered_at'] or now()
            if status.upper() in ('SUCCEEDED', 'FAILED'):
                step['exited_at'] = now()
            store.save()
    try:
        if source_result is None:
            result = process_video(store.root / 'input' / f'{video_id}.mp4',
                                   store.root / 'runs' / job_id, settings, min_gap, update_step)
        else:
            from .revision import render_revision
            result = render_revision(store.root / 'input' / f'{video_id}.mp4',
                                     store.root / 'runs' / job_id, settings, source_result, edits, update_step)
        result.update(language=settings.speech_language, dialogue_language=settings.dialogue_language,
                      voice=settings.azure_speech_voice)
        if job_config.get('source_execution_id'):
            result['source_execution_id'] = job_config['source_execution_id']
        path = Path(result['output_path']).resolve()
        if not path.is_relative_to((store.root / 'runs' / job_id).resolve()) or not path.is_file():
            raise RuntimeError('Processing finished without a readable output video.')
        result['output_path'] = str(path)
        (store.root / 'runs' / job_id / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        with store.lock:
            job = store.data['executions'][job_id]
            job.update(status='SUCCEEDED', stop_date=now(), result=result)
            source = store.data['inputs'][video_id]
            store.data['outputs'][job_id] = {
                'key': job_id, 'video_id': job_id,
                'filename': Path(source['filename']).stem + '-described.mp4',
                'pipeline_version': 'azure-local', 'last_modified': now(),
                'size_bytes': path.stat().st_size,
            }
            store.save()
    except Exception as exc:
        with store.lock:
            job = store.data['executions'][job_id]
            job.update(status='FAILED', stop_date=now(), error=type(exc).__name__, cause=settings.redact(exc))
            for step in job['steps']:
                if step['status'] == 'running':
                    step.update(status='failed', exited_at=now())
            store.save()
    finally:
        store.busy.release()

def enqueue_job(store, background, video_id, min_gap=2, language=None, source_result=None, edits=None, source_execution_id=None, voice=None, narration_mode='auto', dialogue_language=None):
    language = language or store.settings.speech_language
    dialogue_language = dialogue_language or (source_result or {}).get('dialogue_language') or store.settings.dialogue_language
    if dialogue_language not in ('auto', 'en-US', 'zh-CN'):
        raise HTTPException(400, '请选择自动识别、中文或英文对白。')
    try:
        voice = validate_voice(language, voice if voice is not None else (source_result or {}).get('voice'))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    if not store.busy.acquire(blocking=False):
        raise HTTPException(409, 'A video is already processing. Wait for it to finish.')
    job_id, started = uuid.uuid4().hex, now()
    steps = STEPS if source_result is None else ['ValidateInput', 'SynthesizeAudio', 'MixAudioTracks', 'RecordSummary']
    try:
        with store.lock:
            require_video(store.data, video_id)
            store.data['executions'][job_id] = {
                'execution_arn': job_id, 'video_id': video_id,
                'status': 'RUNNING', 'start_date': started, 'stop_date': None,
                'error': None, 'cause': None, 'language': language, 'voice': voice,
                'dialogue_language': dialogue_language,
                'kind': 'generate' if source_result is None else 'render',
                'narration_mode': narration_mode,
                'source_execution_id': source_execution_id, 'min_silence_duration': min_gap,
                'steps': [{'name': name, 'status': 'pending', 'entered_at': None, 'exited_at': None} for name in steps]}
            store.save()
        background.add_task(run_job, store, job_id, video_id, min_gap, source_result, edits)
    except Exception as exc:
        with store.lock:
            store.data['executions'].pop(job_id, None)
        store.busy.release()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(500, 'Cannot save the execution. Check local disk space and retry.') from None
    return {'execution_arn': job_id, 'start_date': started}


def create_app(settings=None):
    settings = settings or Settings.load()
    store = Store(settings)
    app = FastAPI(title='VisionEcho API', docs_url='/api/docs', redoc_url=None)
    app.state.store = store
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', '[::1]', 'testserver'])

    @app.middleware('http')
    async def local_origin_only(request, call_next):
        origin = request.headers.get('origin')
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin:
            if origin not in {'http://127.0.0.1:5174', 'http://localhost:5174',
                              'http://127.0.0.1:8000', 'http://localhost:8000'}:
                return JSONResponse({'error': 'Local requests only.'}, status_code=403)
        return await call_next(request)

    @app.exception_handler(HTTPException)
    async def api_error(request, exc):
        return JSONResponse({'error': settings.redact(exc.detail)}, status_code=exc.status_code)

    @app.get('/api/health')
    def health():
        issues = settings.issues()
        return {'status': 'ok', 'provider': 'azure', 'model': settings.azure_openai_deployment,
                'speech_voice': settings.azure_speech_voice,
                'languages': [{'id': key, **value} for key, value in LANGUAGES.items()],
                'speech_region_configured': bool(settings.azure_speech_region or settings.azure_speech_endpoint),
                'configured': not issues, 'issues': issues,
                'max_video_seconds': settings.max_video_seconds,
                'max_upload_mb': settings.max_upload_bytes // 1024 // 1024}

    @app.get('/api/trigger/videos')
    def inputs():
        with store.lock:
            rows = [copy.deepcopy(source) for video_id, source in store.data['inputs'].items() if not video_deleted(store.data, video_id)]
        return {'videos': sorted(rows, key=lambda v: v['last_modified'], reverse=True)}

    @app.post('/api/trigger/upload')
    def prepare_upload(payload: UploadRequest):
        name = payload.filename
        if Path(name).name != name or chr(92) in name or not name.lower().endswith('.mp4'):
            raise HTTPException(400, 'Choose an MP4 filename without directory components.')
        stem = re.sub(r'[^a-zA-Z0-9_-]+', '-', Path(name).stem).strip('-')[:70] or 'video'
        video_id = f'{stem}-{uuid.uuid4().hex[:12]}'
        token = secrets.token_urlsafe(24)
        with store.lock:
            require_collection(store.data, payload.collection_id)
            if len(store.pending) >= 100:
                raise HTTPException(429, 'Too many pending uploads. Restart the local server.')
            store.pending[token] = {'id': video_id, 'filename': name, 'collection_id': payload.collection_id}
        return {'url': f'/api/uploads/{token}', 'key': f'input/{video_id}.mp4'}

    @app.put('/api/uploads/{token}')
    async def receive_upload(token: str, request: Request):
        with store.lock:
            pending = store.pending.pop(token, None)
            if not pending:
                raise HTTPException(404, 'Upload link not found or already used.')
            require_collection(store.data, pending['collection_id'])
            store.active_uploads[token] = pending
        video_id = pending['id']
        path = store.root / 'input' / f'{video_id}.mp4'
        temp = path.with_suffix('.upload')
        size = 0
        try:
            with temp.open('wb') as target:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        raise HTTPException(413, f'Upload limit is {settings.max_upload_bytes // 1024 // 1024} MB.')
                    target.write(chunk)
            duration = await run_in_threadpool(validate_upload, temp, settings)
            with store.lock:
                collection = require_collection(store.data, pending['collection_id'])
                previous_collection = copy.deepcopy(collection)
                temp.replace(path)
                store.data['inputs'][video_id] = {
                    'video_id': video_id, 'key': f'input/{video_id}.mp4',
                    'filename': pending['filename'], 'size_mb': round(size / 1024**2, 3),
                    'last_modified': now(), 'duration': duration, 'collection_id': pending['collection_id']}
                collection['updated_at'] = now()
                try:
                    store.save()
                except OSError:
                    store.data['inputs'].pop(video_id, None)
                    store.data['collections'][pending['collection_id']] = previous_collection
                    path.unlink(missing_ok=True)
                    raise HTTPException(500, '无法保存上传的视频，请检查磁盘空间。') from None
            return {'key': f'input/{video_id}.mp4'}
        finally:
            temp.unlink(missing_ok=True)
            with store.lock:
                store.active_uploads.pop(token, None)

    @app.get('/api/trigger/videos/{video_id}/url')
    def input_url(video_id: str):
        with store.lock:
            require_video(store.data, video_id)
        return {'url': f'/api/media/input/{video_id}'}

    @app.get('/api/media/input/{video_id}')
    def input_media(video_id: str):
        with store.lock:
            require_video(store.data, video_id)
        return FileResponse(store.root / 'input' / f'{video_id}.mp4', media_type='video/mp4')

    @app.post('/api/trigger/executions')
    def start(payload: ExecutionRequest, background: BackgroundTasks):
        issues = settings.issues()
        if issues:
            raise HTTPException(503, ' '.join(issues))
        if payload.video_id not in store.snapshot('inputs'):
            raise HTTPException(404, 'Input video not found.')
        with store.lock:
            require_video(store.data, payload.video_id)
            if store.data['inputs'][payload.video_id].get('archived'):
                raise HTTPException(409, 'Restore the archived video project before processing.')
        return enqueue_job(store, background, payload.video_id, language=payload.language, voice=payload.voice,
                           narration_mode=payload.narration_mode, dialogue_language=payload.dialogue_language)

    def get_job(job_id):
        with store.lock:
            job = store.data['executions'].get(job_id)
            if not job:
                raise HTTPException(404, 'Execution not found.')
            require_video(store.data, job.get('video_id'))
            return copy.deepcopy(job)

    @app.get('/api/trigger/executions/{job_id}/status')
    def status(job_id: str):
        return {k: v for k, v in get_job(job_id).items() if k != 'result'}

    @app.get('/api/videos')
    def videos():
        with store.lock:
            rows = [copy.deepcopy(output) for job_id, output in store.data['outputs'].items()
                    if not video_deleted(store.data, store.data['executions'].get(job_id, {}).get('video_id'))]
        return {'videos': sorted(rows, key=lambda v: v['last_modified'], reverse=True)}

    @app.get('/api/videos/{job_id}/url')
    def output_url(job_id: str):
        get_job(job_id)
        if job_id not in store.snapshot('outputs'):
            raise HTTPException(404, 'Output video not found.')
        return {'url': f'/api/media/output/{job_id}'}

    @app.get('/api/media/output/{job_id}')
    def output_media(job_id: str, download: bool = False):
        video = store.snapshot('outputs').get(job_id)
        if not video:
            raise HTTPException(404, 'Output video not found.')
        return FileResponse(get_job(job_id)['result']['output_path'], media_type='video/mp4',
                            filename=video['filename'] if download else None)

    @app.get('/api/videos/{job_id}/segments')
    def segments(job_id: str):
        source = get_job(job_id).get('result', {}).get('segments', [])
        return {'segments': [{'start': s['start_time'], 'end': s['end_time'],
                              'duration': s['silence_duration'], 'dvi_text': s['dvi_text']}
                             for s in source if s.get('pass')]}

    @app.get('/api/videos/{job_id}/summary')
    def summary(job_id: str):
        result = get_job(job_id).get('result')
        if not result:
            return {'summary': None}
        source = result.get('segments', [])
        passed = sum(bool(s.get('pass')) for s in source)
        return {'video_id': job_id, 'pipeline_version': 'azure-local',
                'summary': {'total_silence_segments': len(source), 'segments_passed': passed,
                            'segments_failed': len(source) - passed,
                            'total_silence_duration': sum(s['silence_duration'] for s in source)},
                'segments': [{'index': s['segment_index'], 'start_time': s['start_time'],
                              'silence_duration': s['silence_duration'], 'dvi_text': s['dvi_text'],
                              'audio_duration': s.get('audio_duration'),
                              'duration_check': 'PASS' if s.get('pass') else 'FAIL'} for s in source]}

    @app.get('/api/cost/executions')
    def executions(video_id: str):
        with store.lock:
            require_video(store.data, video_id)
        return {'executions': [
            {'execution_arn': j['execution_arn'], 'name': j['execution_arn'],
             'pipeline_version': 'azure-local', 'status': j['status'], 'start_time': j['start_date']}
            for j in store.snapshot('executions').values() if j['video_id'] == video_id]}

    @app.get('/api/executions/{job_id}/usage')
    def usage(job_id: str):
        job = get_job(job_id)
        return {'execution_id': job_id, 'usage': job.get('result', {}).get('usage', {}),
                'note': 'Usage only. Azure billing determines the actual cost.'}

    from .projects import register_project_routes
    from .editing import register_edit_routes
    from .calibration import register_calibration_routes
    from .collections import register_collection_routes
    register_collection_routes(app, store, settings)
    register_project_routes(app, store, settings)
    register_edit_routes(app, store, settings, enqueue_job)
    register_calibration_routes(app, store, settings)
    return app
