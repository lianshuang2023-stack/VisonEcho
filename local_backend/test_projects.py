"""Project and transcript contracts, isolated from cloud services."""
import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from local_backend.config import Settings
from local_backend.main import create_app
from local_backend.projects import register_project_routes


@pytest.fixture
def workspace(tmp_path):
    settings = Settings(data_dir=tmp_path / 'data', azure_openai_api_key='test-project-secret')
    app = create_app(settings)
    store = app.state.store
    if not any(getattr(route, 'path', '') == '/api/projects' for route in app.routes):
        register_project_routes(app, store, settings)
    store.data['inputs'].update({
        'video-one': {'video_id': 'video-one', 'filename': 'Original video.mp4', 'duration': 20,
                      'size_mb': 1.5, 'last_modified': '2026-09-10T00:00:00+00:00'},
        'video-two': {'video_id': 'video-two', 'filename': '第二个视频.mp4', 'duration': 10,
                      'size_mb': 2, 'last_modified': '2026-09-11T00:00:00+00:00'},
    })
    directory = store.root / 'runs' / 'result-one'
    directory.mkdir()
    transcript = directory / 'transcript.json'
    transcript.write_text(json.dumps({'phrases': [
        {'start': 0.5, 'end': 2.75, 'text': 'Original dialogue.'},
        {'start': 5, 'end': 7, 'text': 'Another phrase.'},
    ]}), encoding='utf-8')
    store.data['executions']['result-one'] = {
        'execution_arn': 'result-one', 'video_id': 'video-one', 'status': 'SUCCEEDED',
        'start_date': '2026-09-12T00:00:00+00:00', 'stop_date': '2026-09-12T00:01:00+00:00',
        'steps': [], 'result': {'transcript_path': str(transcript), 'output_path': str(directory / 'result.mp4'),
                               'segments': [
                                   {'segment_index': 0, 'start_time': 8.1, 'end_time': 11.2,
                                    'silence_duration': 3.1, 'dvi_text': 'A blue circle moves.', 'pass': True},
                                   {'segment_index': 1, 'start_time': 12, 'end_time': 15,
                                    'silence_duration': 3, 'dvi_text': 'Skipped narration.', 'pass': False},
                               ]},
    }
    store.data['outputs']['result-one'] = {'filename': 'described.mp4'}
    store.save()
    with TestClient(app) as client:
        yield client, store, settings


def test_old_projects_aggregate_versions_and_keep_previous_result_after_failure(workspace):
    client, store, settings = workspace
    with store.lock:
        store.data['executions']['retry'] = {
            'execution_arn': 'retry', 'video_id': 'video-one', 'status': 'FAILED',
            'start_date': '2026-09-13T00:00:00+00:00', 'stop_date': None, 'steps': [],
            'cause': 'Provider failed: ' + settings.azure_openai_api_key,
            'kind': 'render', 'source_execution_id': 'result-one',
        }
    rows = client.get('/api/projects').json()['projects']
    assert rows[0]['title'] == 'Original video'
    assert rows[0]['status'] == 'failed'
    assert rows[0]['latest_execution_id'] == 'retry'
    assert rows[0]['latest_result_id'] == 'result-one'
    assert rows[0]['execution_count'] == 2
    detail = client.get('/api/projects/video-one')
    assert settings.azure_openai_api_key not in detail.text
    assert 'transcript_path' not in detail.text and 'output_path' not in detail.text
    assert detail.json()['executions'][0]['kind'] == 'render'
    assert detail.json()['latest_result_id'] == 'result-one'
    assert client.get('/api/projects', params={'status': 'draft'}).json()['projects'][0]['video_id'] == 'video-two'


def test_rename_archive_restore_and_search_persist_without_changing_original_filename(workspace):
    client, store, _ = workspace
    response = client.patch('/api/projects/video-one', json={'title': '  My  edited title  ', 'archived': True})
    assert response.status_code == 200
    assert response.json()['title'] == 'My edited title'
    assert response.json()['filename'] == 'Original video.mp4'
    assert [row['video_id'] for row in client.get('/api/projects').json()['projects']] == ['video-two']
    assert client.get('/api/projects', params={'search': 'EDITED', 'status': 'archived'}).json()['projects'][0]['video_id'] == 'video-one'
    persisted = json.loads((store.root / 'index.json').read_text())
    assert persisted['inputs']['video-one']['archived'] is True
    assert client.patch('/api/projects/video-one', json={'archived': False}).json()['archived'] is False
    assert len(client.get('/api/projects', params={'search': 'original'}).json()['projects']) == 1


@pytest.mark.parametrize('payload', [{}, {'title': '  '}, {'title': None}, {'archived': 'false'}, {'filename': 'changed.mp4'}])
def test_invalid_project_updates_leave_metadata_unchanged(workspace, payload):
    client, store, _ = workspace
    before = copy.deepcopy(store.data['inputs'])
    assert client.patch('/api/projects/video-one', json=payload).status_code == 422
    assert store.data['inputs'] == before


def test_project_save_failure_rolls_back_memory(workspace, monkeypatch):
    client, store, _ = workspace
    before = copy.deepcopy(store.data['inputs'])
    def fail():
        raise OSError('Disk full')
    monkeypatch.setattr(store, 'save', fail)
    assert client.patch('/api/projects/video-one', json={'title': 'Renamed'}).status_code == 500
    assert store.data['inputs'] == before


def approve_export_fixture(client, store):
    result = store.data['executions']['result-one']['result']
    Path(result['output_path']).write_bytes(b'test export')
    result['segments'][0]['audio_duration'] = 2
    # Export formatting is tested with a completed rendition containing a
    # single voiced segment. Failed/empty windows are covered by review tests.
    result['segments'] = result['segments'][:1]
    current = client.get('/api/videos/result-one/review-state').json()
    approved = client.put('/api/videos/result-one/review-state', json={
        'revision': current['revision'], 'transcript_revision': current['transcript_revision'],
        'changes': [{'segment_index': 0, 'state': 'approved'}]})
    assert approved.status_code == 200 and approved.json()['can_export']


def test_transcript_edit_revision_conflicts_and_exports_use_saved_text(workspace):
    client, store, _ = workspace
    original = client.get('/api/videos/result-one/transcript').json()
    assert original['revision'] == 0 and original['cues'][0]['id'] == 'cue-1'
    original['cues'][0].update(text='Reviewed dialogue & <literal>.', start=1, end=2.5)
    saved = client.put('/api/videos/result-one/transcript', json=original)
    assert saved.status_code == 200 and saved.json()['revision'] == 1
    assert client.put('/api/videos/result-one/transcript', json=original).status_code == 409
    draft = json.loads((store.root / 'runs/result-one/transcript-edits.json').read_text())
    assert draft == saved.json()
    assert client.get('/api/videos/result-one/transcript').json() == saved.json()
    approve_export_fixture(client, store)
    srt = client.get('/api/videos/result-one/export?kind=dialogue&format=srt')
    assert '00:00:01,000 --> 00:00:02,500\nReviewed dialogue &lt;literal&gt;' in srt.text
    assert '\n\n2\n' in srt.text
    assert srt.headers['content-disposition'].startswith('attachment;')
    vtt = client.get('/api/videos/result-one/export?kind=dialogue&format=vtt')
    assert vtt.text.startswith('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n')
    txt = client.get('/api/videos/result-one/export?kind=dialogue&format=txt')
    assert 'Reviewed dialogue <literal>' in txt.text
    assert 'Original dialogue.' not in txt.text


def test_clear_all_subtitles_is_saved_and_exported_as_empty(workspace):
    client, store, _ = workspace
    response = client.put('/api/videos/result-one/transcript', json={'revision': 0, 'cues': []})
    assert response.status_code == 200
    assert response.json() == {'revision': 1, 'cues': []}
    approve_export_fixture(client, store)
    assert client.get('/api/videos/result-one/export?format=srt').text == ''
    assert client.get('/api/videos/result-one/export?format=vtt').text == 'WEBVTT\n\n'


@pytest.mark.parametrize('cues', [
    [{'id': '1', 'start': 2, 'end': 1, 'text': 'Backwards'}],
    [{'id': '1', 'start': -1, 'end': 1, 'text': 'Negative'}],
    [{'id': '1', 'start': 0, 'end': 20.1, 'text': 'Too late'}],
    [{'id': '1', 'start': 0, 'end': 1, 'text': ' '}],
    [{'id': '1', 'start': 0, 'end': 2, 'text': 'One'}, {'id': '2', 'start': 1, 'end': 3, 'text': 'Overlap'}],
    [{'id': '1', 'start': 0, 'end': 1, 'text': 'One'}, {'id': '1', 'start': 2, 'end': 3, 'text': 'Duplicate'}],
    [{'id': '1', 'start': 4, 'end': 5, 'text': 'One'}, {'id': '2', 'start': 2, 'end': 3, 'text': 'Unordered'}],
])
def test_invalid_subtitle_timelines_are_rejected_without_creating_drafts(workspace, cues):
    client, store, _ = workspace
    assert client.put('/api/videos/result-one/transcript', json={'revision': 0, 'cues': cues}).status_code == 422
    assert not (store.root / 'runs/result-one/transcript-edits.json').exists()


def test_description_export_keeps_absolute_timing_and_excludes_skipped_text(workspace):
    client, store, _ = workspace
    approve_export_fixture(client, store)
    response = client.get('/api/videos/result-one/export?kind=description&format=srt')
    assert '00:00:08,100 --> 00:00:11,200' in response.text
    assert 'A blue circle moves.' in response.text
    assert 'Skipped narration.' not in response.text


def test_transcript_words_fallback_and_inherited_revision(workspace):
    client, store, _ = workspace
    path = Path(store.data['executions']['result-one']['result']['transcript_path'])
    path.write_text(json.dumps({'words': [
        {'start': 1, 'end': 1.4, 'text': 'Hello'}, {'start': 1.5, 'end': 2, 'text': 'there.'},
        {'start': 4, 'end': 5, 'text': 'Welcome.'},
    ]}))
    response = client.get('/api/videos/result-one/transcript').json()
    assert len(response['cues']) == 2
    assert response['cues'][0]['text'] == 'Hello there'
    draft = {'revision': 7, 'cues': response['cues']}
    path.with_name('transcript-edits.json').write_text(json.dumps(draft))
    assert client.get('/api/videos/result-one/transcript').json()['revision'] == 7
    assert client.put('/api/videos/result-one/transcript', json=draft).json()['revision'] == 8


def test_transcript_paths_are_bound_to_indexed_successful_result(workspace, tmp_path):
    client, store, _ = workspace
    outside = tmp_path / 'private.json'
    outside.write_text(json.dumps({'phrases': [{'text': 'private', 'start': 0, 'end': 1}]}))
    store.data['executions']['result-one']['result']['transcript_path'] = str(outside)
    assert client.get('/api/videos/result-one/transcript').status_code == 404
    (store.root / 'runs' / 'unindexed').mkdir()
    (store.root / 'runs/unindexed/transcript-edits.json').write_text('{"revision": 1,"cues": []}')
    assert client.get('/api/videos/unindexed/transcript').status_code == 404
    store.data['executions']['result-one']['status'] = 'RUNNING'
    assert client.get('/api/videos/result-one/transcript').status_code == 409
    assert client.get('/api/projects/missing').status_code == 404


def test_thumbnail_is_local_cached_and_requires_indexed_source(workspace, monkeypatch):
    client, store, _ = workspace
    (store.root / 'input/video-one.mp4').write_bytes(b'video')
    calls = []
    def ffmpeg(command, **kwargs):
        calls.append(command)
        Path(command[-1]).write_bytes(b'\xff\xd8fake-jpeg\xff\xd9')
    monkeypatch.setattr('local_backend.projects.subprocess.run', ffmpeg)
    response = client.get('/api/projects/video-one/thumbnail')
    assert response.status_code == 200 and response.headers['content-type'] == 'image/jpeg'
    assert client.get('/api/projects/video-one/thumbnail').content == response.content
    assert len(calls) == 1
    assert '-protocol_whitelist' in calls[0]
    assert client.get('/api/projects/not-indexed/thumbnail').status_code == 404
    assert client.get('/api/projects/video-two/thumbnail').status_code == 404


def test_cross_origin_edits_still_use_local_api_boundary(workspace):
    client, _, _ = workspace
    response = client.patch('/api/projects/video-one', json={'title': 'Bad origin'},
                            headers={'Origin': 'https://other.example'})
    assert response.status_code == 403


def test_legacy_machine_subtitles_refresh_without_rewriting_source_or_saved_edits(workspace):
    from local_backend.transcription import CUE_FORMAT_VERSION
    client, store, _ = workspace
    path = Path(store.data['executions']['result-one']['result']['transcript_path'])
    payload = {
        'language': 'en-US', 'timing_source': 'azure_speech_continuous',
        'quality': {'review_required': True, 'low_confidence_phrase_count': 1, 'private_provider_key': 'hidden'},
        'phrases': [{'start': 1, 'end': 3, 'text': 'Hello, world!'}],
        'words': [{'start': 1, 'end': 1.8, 'text': 'hello'}, {'start': 2, 'end': 3, 'text': 'world'}],
        'cues': [{'id': 'old', 'start': 1, 'end': 3, 'text': 'hello world'}],
    }
    path.write_text(json.dumps(payload))
    original = path.read_bytes()
    response = client.get('/api/videos/result-one/transcript').json()
    assert response['cues'][0]['text'] == 'Hello world'
    assert response['language'] == 'en-US'
    assert response['quality'] == {'review_required': True, 'low_confidence_phrase_count': 1}
    assert path.read_bytes() == original
    # A current-format cue is already authoritative.
    payload['cue_format_version'] = CUE_FORMAT_VERSION
    path.write_text(json.dumps(payload))
    assert client.get('/api/videos/result-one/transcript').json()['cues'] == payload['cues']
    # User-edited captions always take precedence, even over a stale machine cache.
    payload.pop('cue_format_version')
    path.write_text(json.dumps(payload))
    draft = {'revision': 2, 'cues': [{'id': 'manual', 'start': 1, 'end': 3, 'text': 'Manual text.'}]}
    (path.parent / 'transcript-edits.json').write_text(json.dumps(draft))
    assert client.get('/api/videos/result-one/transcript').json() == {**draft, 'cues': [{**draft['cues'][0], 'text': 'Manual text'}]}


@pytest.mark.parametrize('signal', ['low_confidence_word_count', 'low_confidence_phrase_count', 'no_match_count'])
def test_legacy_recognition_quality_requests_review_from_existing_signals(workspace, signal):
    client, store, _ = workspace
    path = Path(store.data['executions']['result-one']['result']['transcript_path'])
    payload = json.loads(path.read_text())
    payload['quality'] = {signal: 1}
    path.write_text(json.dumps(payload))
    assert client.get('/api/videos/result-one/transcript').json()['quality'] == {signal: 1, 'review_required': True}
    assert 'review_required' not in json.loads(path.read_text())['quality']
