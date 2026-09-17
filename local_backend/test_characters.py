"""Character cards remain user-curated, video-scoped, and failure-safe."""
import copy
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from local_backend import characters
from local_backend.config import Settings
from local_backend.main import Store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path)
    store = Store(settings)
    store.data['inputs'].update({
        'video': {'filename': 'source.mp4', 'duration': 10, 'collection_id': 'collection'},
        'other': {'filename': 'other.mp4', 'duration': 10}})
    store.data['collections'] = {'collection': {'title': 'Project'}}
    store.data['executions'].update({
        'job': {'video_id': 'video', 'status': 'SUCCEEDED', 'result': {'segments': [{'segment_index': 2}]}},
        'other-job': {'video_id': 'other', 'status': 'SUCCEEDED', 'result': {'segments': [{'segment_index': 2}]}}})
    store.save()

    def evidence(store, job_id, segment_index, settings):
        # Real evidence helper locks internally; our callers must not hold it.
        assert store.lock.acquire(blocking=False), 'nested evidence lock'
        store.lock.release()
        if segment_index != 2:
            raise HTTPException(404, 'Segment not found')
        return {'segment_index': 2, 'frames': [
            {'frame_id': 'f0', 'timestamp': 1.25, 'url': f'/api/videos/{job_id}/segments/2/evidence/frames/f0'},
            {'frame_id': 'r0', 'timestamp': 1.3, 'url': f'/api/videos/{job_id}/segments/2/evidence/frames/r0'}]}
    monkeypatch.setattr(characters, 'get_evidence_document', evidence)
    app = FastAPI()
    characters.register_character_routes(app, store, settings)
    with TestClient(app) as client:
        yield client, store, settings


def card(**overrides):
    result = {'id': '', 'appearance': '蓝色夹克，短发', 'preferred_name': '',
              'status': 'unconfirmed', 'aliases': [],
              'thumbnail': {'job_id': 'job', 'segment_index': 2, 'frame_id': 'f0'},
              'occurrences': [{'job_id': 'job', 'segment_index': 2}]}
    result.update(overrides)
    return result


def test_empty_create_roundtrip_and_restart_persistence(workspace):
    client, store, settings = workspace
    assert client.get('/api/projects/video/characters').json() == {'revision': 0, 'characters': []}
    response = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [card()]})
    assert response.status_code == 200
    saved = response.json()
    created = saved['characters'][0]
    assert saved['revision'] == 1 and len(created['id']) == 32
    assert created['status'] == 'unconfirmed'
    assert created['thumbnail']['timestamp'] == 1.25
    assert created['thumbnail']['url'].startswith('/api/')
    assert client.get('/api/projects/video/characters').json() == saved
    again = client.put('/api/projects/video/characters', json=saved).json()
    assert again['revision'] == 2
    assert again['characters'][0]['id'] == created['id']
    restarted = Store(settings)
    assert restarted.data['inputs']['video']['character_cards']['revision'] == 2
    assert restarted.data['inputs']['video']['updated_at']
    thumb = restarted.data['inputs']['video']['character_cards']['characters'][0]['thumbnail']
    assert thumb == {'job_id': 'job', 'segment_index': 2, 'frame_id': 'f0'}


def test_confirmed_context_excludes_unconfirmed_and_is_a_copy(workspace):
    client, store, _ = workspace
    saved = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [
        card(), card(status='confirmed', preferred_name='林同学', aliases=['短发青年'])]}).json()
    context = characters.confirmed_character_context(store, 'video')
    assert context == [{key: saved['characters'][1][key] for key in ('id', 'appearance', 'preferred_name', 'aliases')}]
    context[0]['aliases'].append('Changed externally')
    assert 'Changed externally' not in characters.confirmed_character_context(store, 'video')[0]['aliases']
    assert all(key not in context[0] for key in ('thumbnail', 'occurrences', 'status'))


def test_rename_preserves_previous_name_without_replacing_narration(workspace):
    client, store, _ = workspace
    store.data['executions']['job']['result'] = {'segments': [{'segment_index': 2, 'description': '林同学走到门口。'}]}
    saved = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [
        card(status='confirmed', preferred_name='林同学')]}).json()
    saved['characters'][0]['preferred_name'] = '小林'
    renamed = client.put('/api/projects/video/characters', json=saved).json()
    assert renamed['characters'][0]['aliases'] == ['林同学']
    assert renamed['characters'][0]['id'] == saved['characters'][0]['id']
    assert store.data['executions']['job']['result']['segments'][0]['description'] == '林同学走到门口。'


def test_thumbnail_does_not_invent_occurrences_and_fields_are_server_resolved(workspace):
    client, _, _ = workspace
    thumb = {'job_id': 'job', 'segment_index': 2, 'frame_id': 'r0',
             'timestamp': 999, 'url': 'https://untrusted.example/image'}
    saved = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [
        card(thumbnail=thumb, occurrences=[])]}).json()['characters'][0]
    assert saved['occurrences'] == []
    assert saved['thumbnail']['timestamp'] == 1.3
    assert saved['thumbnail']['url'].startswith('/api/videos/job/')


@pytest.mark.parametrize('change', [
    {'thumbnail': {'job_id': 'other-job', 'segment_index': 2, 'frame_id': 'f0'}},
    {'thumbnail': {'job_id': 'job', 'segment_index': 2, 'frame_id': 'missing'}},
    {'thumbnail': {'job_id': 'job', 'segment_index': 999, 'frame_id': 'f0'}},
    {'thumbnail': {'job_id': '../job', 'segment_index': 2, 'frame_id': 'f0'}},
    {'occurrences': [{'job_id': 'other-job', 'segment_index': 2}]},
    {'occurrences': [{'job_id': 'job', 'segment_index': 999}]},
    {'id': 'invented-id'}, {'status': 'confirmed'},
    {'appearance': 'x' * 601}, {'preferred_name': 'x' * 101}, {'aliases': ['x' * 101]},
    {'aliases': ['']}, {'aliases': ['x'] * 21},
])
def test_invalid_cards_are_rejected_without_writes(workspace, change):
    client, store, _ = workspace
    before = (store.root / 'index.json').read_bytes()
    response = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [card(**change)]})
    assert response.status_code == 422
    assert (store.root / 'index.json').read_bytes() == before
    assert 'character_cards' not in store.data['inputs']['video']


def test_revision_conflict_and_duplicate_ids_preserve_document(workspace):
    client, _, _ = workspace
    saved = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [card()]}).json()
    assert client.put('/api/projects/video/characters', json={'revision': 0, 'characters': []}).status_code == 409
    duplicate = {'revision': 1, 'characters': saved['characters'] * 2}
    assert client.put('/api/projects/video/characters', json=duplicate).status_code == 422
    assert client.get('/api/projects/video/characters').json() == saved


@pytest.mark.parametrize('state,status', [('deleted', 404), ('archived', 409), ('running', 409),
                                         ('collection-deleted', 404), ('busy', 409)])
def test_lifecycle_and_busy_are_checked(workspace, state, status):
    client, store, _ = workspace
    if state == 'running':
        store.data['executions']['job']['status'] = 'RUNNING'
    elif state == 'collection-deleted':
        store.data['collections']['collection']['deleted'] = True
    elif state == 'busy':
        store.busy.acquire()
    else:
        store.data['inputs']['video'][state] = True
    try:
        response = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [card()]})
        assert response.status_code == status
        assert client.get('/api/projects/video/characters').status_code == (404 if status == 404 else 200)
    finally:
        if state == 'busy':
            store.busy.release()


def test_revision_is_rechecked_after_evidence_resolution(workspace, monkeypatch):
    client, store, _ = workspace
    original = characters.get_evidence_document
    def competing(*args):
        result = original(*args)
        store.data['inputs']['video']['character_cards'] = {'revision': 1, 'characters': []}
        return result
    monkeypatch.setattr(characters, 'get_evidence_document', competing)
    response = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [card()]})
    assert response.status_code == 409
    assert store.data['inputs']['video']['character_cards'] == {'revision': 1, 'characters': []}


def test_atomic_replace_failure_preserves_disk_memory_and_revision(workspace, monkeypatch):
    client, store, _ = workspace
    saved = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [card()]}).json()
    disk_before = (store.root / 'index.json').read_bytes()
    memory_before = copy.deepcopy(store.data)
    original = Path.replace
    def fail_replace(self, target):
        if self.name == 'index.json.tmp':
            raise OSError('Disk unavailable')
        return original(self, target)
    monkeypatch.setattr(Path, 'replace', fail_replace)
    saved['characters'][0]['appearance'] = '红色外套'
    response = client.put('/api/projects/video/characters', json=saved)
    assert response.status_code == 500
    assert store.data == memory_before
    assert (store.root / 'index.json').read_bytes() == disk_before
    assert client.get('/api/projects/video/characters').json()['revision'] == 1


def test_full_document_can_remove_card_without_touching_video(workspace):
    client, store, _ = workspace
    client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [card()]})
    removed = client.put('/api/projects/video/characters', json={'revision': 1, 'characters': []})
    assert removed.json() == {'revision': 2, 'characters': []}
    assert store.data['inputs']['video']['filename'] == 'source.mp4'
    assert 'job' in store.data['executions']


def test_real_evidence_helper_resolves_saved_frame_contract(workspace, monkeypatch):
    from local_backend import evidence
    client, store, _ = workspace
    frame_dir = store.root / 'runs' / 'job' / 'frames'
    frame_dir.mkdir(parents=True)
    (frame_dir / 'segment-002-0.jpg').write_bytes(b'cached-test-frame')
    store.data['executions']['job'].update(result={'segments': [{
        'segment_index': 2, 'start_time': 1, 'end_time': 2, 'frame_timestamps': [1.25],
        'visual_evidence': [{'fact': 'Blue jacket.', 'frame_timestamps': [1.25]}]}]})
    monkeypatch.setattr(characters, 'get_evidence_document', evidence.get_evidence_document)
    response = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [card()]})
    assert response.status_code == 200
    assert response.json()['characters'][0]['thumbnail'] == {
        'job_id': 'job', 'segment_index': 2, 'frame_id': 'f0', 'timestamp': 1.25,
        'url': '/api/videos/job/segments/2/frames/f0'}


def test_confirmed_context_can_be_read_after_processing_lock_is_acquired(workspace):
    client, store, _ = workspace
    client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [
        card(status='confirmed', preferred_name='林同学')]})
    store.busy.acquire()
    try:
        assert characters.confirmed_character_context(store, 'video')[0]['preferred_name'] == '林同学'
    finally:
        store.busy.release()


def test_occurrences_are_validated_without_extracting_any_frames(workspace, monkeypatch):
    client, store, _ = workspace
    store.data['executions']['job']['result']['segments'] = [{'segment_index': index} for index in range(200)]
    def unexpected_extraction(*args):
        raise AssertionError('Occurrence validation must not resolve image assets')
    monkeypatch.setattr(characters, 'get_evidence_document', unexpected_extraction)
    response = client.put('/api/projects/video/characters', json={'revision': 0, 'characters': [
        card(thumbnail=None, occurrences=[{'job_id': 'job', 'segment_index': index} for index in range(200)])]})
    assert response.status_code == 200
    assert len(response.json()['characters'][0]['occurrences']) == 200
    assert client.get('/api/projects/video/characters').status_code == 200
