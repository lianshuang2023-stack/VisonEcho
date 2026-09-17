import json
from pathlib import Path

from fastapi.testclient import TestClient
from local_backend import calibration, main
from local_backend.config import Settings


def setup(tmp_path):
    cfg = Settings(data_dir=tmp_path, azure_speech_key='fake', azure_speech_region='example')
    app = main.create_app(cfg)
    store = app.state.store
    directory = tmp_path / 'runs' / 'old'
    directory.mkdir()
    transcript = directory / 'transcript.json'
    transcript.write_text(json.dumps({'phrases': [{'start': 0, 'end': 12, 'text': '欢迎现在开始演示。'}]}))
    store.data['inputs']['sample'] = {'filename': 'sample.mp4', 'duration': 12}
    store.data['executions']['old'] = {'video_id': 'sample', 'execution_arn': 'old', 'status': 'SUCCEEDED',
                                     'result': {'transcript_path': str(transcript), 'segments': []}}
    store.save()
    return app, store, directory


def test_calibration_replaces_subtitle_times_without_creating_video_version(tmp_path, monkeypatch):
    app, store, directory = setup(tmp_path)
    store.data['executions']['old'].update(reviewed=True, reviewed_at='before', reviewed_transcript_revision=0)
    def calibrated(input_path, output_dir, settings):
        assert settings.dialogue_language == 'zh-CN'
        assert settings.speech_language == 'en-US'
        return {'cues': [{'id': 'c1', 'start': 1.15, 'end': 3.15, 'text': '欢迎现在开始演示。'}]}
    monkeypatch.setattr(calibration, 'calibrate_audio', calibrated)
    with TestClient(app) as client:
        result = client.post('/api/videos/old/transcript/calibrate', json={'language': 'zh-CN', 'revision': 0})
        assert result.status_code == 200
        task = client.get('/api/transcript-calibrations/' + result.json()['calibration_id']).json()
        assert task['status'] == 'SUCCEEDED'
        assert task['result']['revision'] == 1
        assert task['result']['cues'][0]['end'] == 3.15
        assert client.get('/api/videos/old/transcript').json() == task['result']
        assert client.post('/api/videos/old/transcript/calibrate', json={'language': 'zh-CN', 'revision': 0}).status_code == 409
    assert len(store.data['executions']) == 1
    assert store.data['executions']['old']['reviewed'] is False
    assert store.data['executions']['old']['transcript_revision'] == 1
    assert store.data['inputs']['sample']['updated_at']
    assert json.loads((directory / 'transcript.json').read_text())['phrases'][0]['end'] == 12
    assert not store.busy.locked()


def test_calibration_preserves_edits_saved_during_recognition(tmp_path, monkeypatch):
    app, store, directory = setup(tmp_path)
    edited = {'cues': [{'id': 'manual', 'start': 1, 'end': 3, 'text': '人工修改'}], 'revision': 1}
    def concurrent(*args):
        (directory / 'transcript-edits.json').write_text(json.dumps(edited))
        return {'cues': [{'id': 'cloud', 'start': 1, 'end': 3, 'text': '云端结果'}]}
    monkeypatch.setattr(calibration, 'calibrate_audio', concurrent)
    with TestClient(app) as client:
        result = client.post('/api/videos/old/transcript/calibrate', json={'language': 'zh-CN', 'revision': 0}).json()
        task = client.get('/api/transcript-calibrations/' + result['calibration_id']).json()
        assert task['status'] == 'FAILED'
        assert '已被修改' in task['error']
        assert client.get('/api/videos/old/transcript').json() == edited
    assert not store.busy.locked()


def test_calibration_failure_is_redacted_and_preserves_saved_subtitles(tmp_path, monkeypatch):
    app, store, directory = setup(tmp_path)
    def failure(*args):
        raise ValueError('service key fake rejected')
    monkeypatch.setattr(calibration, 'calibrate_audio', failure)
    with TestClient(app) as client:
        result = client.post('/api/videos/old/transcript/calibrate', json={'language': 'en-US', 'revision': 0}).json()
        task = client.get('/api/transcript-calibrations/' + result['calibration_id']).json()
        assert task['status'] == 'FAILED'
        assert 'fake' not in task['error']
        assert client.get('/api/videos/old/transcript').json()['revision'] == 0
    assert not store.busy.locked()


def test_auto_calibration_keeps_detected_source_language_after_manual_save(tmp_path, monkeypatch):
    app, store, directory = setup(tmp_path)
    def calibrated(input_path, output_dir, settings):
        assert settings.dialogue_language == 'auto'
        assert settings.speech_language == 'en-US'
        return {'language': 'zh-CN', 'cues': [{'id': 'c1', 'start': 1, 'end': 3, 'text': '欢迎。'}]}
    monkeypatch.setattr(calibration, 'calibrate_audio', calibrated)
    with TestClient(app) as client:
        result = client.post('/api/videos/old/transcript/calibrate', json={'revision': 0})
        assert result.status_code == 200
        captions = client.get('/api/videos/old/transcript').json()
        assert captions['language'] == 'zh-CN'
        assert captions['dialogue_language'] == 'auto'
        captions['cues'][0]['text'] = '欢迎！'
        # Sending a different language cannot silently relabel existing dialogue.
        captions['language'] = 'en-US'
        saved = client.put('/api/videos/old/transcript', json=captions)
        assert saved.status_code == 200
        assert saved.json()['language'] == 'zh-CN'
        assert saved.json()['dialogue_language'] == 'auto'
        assert saved.json()['revision'] == 2
