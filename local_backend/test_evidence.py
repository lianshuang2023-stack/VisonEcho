"""Visual-evidence provenance, source timing, lifecycle, and persistence."""
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from local_backend.config import Settings
from local_backend.evidence import get_evidence_document, register_evidence_routes
from local_backend.main import Store


@pytest.fixture
def workspace(tmp_path):
    settings = Settings(data_dir=tmp_path)
    store = Store(settings)
    store.data['collections'] = {'default': {'id': 'default'}}
    store.data['inputs']['video'] = {'filename': 'source.mp4', 'duration': 12, 'collection_id': 'default'}
    segment = {'segment_index': 0, 'start_time': 2, 'end_time': 6, 'dvi_text': 'A person opens a door.',
               'frame_timestamps': [2.5, 4, 5.5], 'visual_evidence': [
                   {'fact': 'A person opens a door.', 'frame_timestamps': [4, 5.5]}]}
    store.data['executions']['original'] = {'video_id': 'video', 'status': 'SUCCEEDED',
        'reviewed': True, 'reviewed_at': 'yesterday',
        'result': {'narration_mode': 'standard', 'segments': [segment]}}
    directory = tmp_path / 'runs/original/frames'
    directory.mkdir(parents=True)
    for index in range(3):
        (directory / f'segment-000-{index}.jpg').write_bytes(b'jpeg-' + str(index).encode())
    (tmp_path / 'input/video.mp4').write_bytes(b'synthetic source placeholder')
    store.save()
    app = FastAPI()
    register_evidence_routes(app, store, settings)
    with TestClient(app) as client:
        yield client, store, settings


def route(job='original', suffix='evidence', index=0):
    return f'/api/videos/{job}/segments/{index}/{suffix}'


def revision(store, text=None, job_id='revision'):
    source = deepcopy(store.data['executions']['original'])
    source['source_execution_id'] = 'original'
    source.pop('evidence_feedback', None)
    if text is not None:
        source['result']['segments'][0]['dvi_text'] = text
    store.data['executions'][job_id] = source
    return source


def fake_extraction(monkeypatch):
    from local_backend import pipeline
    calls = []

    def extract(input_path, directory, window, index, settings):
        calls.append((input_path, window, index))
        frames = []
        for ordinal, fraction in enumerate((.2, .5, .8)):
            path = directory / f'test-{ordinal}.jpg'
            path.write_bytes(b'review-' + str(ordinal).encode())
            frames.append({'path': path, 'timestamp': window['start_time'] + window['silence_duration'] * fraction})
        return frames

    monkeypatch.setattr(pipeline, '_extract_frames', extract)
    return calls


def test_saved_frames_and_facts_expose_only_public_references(workspace):
    client, store, settings = workspace
    document = client.get(route()).json()
    assert document == {
        'segment_index': 0, 'source_start': 2, 'source_end': 6, 'provenance': 'model',
        'frames': [{'id': f'f{i}', 'timestamp': timestamp, 'url': route(suffix=f'frames/f{i}')}
                   for i, timestamp in enumerate([2.5, 4, 5.5])],
        'observations': [{'fact': 'A person opens a door.', 'frame_ids': ['f1', 'f2']}],
        'feedback': {'revision': 0, 'issues': [], 'note': ''},
        'generation_reason': 'visual_context',
        'window_reason': 'dialogue_gap', 'nearby_dialogue': [],
    }
    assert str(store.root) not in json.dumps(document)
    assert get_evidence_document(store, 'original', 0, settings) == document
    response = client.get(document['frames'][1]['url'])
    assert response.content == b'jpeg-1'
    assert response.headers['content-type'] == 'image/jpeg'
    assert client.get(route(suffix='frames/f99')).status_code == 404
    assert client.get(route(suffix='frames/secret')).status_code == 404
    assert client.get(route(index=7)).status_code == 404


def test_revision_reuses_same_input_frames_but_new_text_drops_facts(workspace):
    client, store, _ = workspace
    edited = revision(store)
    document = client.get(route('revision')).json()
    assert document['provenance'] == 'model'
    assert document['observations']
    assert client.get(document['frames'][0]['url']).content == b'jpeg-0'
    edited['result']['segments'][0]['dvi_text'] = 'A person shuts a window.'
    document = client.get(route('revision')).json()
    assert document['provenance'] == 'review'
    assert document['observations'] == []
    assert document['frames'][0]['id'] == 'f0'


def test_explicit_evidence_text_cannot_validate_an_edited_segment(workspace):
    client, store, _ = workspace
    segment = store.data['executions']['original']['result']['segments'][0]
    segment['evidence_description'] = segment['dvi_text']
    segment['dvi_text'] = 'A revised description.'
    document = client.get(route()).json()
    assert document['provenance'] == 'review'
    assert document['observations'] == []


def test_unresolvable_facts_are_never_attached_to_arbitrary_frames(workspace):
    client, store, _ = workspace
    store.data['executions']['original']['result']['segments'][0]['visual_evidence'] += [
        {'fact': 'Wrong time.', 'frame_timestamps': [11]},
        {'fact': 'Partly missing.', 'frame_timestamps': [2.5, 11]},
        {'fact': 'Not finite.', 'frame_timestamps': [float('nan')]},
        {'fact': 'No frame.'},
    ]
    document = client.get(route()).json()
    assert len(document['observations']) == 1


def test_legacy_extended_review_frames_use_source_time_and_are_cached(workspace, monkeypatch):
    client, store, _ = workspace
    result = store.data['executions']['original']['result']
    segment = result['segments'][0]
    segment.pop('frame_timestamps')
    result['narration_mode'] = 'extended'
    segment.update(start_time=20, end_time=26, source_start=2, source_end=6)
    calls = fake_extraction(monkeypatch)
    document = client.get(route()).json()
    assert document['source_start'] == 2 and document['source_end'] == 6
    assert document['provenance'] == 'review' and document['observations'] == []
    assert [frame['timestamp'] for frame in document['frames']] == [2.8, 4, 5.2]
    assert calls[0][1] == {'start_time': 2, 'silence_duration': 4}
    assert client.get(document['frames'][0]['url']).content == b'review-0'
    assert client.get(route()).json() == document
    assert len(calls) == 1
    assert 'frame_timestamps' not in segment, 'Review thumbnails must not rewrite model evidence.'


@pytest.mark.parametrize('chain_kind', ['cross_video', 'cycle', 'deleted_ancestor', 'changed_window'])
def test_invalid_ancestry_falls_back_without_importing_other_facts(workspace, monkeypatch, chain_kind):
    client, store, _ = workspace
    current = revision(store)
    current['result']['segments'][0].pop('frame_timestamps')
    original = store.data['executions']['original']
    if chain_kind == 'cross_video':
        original['video_id'] = 'another-video'
    elif chain_kind == 'cycle':
        current['source_execution_id'] = 'revision'
    elif chain_kind == 'deleted_ancestor':
        original['deleted'] = True
    else:
        original['result']['segments'][0].update(start_time=1, end_time=5)
    calls = fake_extraction(monkeypatch)
    document = client.get(route('revision')).json()
    assert document['provenance'] == 'review' and document['observations'] == []
    assert document['frames'][0]['id'] == 'r0'
    assert len(calls) == 1


@pytest.mark.parametrize('target', ['video', 'collection', 'version'])
def test_deleted_parent_or_version_hides_evidence_frames_and_feedback(workspace, target):
    client, store, _ = workspace
    record = {'video': store.data['inputs']['video'], 'collection': store.data['collections']['default'],
              'version': store.data['executions']['original']}[target]
    record['deleted_at'] = 'now'
    assert client.get(route()).status_code == 404
    assert client.get(route(suffix='frames/f0')).status_code == 404
    assert client.put(route(suffix='feedback'), json={'revision': 0, 'issues': []}).status_code == 404


def test_frame_symlink_and_symlinked_run_directory_are_not_served(workspace, tmp_path):
    client, store, _ = workspace
    secret = tmp_path / 'private.jpg'
    secret.write_bytes(b'not a visual reference')
    frame = store.root / 'runs/original/frames/segment-000-0.jpg'
    frame.unlink()
    frame.symlink_to(secret)
    response = client.get(route(suffix='frames/f0'))
    assert response.status_code == 409 and secret.read_text() not in response.text
    frame.unlink()
    frame.write_bytes(b'jpeg-0')
    directory = store.root / 'runs/original'
    directory.rename(store.root / 'elsewhere')
    directory.symlink_to(store.root / 'elsewhere', target_is_directory=True)
    assert client.get(route()).status_code == 409


def test_video_deleted_during_review_extraction_is_not_disclosed(workspace, monkeypatch):
    from local_backend import pipeline
    client, store, _ = workspace
    store.data['executions']['original']['result']['segments'][0].pop('frame_timestamps')
    fake_extraction(monkeypatch)
    original_extract = pipeline._extract_frames

    def delete_during_extract(*args):
        frames = original_extract(*args)
        with store.lock:
            store.data['collections']['default']['deleted_at'] = 'now'
        return frames

    monkeypatch.setattr(pipeline, '_extract_frames', delete_during_extract)
    assert client.get(route()).status_code == 404


def test_review_extraction_failure_is_retryable_without_partial_manifest(workspace, monkeypatch):
    from local_backend import pipeline
    client, store, _ = workspace
    store.data['executions']['original']['result']['segments'][0].pop('frame_timestamps')

    def fail(*args):
        raise pipeline.PipelineError('Decoder error with an internal path')

    monkeypatch.setattr(pipeline, '_extract_frames', fail)
    response = client.get(route())
    assert response.status_code == 503 and 'internal path' not in response.text
    assert not (store.root / 'runs/original/evidence-review/segment-000/manifest.json').exists()
    fake_extraction(monkeypatch)
    assert client.get(route()).status_code == 200


def test_feedback_is_atomic_version_scoped_and_optimistic(workspace):
    client, store, settings = workspace
    revision(store)
    source_result = deepcopy(store.data['executions']['original']['result'])
    response = client.put(route(suffix='feedback'), json={
        'revision': 0, 'issues': ['missing_content', 'wrong_person', 'wrong_person'], 'note': '  Check the coat.  '})
    saved = {'revision': 1, 'issues': ['wrong_person', 'missing_content'], 'note': 'Check the coat.'}
    assert response.status_code == 200 and response.json() == saved
    assert client.get(route()).json()['feedback'] == saved
    assert client.get(route('revision')).json()['feedback']['revision'] == 0
    assert not store.data['executions']['original']['reviewed']
    assert 'reviewed_at' not in store.data['executions']['original']
    assert store.data['executions']['original']['result'] == source_result
    assert client.put(route(suffix='feedback'), json={'revision': 0, 'issues': []}).status_code == 409
    assert Store(settings).data['executions']['original']['evidence_feedback']['0'] == saved


@pytest.mark.parametrize('condition', ['archived', 'global_busy', 'generation', 'calibration'])
def test_busy_or_archived_feedback_guard_keeps_references_readable(workspace, condition):
    client, store, _ = workspace
    if condition == 'archived':
        store.data['inputs']['video']['archived'] = True
    elif condition == 'global_busy':
        store.busy.acquire()
    elif condition == 'generation':
        store.data['executions']['busy'] = {'video_id': 'video', 'status': 'RUNNING'}
    else:
        store.data['calibrations'] = {'busy': {'video_id': 'video', 'status': 'RUNNING'}}
    before = deepcopy(store.data)
    assert client.get(route()).status_code == 200
    assert client.put(route(suffix='feedback'), json={'revision': 0, 'issues': ['wrong_action']}).status_code == 409
    assert store.data == before
    if condition == 'global_busy':
        store.busy.release()


def test_feedback_save_failure_rolls_back_all_metadata(workspace, monkeypatch):
    client, store, _ = workspace
    before = deepcopy(store.data)
    persisted = (store.root / 'index.json').read_bytes()
    monkeypatch.setattr(store, 'save', lambda: (_ for _ in ()).throw(OSError('disk full')))
    response = client.put(route(suffix='feedback'), json={'revision': 0, 'issues': ['wrong_action'], 'note': 'Check.'})
    assert response.status_code == 500
    assert store.data == before
    assert (store.root / 'index.json').read_bytes() == persisted


@pytest.mark.parametrize('body', [
    {'revision': 0, 'issues': ['invalid']}, {'revision': -1, 'issues': []},
    {'revision': 0, 'issues': [], 'note': 'a' * 2001}, {'revision': 0, 'issues': [], 'path': '/private/a'},
    {'revision': '0', 'issues': []}, {'revision': 0, 'issues': [], 'note': 1},
])
def test_invalid_feedback_never_mutates(workspace, body):
    client, store, _ = workspace
    before = deepcopy(store.data)
    assert client.put(route(suffix='feedback'), json=body).status_code == 422
    assert store.data == before


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg is required for synthetic frame extraction')
def test_real_review_frames_from_synthetic_low_fps_source(workspace):
    client, store, _ = workspace
    segment = store.data['executions']['original']['result']['segments'][0]
    segment.pop('frame_timestamps')
    segment.update(start_time=1, end_time=3)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                    '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=5:duration=4',
                    '-c:v', 'libx264', str(store.root / 'input/video.mp4')], check=True, timeout=15)
    response = client.get(route())
    assert response.status_code == 200, response.text
    document = response.json()
    assert document['provenance'] == 'review' and document['observations'] == []
    assert all(1 <= frame['timestamp'] < 3 for frame in document['frames'])
    assert client.get(document['frames'][0]['url']).content.startswith(b'\xff\xd8')
