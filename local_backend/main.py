"""Loopback-only API adapter for the dashboard and Azure pipeline."""
from datetime import datetime, timezone
from dataclasses import replace
from typing import Literal
from pathlib import Path
from threading import Lock
import copy
import asyncio
import hashlib
import json
import re
import secrets
import subprocess
import time
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

UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
UPLOAD_TTL_SECONDS = 3600

def now():
    return datetime.now(timezone.utc).isoformat()

class UploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=240)
    collection_id: str = Field(default='default', min_length=1, max_length=100)
    size_bytes: int | None = Field(default=None, gt=0, strict=True)

class ExecutionRequest(BaseModel):
    video_id: str
    language: Literal["en-US", "zh-CN"] | None = None
    dialogue_language: Literal["auto", "en-US", "zh-CN", "none"] | None = None
    voice: str | None = None
    narration_mode: Literal['auto', 'standard', 'extended'] = 'auto'
    narration_style: Literal['concise', 'cinematic'] = 'concise'
    detect_characters: bool = Field(default=True, strict=True)

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
        self.completed_uploads = {}
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
                       narration_mode=job_config.get('narration_mode', 'auto'),
                       narration_style=job_config.get('narration_style', 'concise'),
                       character_context=copy.deepcopy(job_config.get('character_context', [])),
                       character_library=copy.deepcopy(job_config.get('character_library', [])),
                       detect_characters=bool(job_config.get('detect_characters', False) and source_result is None))
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
            if settings.detect_characters and settings.character_library:
                from .character_detection import enrich_character_references
                settings.character_library = enrich_character_references(
                    store, settings.character_library, settings, video_id=video_id)
            result = process_video(store.root / 'input' / f'{video_id}.mp4',
                                   store.root / 'runs' / job_id, settings, min_gap, update_step)
        else:
            from .revision import render_revision
            result = render_revision(store.root / 'input' / f'{video_id}.mp4',
                                     store.root / 'runs' / job_id, settings, source_result, edits, update_step)
        result.update(language=settings.speech_language, dialogue_language=settings.dialogue_language, narration_style=settings.narration_style,
                      voice=settings.azure_speech_voice, character_context=settings.character_context)
        if job_config.get('source_execution_id'):
            result['source_execution_id'] = job_config['source_execution_id']
        path = Path(result['output_path']).resolve()
        if not path.is_relative_to((store.root / 'runs' / job_id).resolve()) or not path.is_file():
            raise RuntimeError('Processing finished without a readable output video.')
        result['output_path'] = str(path)
        with store.lock:
            before = copy.deepcopy(store.data)
            job = store.data['executions'][job_id]
            source = store.data['inputs'][video_id]
            candidates = result.pop('character_candidates', [])
            if settings.detect_characters and result.get('character_detection', {}).get('status') == 'SUCCEEDED':
                from .character_detection import merge_detected_characters
                try:
                    counts = merge_detected_characters(source, candidates, job_config.get('character_revision', 0))
                    result['character_detection'].update(counts)
                except (HTTPException, ValueError) as error:
                    detail = error.detail if isinstance(error, HTTPException) else str(error)
                    result['character_detection'].update(status='FAILED', error=settings.redact(detail))
            job.update(status='SUCCEEDED', stop_date=now(), result=result)
            store.data['outputs'][job_id] = {
                'key': job_id, 'video_id': job_id,
                'filename': Path(source['filename']).stem + '-described.mp4',
                'pipeline_version': 'azure-local', 'last_modified': now(),
                'size_bytes': path.stat().st_size,
            }
            try:
                (store.root / 'runs' / job_id / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
                store.save()
            except Exception:
                store.data.clear()
                store.data.update(before)
                raise
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

def enqueue_job(store, background, video_id, min_gap=2, language=None, source_result=None, edits=None, source_execution_id=None, voice=None, narration_mode='auto', dialogue_language=None, detect_characters=False, narration_style=None):
    language = language or store.settings.speech_language
    narration_style = narration_style or (source_result or {}).get('narration_style', 'concise')
    if narration_style not in ('concise', 'cinematic'):
        raise HTTPException(400, '请选择简洁或电影感口述风格。')
    dialogue_language = dialogue_language or (source_result or {}).get('dialogue_language') or store.settings.dialogue_language
    if dialogue_language not in ('auto', 'en-US', 'zh-CN', 'none'):
        raise HTTPException(400, '请选择自动识别、中文、英文或无对白。')
    try:
        voice = validate_voice(language, voice if voice is not None else (source_result or {}).get('voice'))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    if not store.busy.acquire(blocking=False):
        raise HTTPException(409, 'A video is already processing. Wait for it to finish.')
    job_id, started = uuid.uuid4().hex, now()
    steps = list(STEPS) if source_result is None else ['ValidateInput', 'SynthesizeAudio', 'MixAudioTracks', 'RecordSummary']
    if source_result is None and detect_characters:
        steps.insert(steps.index('GenerateDVI'), 'DetectCharacters')
    try:
        from .characters import confirmed_character_context
        character_context = (confirmed_character_context(store, video_id) if source_result is None
                             else copy.deepcopy(source_result.get('character_context', [])))
        with store.lock:
            source = require_video(store.data, video_id)
            cards = copy.deepcopy(source.get('character_cards', {'revision': 0, 'characters': []}))
            store.data['executions'][job_id] = {
                'execution_arn': job_id, 'video_id': video_id,
                'status': 'RUNNING', 'start_date': started, 'stop_date': None,
                'error': None, 'cause': None, 'language': language, 'voice': voice,
                'dialogue_language': dialogue_language,
                'character_context': character_context,
                'character_library': cards['characters'],
                'character_revision': cards['revision'],
                'detect_characters': bool(detect_characters and source_result is None),
                'kind': 'generate' if source_result is None else 'render',
                'narration_mode': narration_mode,
                'narration_style': narration_style,
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
    if settings.access_mode == 'hosted':
        from .hosted import create_hosted_app
        return create_hosted_app(settings)
    if settings.access_mode != 'local':
        raise ValueError('ACCESS_MODE must be local or hosted.')
    store = Store(settings)
    app = FastAPI(title='VisionEcho API', docs_url='/api/docs', redoc_url=None)
    app.state.store = store
    from urllib.parse import urlsplit
    extra_host = urlsplit(settings.public_origin).hostname if settings.public_origin else None
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', '[::1]', 'testserver'] + ([extra_host] if extra_host else []))

    @app.middleware('http')
    async def local_origin_only(request, call_next):
        origin = request.headers.get('origin')
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin:
            if origin not in {'http://127.0.0.1:5174', 'http://localhost:5174',
                              'http://127.0.0.1:8000', 'http://localhost:8000', settings.public_origin}:
                return JSONResponse({'error': 'Local requests only.'}, status_code=403)
        return await call_next(request)

    @app.exception_handler(HTTPException)
    async def api_error(request, exc):
        return JSONResponse({'error': settings.redact(exc.detail)}, status_code=exc.status_code, headers=exc.headers)

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

    @app.get('/api/access/session')
    def local_session():
        return {'mode': 'local', 'user': None, 'limits': {'max_video_seconds': settings.max_video_seconds,
                'max_upload_mb': settings.max_upload_bytes // 1024 // 1024}}

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
            cleanup_uploads()
            require_collection(store.data, payload.collection_id)
            if payload.size_bytes is not None and payload.size_bytes > settings.max_upload_bytes:
                raise HTTPException(413, f'Upload limit is {settings.max_upload_bytes // 1024 // 1024} MB.')
            if settings.workspace_upload_limit is not None and len(store.data['inputs']) + len(store.pending) + len(store.active_uploads) >= settings.workspace_upload_limit:
                raise HTTPException(403, f'Guest trial supports {settings.workspace_upload_limit} uploads. Register to keep creating.')
            if len(store.pending) + len(store.active_uploads) >= 100:
                raise HTTPException(429, 'Too many pending uploads. Restart the local server.')
            pending = {'id': video_id, 'filename': name, 'collection_id': payload.collection_id,
                       'expires_at': time.time() + UPLOAD_TTL_SECONDS}
            if payload.size_bytes is not None:
                pending.update(size_bytes=payload.size_bytes, chunks=[], receiving=False)
            store.pending[token] = pending
        response = {'url': f'/api/uploads/{token}', 'key': f'input/{video_id}.mp4'}
        if payload.size_bytes is not None:
            response.update(chunk_size=UPLOAD_CHUNK_BYTES, chunk_url=f'/api/uploads/{token}/chunks/{{index}}',
                            complete_url=f'/api/uploads/{token}/complete')
        return response

    def chunk_path(pending):
        directory = store.root / 'chunk-uploads'
        if directory.is_symlink() or not directory.resolve().is_relative_to(store.root.resolve()):
            raise HTTPException(409, 'Upload storage is unavailable.')
        directory.mkdir(mode=0o700, exist_ok=True)
        identifier = pending['id']
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', identifier):
            raise HTTPException(409, 'Upload reference is invalid.')
        path = directory / (identifier + '.part')
        if path.is_symlink():
            raise HTTPException(409, 'Upload storage is unavailable.')
        return path

    def cleanup_uploads():
        # Call under store.lock. Only server-generated chunk spool files are
        # eligible for deletion; original media and user outputs are untouched.
        current = time.time()
        for records in (store.pending, store.active_uploads):
            for key, pending in list(records.items()):
                if pending.get('expires_at', current + 1) <= current and not pending.get('receiving'):
                    if 'size_bytes' in pending:
                        chunk_path(pending).unlink(missing_ok=True)
                    records.pop(key, None)
        for key, completed in list(store.completed_uploads.items()):
            if completed['expires_at'] <= current:
                store.completed_uploads.pop(key, None)
        directory = store.root / 'chunk-uploads'
        if directory.is_dir() and not directory.is_symlink():
            active = {item['id'] for item in store.active_uploads.values()}
            for path in directory.glob('*.part'):
                if (not path.is_symlink() and path.is_file() and path.stem not in active
                        and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', path.stem)
                        and path.stat().st_mtime + UPLOAD_TTL_SECONDS <= current):
                    path.unlink(missing_ok=True)

    def chunk_reservation(token):
        cleanup_uploads()
        pending = store.active_uploads.get(token) or store.pending.get(token)
        if not pending or 'size_bytes' not in pending or pending.get('expires_at', 0) <= time.time():
            raise HTTPException(404, 'Upload session expired or was not found. Start the upload again.')
        require_collection(store.data, pending['collection_id'])
        if pending.get('receiving'):
            raise HTTPException(409, 'This upload is receiving another request. Retry this chunk shortly.')
        store.pending.pop(token, None)
        store.active_uploads[token] = pending
        return pending

    @app.put('/api/uploads/{token}/chunks/{index}')
    async def receive_chunk(token: str, index: int, request: Request):
        with store.lock:
            pending = chunk_reservation(token)
            count = (pending['size_bytes'] + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES
            if index < 0 or index >= count or index > len(pending['chunks']):
                raise HTTPException(409, 'Chunks must be uploaded in order.')
            expected = min(UPLOAD_CHUNK_BYTES, pending['size_bytes'] - index * UPLOAD_CHUNK_BYTES)
            pending['receiving'] = True
        try:
            async def read_body():
                body = bytearray()
                async for part in request.stream():
                    if len(body) + len(part) > expected:
                        raise HTTPException(413, 'Upload chunk exceeds its declared size.')
                    body.extend(part)
                return body
            try:
                body = await asyncio.wait_for(read_body(), timeout=180)
            except TimeoutError:
                raise HTTPException(408, 'Upload chunk timed out. Retry this chunk.') from None
            if len(body) != expected:
                raise HTTPException(400, 'Upload chunk size does not match the declared file size.')
            digest = hashlib.sha256(body).hexdigest()
            with store.lock:
                require_collection(store.data, pending['collection_id'])
                if pending['expires_at'] <= time.time():
                    raise HTTPException(404, 'Upload session expired. Start the upload again.')
                if index < len(pending['chunks']):
                    if pending['chunks'][index] != digest:
                        raise HTTPException(409, 'A different chunk was already received at this position.')
                    return {'index': index, 'received_bytes': min(len(pending['chunks']) * UPLOAD_CHUNK_BYTES, pending['size_bytes'])}
                path = chunk_path(pending)
                offset = index * UPLOAD_CHUNK_BYTES
                if (path.stat().st_size if path.exists() else 0) != offset:
                    raise HTTPException(409, 'Upload data is incomplete. Start the upload again.')
                try:
                    with path.open('ab') as target:
                        target.write(body)
                except OSError:
                    if path.exists():
                        with path.open('r+b') as target:
                            target.truncate(offset)
                    raise HTTPException(503, 'Cannot save this upload chunk. Check disk space and retry.') from None
                pending['chunks'].append(digest)
                return {'index': index, 'received_bytes': offset + len(body)}
        finally:
            with store.lock:
                pending['receiving'] = False

    @app.post('/api/uploads/{token}/complete')
    async def complete_upload(token: str):
        with store.lock:
            cleanup_uploads()
            completed = store.completed_uploads.get(token)
            if completed:
                require_video(store.data, completed['video_id'])
                return {'key': completed['key']}
            pending = chunk_reservation(token)
            count = (pending['size_bytes'] + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES
            path = chunk_path(pending)
            if len(pending['chunks']) != count or not path.is_file() or path.stat().st_size != pending['size_bytes']:
                raise HTTPException(409, 'Upload is incomplete. Send all chunks before finishing.')
            pending['receiving'] = True
        try:
            duration = await run_in_threadpool(validate_upload, path, settings)
            with store.lock:
                collection = require_collection(store.data, pending['collection_id'])
                if pending['expires_at'] <= time.time():
                    raise HTTPException(404, 'Upload session expired. Start the upload again.')
                video_id = pending['id']
                input_directory = store.root / 'input'
                if input_directory.is_symlink() or not input_directory.resolve().is_relative_to(store.root.resolve()):
                    raise HTTPException(409, 'The uploaded video path is unavailable.')
                target = input_directory / (video_id + '.mp4')
                if target.is_symlink() or target.exists() or not target.resolve().is_relative_to((store.root / 'input').resolve()):
                    raise HTTPException(409, 'The uploaded video path is unavailable.')
                before = copy.deepcopy(store.data)
                path.replace(target)
                store.data['inputs'][video_id] = {
                    'video_id': video_id, 'key': f'input/{video_id}.mp4', 'filename': pending['filename'],
                    'size_mb': round(pending['size_bytes'] / 1024**2, 3), 'last_modified': now(),
                    'duration': duration, 'collection_id': pending['collection_id']}
                collection['updated_at'] = now()
                try:
                    store.save()
                except Exception:
                    store.data.clear()
                    store.data.update(before)
                    target.replace(path)
                    raise HTTPException(503, 'Cannot finish this upload. Check disk space and retry.') from None
                key = f'input/{video_id}.mp4'
                store.completed_uploads[token] = {'video_id': video_id, 'key': key, 'expires_at': time.time() + UPLOAD_TTL_SECONDS}
                while len(store.completed_uploads) > 100:
                    store.completed_uploads.pop(next(iter(store.completed_uploads)))
                store.active_uploads.pop(token, None)
                return {'key': key}
        finally:
            with store.lock:
                pending['receiving'] = False

    @app.put('/api/uploads/{token}')
    async def receive_upload(token: str, request: Request):
        with store.lock:
            cleanup_uploads()
            if 'size_bytes' in store.pending.get(token, {}) or 'size_bytes' in store.active_uploads.get(token, {}):
                raise HTTPException(409, 'Use the chunk upload URLs returned for this file.')
            pending = store.pending.pop(token, None)
            if not pending:
                raise HTTPException(404, 'Upload link not found or already used.')
            require_collection(store.data, pending['collection_id'])
            pending['receiving'] = True
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
                           narration_mode=payload.narration_mode, dialogue_language=payload.dialogue_language,
                           detect_characters=payload.detect_characters, narration_style=payload.narration_style)

    def get_job(job_id):
        with store.lock:
            job = store.data['executions'].get(job_id)
            if not job:
                raise HTTPException(404, 'Execution not found.')
            require_video(store.data, job.get('video_id'))
            return copy.deepcopy(job)

    @app.get('/api/trigger/executions/{job_id}/status')
    def status(job_id: str):
        return {k: v for k, v in get_job(job_id).items() if k not in ('result', 'character_context', 'character_library')}

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
        from .projects import _get_result
        with store.lock:
            video = store.data['outputs'].get(job_id)
            if not video:
                raise HTTPException(404, 'Output video not found.')
            _, result, directory = _get_result(store, job_id)
            path = Path(result.get('output_path') or '').resolve()
            if not path.is_relative_to(directory) or not path.is_file():
                raise HTTPException(404, 'Output video file is unavailable.')
        return FileResponse(path, media_type='video/mp4',
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
    from .evidence import register_evidence_routes
    from .characters import register_character_routes
    from .character_detection import register_character_detection_routes
    from .review import register_review_routes
    from .rewrite import register_rewrite_routes
    from .collections import register_collection_routes
    register_collection_routes(app, store, settings)
    register_project_routes(app, store, settings)
    register_edit_routes(app, store, settings, enqueue_job)
    register_calibration_routes(app, store, settings)
    register_evidence_routes(app, store, settings)
    register_character_routes(app, store, settings)
    register_character_detection_routes(app, store, settings)
    register_review_routes(app, store, settings)
    register_rewrite_routes(app, store, settings)
    return app
