"""Character guidance is snapshotted per generation, without cloud calls."""
import copy
import json

from fastapi import BackgroundTasks

from local_backend.config import Settings
from local_backend.main import Store, enqueue_job, run_job


def test_generation_snapshots_only_confirmed_cards(tmp_path, monkeypatch):
    from local_backend import main
    store = Store(Settings(data_dir=tmp_path))
    confirmed = {'id': 'person-a', 'appearance': 'Blue jacket', 'preferred_name': 'Alex',
                 'status': 'confirmed', 'aliases': ['visitor'], 'thumbnail': None, 'occurrences': []}
    uncertain = {**confirmed, 'id': 'person-b', 'preferred_name': 'Unknown', 'status': 'unconfirmed'}
    store.data['inputs']['video'] = {'filename': 'video.mp4',
        'character_cards': {'revision': 1, 'characters': [confirmed, uncertain]}}
    background = BackgroundTasks()
    response = enqueue_job(store, background, 'video')
    job_id = response['execution_arn']
    expected = [{key: confirmed[key] for key in ('id', 'appearance', 'preferred_name', 'aliases')}]
    assert store.data['executions'][job_id]['character_context'] == expected
    # Even if memory is subsequently changed, the queued job owns its snapshot.
    confirmed['preferred_name'] = 'Later name'
    captured = []
    def process(input_path, output_dir, settings, minimum, on_step):
        captured.append(copy.deepcopy(settings.character_context))
        output_dir.mkdir(parents=True)
        output = output_dir / 'output.mp4'
        output.write_bytes(b'test output')
        return {'output_path': str(output), 'segments': []}
    monkeypatch.setattr(main, 'process_video', process)
    run_job(store, job_id, 'video', 2)
    assert captured == [expected]
    assert store.data['executions'][job_id]['result']['character_context'] == expected
    assert not store.busy.locked()


def test_revoice_preserves_original_character_snapshot(tmp_path):
    store = Store(Settings(data_dir=tmp_path))
    store.data['inputs']['video'] = {'filename': 'video.mp4'}
    original = {'character_context': [{'id': 'person-a', 'preferred_name': 'Original name'}]}
    response = enqueue_job(store, BackgroundTasks(), 'video', source_result=original)
    job = store.data['executions'][response['execution_arn']]
    assert job['character_context'] == original['character_context']
    original['character_context'][0]['preferred_name'] = 'Changed'
    assert job['character_context'][0]['preferred_name'] == 'Original name'
    store.busy.release()


def test_automatic_detection_creates_pending_cards_and_preserves_manual_ones(tmp_path, monkeypatch):
    from local_backend import main
    store = Store(Settings(data_dir=tmp_path))
    manual = {'id': 'person-a', 'appearance': 'Blue jacket', 'preferred_name': 'Alex',
              'status': 'confirmed', 'aliases': [], 'thumbnail': None, 'occurrences': []}
    store.data['inputs']['video'] = {'filename': 'video.mp4',
        'character_cards': {'revision': 1, 'characters': [manual]}}
    created = enqueue_job(store, BackgroundTasks(), 'video', detect_characters=True)
    jid = created['execution_arn']
    assert 'DetectCharacters' in [step['name'] for step in store.data['executions'][jid]['steps']]
    def process(input_path, output_dir, settings, minimum, on_step):
        assert settings.detect_characters
        output_dir.mkdir(parents=True)
        output = output_dir / 'video.mp4'; output.write_bytes(b'test output')
        return {'output_path': str(output), 'segments': [{'segment_index': 0}],
                'character_detection': {'status': 'SUCCEEDED', 'coverage': {'frame_count': 1}},
                'character_candidates': [{'appearance': 'Red scarf', 'existing_id': None,
                  'thumbnail': {'job_id': jid, 'segment_index': 0, 'frame_id': 'f0'},
                  'occurrences': [{'job_id': jid, 'segment_index': 0}]}]}
    monkeypatch.setattr(main, 'process_video', process)
    run_job(store, jid, 'video', 2)
    cards = store.data['inputs']['video']['character_cards']
    assert cards['revision'] == 2 and len(cards['characters']) == 2
    assert cards['characters'][0] == manual
    candidate = cards['characters'][1]
    assert candidate['status'] == 'unconfirmed' and candidate['preferred_name'] == ''
    result = store.data['executions'][jid]['result']
    assert result['character_detection']['added_count'] == 1
    assert 'character_candidates' not in result
    assert json.loads((store.root / 'runs' / jid / 'result.json').read_text())['character_detection']['added_count'] == 1


def test_detection_merge_failure_preserves_finished_video_and_existing_cards(tmp_path, monkeypatch):
    from local_backend import main
    store = Store(Settings(data_dir=tmp_path))
    store.data['inputs']['video'] = {'filename': 'video.mp4'}
    jid = enqueue_job(store, BackgroundTasks(), 'video', detect_characters=True)['execution_arn']
    store.data['inputs']['video']['character_cards'] = {'revision': 1, 'characters': []}
    def process(input_path, output_dir, settings, minimum, on_step):
        output_dir.mkdir(parents=True)
        output = output_dir / 'video.mp4'; output.write_bytes(b'output')
        return {'output_path': str(output), 'segments': [], 'character_detection': {'status': 'SUCCEEDED'}}
    monkeypatch.setattr(main, 'process_video', process)
    run_job(store, jid, 'video', 2)
    assert store.data['executions'][jid]['status'] == 'SUCCEEDED'
    assert store.data['executions'][jid]['result']['character_detection']['status'] == 'FAILED'
    assert store.data['inputs']['video']['character_cards'] == {'revision': 1, 'characters': []}
    assert not store.busy.locked()
