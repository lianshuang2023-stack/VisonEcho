"""Character guidance is snapshotted per generation, without cloud calls."""
import copy

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
