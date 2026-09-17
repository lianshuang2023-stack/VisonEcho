import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_backend.config import Settings
from local_backend.editing import register_edit_routes
from local_backend.main import Store, create_app


def editor_client(tmp_path):
    settings = Settings(data_dir=tmp_path, azure_openai_endpoint='https://example.azure.com',
                        azure_openai_api_key='fake', azure_speech_key='fake', azure_speech_region='example')
    store = Store(settings)
    directory = tmp_path / 'runs' / 'original'
    directory.mkdir()
    (directory / 'transcript.json').write_text(json.dumps({'phrases': []}))
    draft = {'revision': 3, 'cues': [{'id': 'a', 'start': 0, 'end': 1, 'text': 'Reviewed caption.'}]}
    (directory / 'transcript-edits.json').write_text(json.dumps(draft))
    store.data['inputs']['video'] = {'filename': 'sample.mp4', 'duration': 6}
    store.data['executions']['original'] = {
        'execution_arn': 'original', 'video_id': 'video', 'status': 'SUCCEEDED',
        'result': {'transcript_path': str(directory / 'transcript.json'), 'segments': [
            {'segment_index': 0, 'start_time': 1, 'end_time': 5, 'silence_duration': 4,
             'dvi_text': 'Original description.', 'audio_duration': 2, 'pass': True,
             'audio_path': '/private/server-file.wav'}]},
    }
    store.save()
    calls = []
    def enqueue(*args, **kwargs):
        calls.append(kwargs)
        return {'execution_arn': 'new-version', 'start_date': 'today'}
    app = FastAPI()
    register_edit_routes(app, store, settings, enqueue)
    return TestClient(app), store, calls, draft


def test_editor_hides_internal_paths_and_returns_all_segments(tmp_path):
    client, store, calls, draft = editor_client(tmp_path)
    data = client.get('/api/videos/original/editor').json()
    assert data['language'] == 'en-US'
    assert 'audio_path' not in data['segments'][0]


def test_render_validates_edits_and_preserves_source_and_captions(tmp_path):
    client, store, calls, draft = editor_client(tmp_path)
    for edits in ([], [{'segment_index': 99, 'dvi_text': 'x'}],
                  [{'segment_index': 0, 'dvi_text': 'x'}] * 2,
                  [{'segment_index': 0, 'dvi_text': 'Original description.'}]):
        assert client.post('/api/videos/original/render', json={'segments': edits}).status_code == 400
    result = client.post('/api/videos/original/render', json={
        'segments': [{'segment_index': 0, 'dvi_text': 'Revised description.', 'start_time': 0}]})
    assert result.status_code == 200
    assert calls[0]['edits'] == [{'segment_index': 0, 'dvi_text': 'Revised description.'}]
    assert calls[0]['source_result']['source_transcript_edits'] == draft
    assert calls[0]['source_execution_id'] == 'original'
    assert store.data['executions']['original']['result']['segments'][0]['dvi_text'] == 'Original description.'
    store.data['inputs']['video']['archived'] = True
    assert client.post('/api/videos/original/render', json={'segments': [{'segment_index': 0, 'dvi_text': 'x'}]}).status_code == 409


def test_job_language_and_voice_are_per_execution(tmp_path, monkeypatch):
    from local_backend import main
    settings = Settings(data_dir=tmp_path, azure_openai_endpoint='https://example.azure.com',
                        azure_openai_api_key='fake', azure_speech_key='fake', azure_speech_region='example')
    app = create_app(settings)
    app.state.store.data['inputs']['sample'] = {'filename': 'sample.mp4'}
    seen = []
    def fake_pipeline(input_path, output_dir, run_settings, minimum, on_step):
        seen.append((run_settings.speech_language, run_settings.azure_speech_voice))
        output_dir.mkdir()
        output = output_dir / 'video.mp4'
        output.write_bytes(b'test')
        return {'output_path': str(output), 'segments': []}
    monkeypatch.setattr(main, 'process_video', fake_pipeline)
    with TestClient(app) as client:
        for language in ('en-US', 'zh-CN'):
            response = client.post('/api/trigger/executions', json={'video_id': 'sample', 'language': language})
            assert response.status_code == 200
        assert client.post('/api/trigger/executions', json={'video_id': 'sample', 'language': 'invalid'}).status_code == 422
        assert client.post('/api/trigger/executions', json={'video_id': 'sample', 'language': 'zh-CN', 'voice': 'en-US-GuyNeural'}).status_code == 400
    assert seen == [('en-US', 'en-US-JennyNeural'), ('zh-CN', 'zh-CN-XiaoxiaoNeural')]
    assert settings.speech_language == 'en-US'


def test_voice_only_revision_and_language_mismatch(tmp_path):
    client, store, calls, draft = editor_client(tmp_path)
    response = client.post('/api/videos/original/render', json={'segments': [], 'voice': 'en-US-GuyNeural'})
    assert response.status_code == 200
    assert calls[-1]['voice'] == 'en-US-GuyNeural'
    assert calls[-1]['source_result']['voice'] == 'en-US-JennyNeural'
    assert client.post('/api/videos/original/render', json={'segments': [], 'voice': 'en-US-JennyNeural'}).status_code == 400
    assert client.post('/api/videos/original/render', json={'segments': [], 'voice': 'zh-CN-YunxiNeural'}).status_code == 400


def test_generation_keeps_source_dialogue_independent_of_narration(tmp_path, monkeypatch):
    from local_backend import main
    settings = Settings(data_dir=tmp_path, azure_openai_endpoint='https://example.azure.com',
                        azure_openai_api_key='fake', azure_speech_key='fake', azure_speech_region='example')
    app = create_app(settings)
    app.state.store.data['inputs']['sample'] = {'filename': 'sample.mp4'}
    seen = []
    def fake_pipeline(input_path, output_dir, run_settings, minimum, on_step):
        seen.append((run_settings.dialogue_language, run_settings.speech_language, run_settings.azure_speech_voice))
        output_dir.mkdir()
        output = output_dir / 'video.mp4'
        output.write_bytes(b'test')
        return {'output_path': str(output), 'segments': []}
    monkeypatch.setattr(main, 'process_video', fake_pipeline)
    with TestClient(app) as client:
        for dialogue_language in ('en-US', 'auto'):
            response = client.post('/api/trigger/executions', json={
                'video_id': 'sample', 'language': 'zh-CN', 'dialogue_language': dialogue_language,
                'voice': 'zh-CN-YunxiNeural'})
            assert response.status_code == 200
            job = app.state.store.data['executions'][response.json()['execution_arn']]
            assert job['dialogue_language'] == dialogue_language
            assert job['result']['dialogue_language'] == dialogue_language
            assert job['result']['language'] == 'zh-CN'
        assert client.post('/api/trigger/executions', json={
            'video_id': 'sample', 'dialogue_language': 'bad'}).status_code == 422
    assert seen == [('en-US', 'zh-CN', 'zh-CN-YunxiNeural'), ('auto', 'zh-CN', 'zh-CN-YunxiNeural')]
    assert settings.dialogue_language == 'auto'


def test_revoice_keeps_calibrated_dialogue_language_and_metadata(tmp_path):
    client, store, calls, draft = editor_client(tmp_path)
    draft.update(language='zh-CN', dialogue_language='auto')
    (store.root / 'runs/original/transcript-edits.json').write_text(json.dumps(draft))
    assert client.get('/api/videos/original/editor').json()['dialogue_language'] == 'auto'
    result = client.post('/api/videos/original/render', json={'segments': [], 'voice': 'en-US-GuyNeural'})
    assert result.status_code == 200
    assert calls[-1]['source_result']['source_transcript_edits'] == draft
    assert calls[-1]['source_result']['language'] == 'en-US'
    assert calls[-1]['source_result']['dialogue_language'] == 'auto'


def test_render_needs_only_speech_and_rejects_external_subtitle_snapshot(tmp_path):
    client, store, calls, draft = editor_client(tmp_path)
    store.settings.azure_openai_api_key = ''
    store.settings.azure_openai_endpoint = ''
    body = {'segments': [{'segment_index': 0, 'dvi_text': 'Changed text.'}]}
    assert client.post('/api/videos/original/render', json=body).status_code == 200
    outside = tmp_path / 'outside.json'
    outside.write_text(json.dumps(draft))
    link = tmp_path / 'runs' / 'original' / 'transcript-edits.json'
    link.unlink()
    link.symlink_to(outside)
    assert client.post('/api/videos/original/render', json=body).status_code == 409
    link.unlink()
    link.write_text(json.dumps({'revision': 1, 'cues': [], 'unrelated': 'not allowed'}))
    assert client.post('/api/videos/original/render', json=body).status_code == 409
