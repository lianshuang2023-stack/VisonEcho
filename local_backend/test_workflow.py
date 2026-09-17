"""Workspace organization and human review state, without cloud calls."""
import copy
import json

import pytest
from fastapi.testclient import TestClient

from local_backend.config import Settings
from local_backend.main import create_app
from local_backend.projects import _project_record, _review_state


@pytest.fixture
def workspace(tmp_path):
    settings = Settings(data_dir=tmp_path / 'data', azure_openai_api_key='workflow-test-secret')
    app = create_app(settings)
    store = app.state.store
    store.data['collections']['another'] = {
        'id': 'another', 'title': '旅行作品', 'created_at': '2026-09-01', 'updated_at': '2026-09-01',
    }
    store.data['inputs']['video'] = {
        'video_id': 'video', 'filename': 'original.mp4', 'collection_id': 'default',
        'duration': 12, 'created_at': '2026-09-01', 'updated_at': '2026-09-01',
    }
    (store.root / 'input/video.mp4').write_bytes(b'original video')
    run = store.root / 'runs/result'
    run.mkdir()
    (run / 'transcript.json').write_text(json.dumps({'phrases': [
        {'start': 1, 'end': 3, 'text': 'Original dialogue.'},
    ]}))
    (run / 'output.mp4').write_bytes(b'original described output')
    store.data['executions']['result'] = {
        'execution_arn': 'result', 'video_id': 'video', 'status': 'SUCCEEDED',
        'start_date': '2026-09-02', 'stop_date': '2026-09-03', 'steps': [],
        'result': {'transcript_path': str(run / 'transcript.json'),
                   'output_path': str(run / 'output.mp4'), 'segments': []},
    }
    store.data['outputs']['result'] = {'filename': 'original-described.mp4'}
    store.save()
    with TestClient(app) as client:
        yield client, store, settings


def test_move_updates_membership_and_keeps_history_and_media(workspace):
    client, store, _ = workspace
    jobs, outputs = copy.deepcopy(store.data['executions']), copy.deepcopy(store.data['outputs'])
    files = {path.relative_to(store.root): path.read_bytes() for path in store.root.rglob('*')
             if path.is_file() and path.name != 'index.json'}
    response = client.patch('/api/projects/video', json={'collection_id': 'another'})
    assert response.status_code == 200
    assert response.json()['collection_id'] == 'another'
    assert response.json()['collection_title'] == '旅行作品'
    assert response.json()['latest_result_id'] == 'result'
    assert client.get('/api/projects?collection_id=default').json()['projects'] == []
    assert client.get('/api/projects', params={'search': '旅行'}).json()['projects'][0]['video_id'] == 'video'
    persisted = json.loads((store.root / 'index.json').read_text())
    assert persisted['inputs']['video']['collection_id'] == 'another'
    assert persisted['collections']['another']['updated_at'] == persisted['collections']['default']['updated_at']
    assert persisted['collections']['another']['updated_at'] != '2026-09-01'
    assert store.data['executions'] == jobs and store.data['outputs'] == outputs
    assert files == {path.relative_to(store.root): path.read_bytes() for path in store.root.rglob('*')
                     if path.is_file() and path.name != 'index.json'}


@pytest.mark.parametrize('target_state', ['missing', 'deleted', 'deleted_at'])
def test_move_requires_visible_target_without_changing_source(workspace, target_state):
    client, store, _ = workspace
    if target_state == 'missing':
        store.data['collections'].pop('another')
    else:
        store.data['collections']['another'][target_state] = True
    before = copy.deepcopy(store.data)
    assert client.patch('/api/projects/video', json={'collection_id': 'another'}).status_code == 404
    assert store.data == before


@pytest.mark.parametrize('hidden_source', ['video', 'collection', 'missing_collection'])
def test_move_does_not_rescue_hidden_or_orphaned_source(workspace, hidden_source):
    client, store, _ = workspace
    if hidden_source == 'video':
        store.data['inputs']['video']['deleted'] = True
    elif hidden_source == 'collection':
        store.data['collections']['default']['deleted'] = True
    else:
        store.data['collections'].pop('default')
    before = copy.deepcopy(store.data)
    assert client.patch('/api/projects/video', json={'collection_id': 'another'}).status_code == 404
    assert store.data == before


@pytest.mark.parametrize('busy', ['generation', 'calibration'])
def test_move_rejects_running_generation_and_calibration(workspace, busy):
    client, store, _ = workspace
    if busy == 'generation':
        store.data['executions']['running'] = {'video_id': 'video', 'status': 'RUNNING'}
    else:
        store.data['calibrations'] = {'task': {'job_id': 'result', 'status': 'RUNNING'}}
    before = copy.deepcopy(store.data)
    assert client.patch('/api/projects/video', json={'collection_id': 'another'}).status_code == 409
    assert store.data == before


def test_move_rename_archive_save_failure_rolls_back_whole_transaction(workspace, monkeypatch):
    client, store, _ = workspace
    before, persisted = copy.deepcopy(store.data), (store.root / 'index.json').read_bytes()
    def fail():
        raise OSError('Disk full')
    monkeypatch.setattr(store, 'save', fail)
    response = client.patch('/api/projects/video', json={
        'collection_id': 'another', 'title': 'Moved title', 'archived': True,
    })
    assert response.status_code == 500
    assert store.data == before
    assert (store.root / 'index.json').read_bytes() == persisted


def test_review_toggle_tracks_revision_and_persists_to_latest_project(workspace):
    client, store, _ = workspace
    initial = client.get('/api/projects/video').json()['project']
    assert initial['workflow_status'] == 'review' and initial['reviewed'] is False
    response = client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 0})
    assert response.status_code == 200
    assert response.json()['reviewed'] is True and response.json()['reviewed_at']
    assert response.json()['transcript_revision'] == 0
    saved = json.loads((store.root / 'index.json').read_text())['executions']['result']
    assert saved['reviewed_transcript_revision'] == 0 and saved['reviewed'] is True
    reviewed = client.get('/api/projects/video').json()['project']
    assert reviewed['workflow_status'] == 'exportable' and reviewed['status'] == 'ready'
    response = client.post('/api/videos/result/review', json={'reviewed': False})
    assert response.json() == {'reviewed': False, 'reviewed_at': None, 'transcript_revision': 0}
    assert client.get('/api/projects/video').json()['project']['workflow_status'] == 'review'


def test_review_rejects_missing_or_stale_subtitle_revision(workspace):
    client, store, _ = workspace
    before = copy.deepcopy(store.data)
    assert client.post('/api/videos/result/review', json={'reviewed': True}).status_code == 422
    assert client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 2}).status_code == 409
    assert store.data == before


@pytest.mark.parametrize(('case', 'status'), [
    ('failed', 409), ('running', 409), ('empty_result', 409), ('missing', 404),
    ('deleted_video', 404), ('deleted_collection', 404), ('calibration', 409),
])
def test_review_requires_completed_visible_idle_result(workspace, case, status):
    client, store, _ = workspace
    job = store.data['executions']['result']
    if case in ('failed', 'running'):
        job['status'] = case.upper()
    elif case == 'empty_result':
        job['result'] = {}
    elif case == 'missing':
        store.data['executions'].pop('result')
    elif case == 'deleted_video':
        store.data['inputs']['video']['deleted'] = True
    elif case == 'deleted_collection':
        store.data['collections']['default']['deleted'] = True
    else:
        store.data['calibrations'] = {'task': {'job_id': 'result', 'status': 'RUNNING'}}
    before = copy.deepcopy(store.data)
    assert client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 0}).status_code == status
    assert store.data == before


def test_subtitle_save_invalidates_review_and_old_confirmation(workspace):
    client, store, _ = workspace
    assert client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 0}).status_code == 200
    transcript = client.get('/api/videos/result/transcript').json()
    transcript['cues'][0]['text'] = 'Corrected dialogue.'
    saved = client.put('/api/videos/result/transcript', json=transcript)
    assert saved.status_code == 200 and saved.json()['revision'] == 1
    assert client.get('/api/projects/video').json()['project']['workflow_status'] == 'review'
    job = json.loads((store.root / 'index.json').read_text())['executions']['result']
    assert job['reviewed'] is False and job['transcript_revision'] == 1
    assert 'reviewed_at' not in job and 'reviewed_transcript_revision' not in job
    assert client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 0}).status_code == 409
    assert client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 1}).status_code == 200
    assert client.get('/api/projects/video').json()['project']['workflow_status'] == 'exportable'


def test_review_and_subtitle_save_failures_preserve_saved_state(workspace, monkeypatch):
    client, store, _ = workspace
    transcript = client.get('/api/videos/result/transcript').json()
    before = copy.deepcopy(store.data)
    def fail():
        raise OSError('Disk full')
    monkeypatch.setattr(store, 'save', fail)
    assert client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 0}).status_code == 500
    assert store.data == before
    transcript['cues'][0]['text'] = 'Unsaved edit.'
    assert client.put('/api/videos/result/transcript', json=transcript).status_code == 500
    assert store.data == before
    assert not (store.root / 'runs/result/transcript-edits.json').exists()
    assert client.get('/api/videos/result/transcript').json()['cues'][0]['text'] == 'Original dialogue.'


def test_review_state_checks_actual_saved_revision_and_supports_legacy_missing_transcript(workspace):
    client, store, _ = workspace
    assert client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 0}).status_code == 200
    draft = store.root / 'runs/result/transcript-edits.json'
    draft.write_text(json.dumps({'revision': 8, 'cues': []}))
    with store.lock:
        assert _review_state(store, 'result') == {'reviewed': False, 'reviewed_at': None, 'transcript_revision': 8}
    # Lists use the indexed revision rather than reading one draft per card.
    store.data['executions']['result']['transcript_revision'] = 8
    assert client.get('/api/projects/video').json()['project']['workflow_status'] == 'review'
    draft.unlink()
    store.data['executions']['result']['result'].pop('transcript_path')
    response = client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 0})
    assert response.status_code == 200 and response.json()['transcript_revision'] == 0


@pytest.mark.parametrize(('latest_status', 'workflow'), [
    ('RUNNING', 'processing'), ('SUCCEEDED', 'review'), ('FAILED', 'failed'), ('ABORTED', 'failed'),
])
def test_new_version_never_inherits_old_review_or_hides_latest_failure(workspace, latest_status, workflow):
    client, store, settings = workspace
    assert client.post('/api/videos/result/review', json={'reviewed': True, 'transcript_revision': 0}).status_code == 200
    newer = {
        'execution_arn': 'newer', 'video_id': 'video', 'status': latest_status,
        'start_date': '2026-09-04', 'stop_date': '2026-09-05', 'result': {'segments': []},
        'cause': 'Provider failed: ' + settings.azure_openai_api_key,
    }
    store.data['executions']['newer'] = newer
    response = client.get('/api/projects/video')
    project = response.json()['project']
    assert project['workflow_status'] == workflow and project['reviewed'] is False
    assert project['latest_execution_id'] == 'newer'
    assert project['latest_result_id'] == ('newer' if latest_status == 'SUCCEEDED' else 'result')
    assert settings.azure_openai_api_key not in response.text
    assert settings.azure_openai_api_key not in client.get('/api/projects').text
    if workflow == 'failed':
        assert project['last_error'] == 'Provider failed: [REDACTED]'
        assert settings.azure_openai_api_key not in json.dumps(_project_record(store.data, 'video'))


def test_archival_is_separate_from_draft_workflow(workspace):
    client, store, _ = workspace
    store.data['executions'].clear()
    response = client.patch('/api/projects/video', json={'archived': True})
    assert response.json()['workflow_status'] == 'draft'
    assert response.json()['archived'] is True
    assert client.get('/api/projects').json()['projects'] == []
    assert client.get('/api/projects?status=archived').json()['projects'][0]['workflow_status'] == 'draft'
