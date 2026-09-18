import json
from pathlib import Path
import pytest

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


@pytest.mark.parametrize('recognition', [
    {'cues': [], 'dialogue_status': 'unrecognized', 'dialogue_reason': 'speech_not_recognized'},
    {'cues': []},
])
def test_empty_unrecognized_calibration_keeps_existing_subtitles(tmp_path, monkeypatch, recognition):
    app, store, directory = setup(tmp_path)
    saved = {'cues': [{'id': 'manual', 'start': 1, 'end': 3, 'text': '已校对内容'}], 'revision': 4}
    draft = directory / 'transcript-edits.json'
    draft.write_text(json.dumps(saved))
    original_bytes = draft.read_bytes()
    monkeypatch.setattr(calibration, 'calibrate_audio', lambda *args: recognition)
    with TestClient(app) as client:
        started = client.post('/api/videos/old/transcript/calibrate', json={'language': 'auto', 'revision': 4})
        task = client.get('/api/transcript-calibrations/' + started.json()['calibration_id']).json()
        assert task['status'] == 'FAILED' and '已保留现有字幕' in task['error']
        assert client.get('/api/videos/old/transcript').json() == saved
    assert draft.read_bytes() == original_bytes and not store.busy.locked()


@pytest.mark.parametrize('reason', ['silent_audio', 'no_audio_track'])
def test_verified_no_speech_can_clear_false_positive_subtitles(tmp_path, monkeypatch, reason):
    app, store, _ = setup(tmp_path)
    monkeypatch.setattr(calibration, 'calibrate_audio', lambda *args: {
        'cues': [], 'dialogue_status': 'no_speech', 'dialogue_reason': reason})
    with TestClient(app) as client:
        started = client.post('/api/videos/old/transcript/calibrate', json={'language': 'auto', 'revision': 0})
        task = client.get('/api/transcript-calibrations/' + started.json()['calibration_id']).json()
        assert task['status'] == 'SUCCEEDED'
        saved = client.get('/api/videos/old/transcript').json()
        assert saved['cues'] == [] and saved['revision'] == 1
        assert saved['dialogue_status'] == 'no_speech' and saved['dialogue_reason'] == reason
    assert not store.busy.locked()


def test_explicit_no_dialogue_clears_only_when_requested_and_needs_no_speech_service(tmp_path, monkeypatch):
    from local_backend import pipeline, transcription
    app, store, _ = setup(tmp_path)
    store.settings.azure_speech_key = ''
    store.settings.azure_speech_region = ''
    def unexpected(*args, **kwargs):
        raise AssertionError('Explicit no dialogue must not call media probing or Speech recognition.')
    monkeypatch.setattr(pipeline, 'probe_media', unexpected)
    monkeypatch.setattr(transcription, 'transcribe_audio', unexpected)
    with TestClient(app) as client:
        assert client.post('/api/videos/old/transcript/calibrate', json={'language': 'auto', 'revision': 0}).status_code == 503
        started = client.post('/api/videos/old/transcript/calibrate', json={'language': 'none', 'revision': 0})
        assert started.status_code == 200
        saved = client.get('/api/videos/old/transcript').json()
        assert saved['cues'] == [] and saved['revision'] == 1
        assert saved['language'] == saved['dialogue_language'] == 'none'
        assert saved['dialogue_status'] == 'no_speech' and saved['dialogue_reason'] == 'user_declared_no_dialogue'
        # Sending altered read-only metadata cannot relabel the source status.
        submitted = {**saved, 'dialogue_status': 'recognized', 'dialogue_reason': 'recognized'}
        result = client.put('/api/videos/old/transcript', json=submitted)
        assert result.status_code == 200
        assert result.json()['dialogue_status'] == 'no_speech'
        assert result.json()['dialogue_reason'] == 'user_declared_no_dialogue'


def test_no_audio_calibration_records_verified_empty_metadata(tmp_path, monkeypatch):
    from local_backend import pipeline, transcription
    monkeypatch.setattr(pipeline, 'probe_media', lambda *args: {'has_audio': False})
    monkeypatch.setattr(transcription, 'transcribe_audio', lambda *args: (_ for _ in ()).throw(AssertionError('No ASR for no audio')))
    result = calibration.calibrate_audio(tmp_path / 'video.mp4', tmp_path / 'work', Settings())
    assert result['dialogue_status'] == 'no_speech' and result['dialogue_reason'] == 'no_audio_track'


def test_calibration_preserves_distinct_overlapping_speakers_and_quality(tmp_path, monkeypatch):
    app, store, _ = setup(tmp_path)
    recognized = {'language': 'zh-CN', 'cues': [
        {'id': 'a', 'start': 1, 'end': 4, 'text': '等一下！', 'speaker': 'speaker_1', 'low_confidence': True},
        {'id': 'b', 'start': 2, 'end': 3, 'text': '怎么了？', 'speaker': 'speaker_2'}],
        'quality': {'speaker_count': 2, 'diarization_available': True, 'overlapping_utterance_count': 1}}
    monkeypatch.setattr(calibration, 'calibrate_audio', lambda *args: recognized)
    with TestClient(app) as client:
        started = client.post('/api/videos/old/transcript/calibrate', json={'language': 'zh-CN', 'revision': 0}).json()
        task = client.get('/api/transcript-calibrations/' + started['calibration_id']).json()
        assert task['status'] == 'SUCCEEDED'
        saved = client.get('/api/videos/old/transcript').json()
        assert [cue['text'] for cue in saved['cues']] == ['等一下', '怎么了']
        assert [cue['speaker'] for cue in saved['cues']] == ['speaker_1', 'speaker_2']
        assert saved['cues'][0]['low_confidence'] is True and saved['quality'] == recognized['quality']
    assert not store.busy.locked()
