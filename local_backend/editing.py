"""Narration review API. Text edits create a fresh rendered version."""
import copy
import json
import shutil
from pathlib import Path

from fastapi import BackgroundTasks, HTTPException
from pydantic import BaseModel, Field, ValidationError
from .projects import TranscriptUpdate, _validate_cues, _review_state, _transcript, _transcript_quality
from .config import validate_voice
from .lifecycle import require_video


class SegmentEdit(BaseModel):
    segment_index: int = Field(ge=0)
    dvi_text: str = Field(max_length=2000)


class RenderRequest(BaseModel):
    segments: list[SegmentEdit] = Field(max_length=120)
    voice: str | None = None


def register_edit_routes(app, store, settings, enqueue):
    def source_job(job_id):
        with store.lock:
            job = store.data['executions'].get(job_id)
            if not job or job.get('status') != 'SUCCEEDED' or not job.get('result'):
                raise HTTPException(404, 'Completed video version not found.')
            require_video(store.data, job.get('video_id'))
            return copy.deepcopy(job)

    @app.get('/api/videos/{job_id}/editor')
    def editor(job_id: str):
        job = source_job(job_id)
        with store.lock:
            review = _review_state(store, job_id)
            try:
                transcript_language = _transcript(store, job_id).get('dialogue_language')
            except HTTPException:
                transcript_language = None
        result = job['result']
        fields = ('segment_index', 'start_time', 'end_time', 'silence_duration',
                  'dvi_text', 'audio_duration', 'pass', 'skip_reason', 'source_start', 'source_end', 'insertion_time', 'character_ids')
        return {
            'segments': [{key: segment[key] for key in fields if key in segment}
                         for segment in result.get('segments', [])],
            'language': result.get('language', job.get('language', 'en-US')),
            'dialogue_language': transcript_language or result.get('dialogue_language', job.get('dialogue_language', 'auto')),
            'voice': result.get('voice', job.get('voice', 'en-US-JennyNeural')),
            'source_execution_id': job_id,
            'reviewed': review['reviewed'],
            'reviewed_at': review['reviewed_at'],
            'summary': result.get('summary', {}),
            'narration_mode': result.get('narration_mode', 'standard'),
            'outcome': result.get('outcome', 'audio_description' if any(s.get('pass') for s in result.get('segments', [])) else 'subtitles_only'),
            'insertions': result.get('insertions', []),
            'character_detection': result.get('character_detection'),
        }

    @app.post('/api/videos/{job_id}/render')
    def render(job_id: str, payload: RenderRequest, background: BackgroundTasks):
        job = source_job(job_id)
        video_id = job['video_id']
        project = store.snapshot('inputs').get(video_id)
        if not project:
            raise HTTPException(404, 'Source video not found.')
        if project.get('archived'):
            raise HTTPException(409, 'Restore the archived project before creating a version.')
        source = copy.deepcopy(job['result'])
        language = source.get('language', job.get('language', 'en-US'))
        original_voice = source.get('voice', job.get('voice')) or validate_voice(language)
        try:
            selected_voice = validate_voice(language, payload.voice if payload.voice is not None else original_voice)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        original = {s['segment_index']: s for s in source.get('segments', [])}
        indices = [s.segment_index for s in payload.segments]
        if len(indices) != len(set(indices)) or any(index not in original for index in indices):
            raise HTTPException(400, 'Each segment must refer to a unique existing narration window.')
        edits = [{'segment_index': s.segment_index, 'dvi_text': s.dvi_text.strip()} for s in payload.segments]
        if selected_voice == original_voice and not any(edit['dvi_text'] != original[edit['segment_index']].get('dvi_text', '').strip() for edit in edits):
            raise HTTPException(400, '修改口述稿或选择不同音色后，再生成新版本。')
        revised_text = {index: segment.get('dvi_text', '') for index, segment in original.items()}
        revised_text.update({edit['segment_index']: edit['dvi_text'] for edit in edits})
        issues = []
        if any(text.strip() for text in revised_text.values()):
            if not settings.azure_speech_key or not (settings.azure_speech_region or settings.azure_speech_endpoint):
                issues.append('Configure Azure Speech before rendering narration.')
        if not all(shutil.which(tool) for tool in (settings.ffmpeg_bin, settings.ffprobe_bin)):
            issues.append('FFmpeg and FFprobe are required to export the video.')
        if issues:
            raise HTTPException(503, ' '.join(issues))
        run_root = (store.root / 'runs' / job_id).resolve()
        transcript = Path(source.get('transcript_path', run_root / 'transcript.json')).resolve()
        if not transcript.is_relative_to(run_root) or not transcript.is_file():
            raise HTTPException(409, 'The source transcript is missing. Generate a new video version first.')
        source['transcript_path'] = str(transcript)
        if source.get('narration_mode') == 'extended':
            original_transcript = Path(source.get('source_transcript_path', run_root / 'source-transcript.json')).resolve()
            if not original_transcript.is_relative_to(run_root) or not original_transcript.is_file():
                raise HTTPException(409, '扩展版本缺少原片字幕，请重新生成。')
            source['source_transcript_path'] = str(original_transcript)
        source.setdefault('language', language)
        source.setdefault('dialogue_language', job.get('dialogue_language', 'auto'))
        source.setdefault('voice', original_voice)
        with store.lock:
            draft = run_root / 'transcript-edits.json'
            if draft.exists():
                if not draft.resolve().is_relative_to(run_root):
                    raise HTTPException(409, 'The saved transcript is outside its video version directory.')
                try:
                    saved_payload = json.loads(draft.read_text())
                    saved = TranscriptUpdate.model_validate({key: value for key, value in saved_payload.items() if key != 'quality'})
                    duration = source.get('summary', {}).get('video_duration') or project.get('duration')
                    if not duration:
                        raise ValueError('Video duration is unavailable.')
                    source['source_transcript_edits'] = {
                        'revision': saved.revision,
                        'cues': _validate_cues(saved.cues, float(duration)),
                    }
                    for key in ('language', 'dialogue_language'):
                        if saved_payload.get(key) in ('auto', 'en-US', 'zh-CN'):
                            source['source_transcript_edits'][key] = saved_payload[key]
                    if saved_payload.get('dialogue_language') in ('auto', 'en-US', 'zh-CN'):
                        source['dialogue_language'] = saved_payload['dialogue_language']
                    if _transcript_quality(saved_payload):
                        source['source_transcript_edits']['quality'] = _transcript_quality(saved_payload)
                except (OSError, ValueError, ValidationError):
                    raise HTTPException(409, 'The saved transcript is invalid. Reload and save it before rendering.') from None
        return enqueue(store, background, video_id,
                       min_gap=job.get('min_silence_duration', 4),
                       language=source['language'], source_result=source, edits=edits,
                       source_execution_id=job_id, voice=selected_voice,
                       narration_mode=source.get('narration_mode', 'standard'))
