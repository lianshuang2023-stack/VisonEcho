import json
from pathlib import Path
import subprocess

from fastapi.testclient import TestClient
from local_backend.config import Settings
from local_backend.main import create_app


def setup(tmp_path):
    settings = Settings(data_dir=tmp_path, azure_openai_endpoint='https://example.azure.com',
                        azure_openai_api_key='fake', azure_speech_key='fake', azure_speech_region='example')
    app = create_app(settings)
    store = app.state.store
    (tmp_path / 'input' / 'video.mp4').write_bytes(b'original-video')
    directory = tmp_path / 'runs' / 'version'
    directory.mkdir()
    (directory / 'output.mp4').write_bytes(b'output-video')
    (directory / 'transcript.json').write_text(json.dumps({'phrases': []}))
    store.data['inputs']['video'] = {'video_id': 'video', 'filename': 'video.mp4', 'collection_id': 'default',
                                    'size_mb': 1, 'duration': 12, 'last_modified': '2026-09-16'}
    store.data['executions']['version'] = {'execution_arn': 'version', 'video_id': 'video', 'status': 'SUCCEEDED',
        'start_date': '2026-09-16', 'stop_date': '2026-09-16', 'steps': [], 'result': {
            'output_path': str(directory / 'output.mp4'), 'transcript_path': str(directory / 'transcript.json'), 'segments': []}}
    store.data['outputs']['version'] = {'video_id': 'version', 'last_modified': '2026-09-16', 'filename': 'output.mp4'}
    store.save()
    return app, store


def test_deleted_video_hidden_from_all_workspaces_and_restored_with_files(tmp_path):
    app, store = setup(tmp_path)
    with TestClient(app) as client:
        assert client.delete('/api/projects/video').json() == {'video_id': 'video', 'deleted': True}
        assert client.delete('/api/projects/video').status_code == 200
        for path in ('/api/projects/video', '/api/trigger/videos/video/url', '/api/media/input/video',
                     '/api/videos/version/url', '/api/media/output/version', '/api/videos/version/segments',
                     '/api/videos/version/summary', '/api/videos/version/transcript', '/api/videos/version/editor',
                     '/api/videos/version/export?format=srt', '/api/executions/version/usage'):
            assert client.get(path).status_code == 404, path
        assert client.get('/api/projects').json()['projects'] == []
        assert client.get('/api/videos').json()['videos'] == []
        assert client.get('/api/trigger/videos').json()['videos'] == []
        assert client.post('/api/trigger/executions', json={'video_id': 'video'}).status_code == 404
        assert client.post('/api/videos/version/render', json={'segments': [], 'voice': 'en-US-GuyNeural'}).status_code == 404
        assert client.post('/api/videos/version/transcript/calibrate', json={'language': 'en-US', 'revision': 0}).status_code == 404
        assert client.get('/api/trash').json()['videos'][0]['video_id'] == 'video'
        assert client.post('/api/projects/video/restore').status_code == 200
        assert client.get('/api/projects/video').json()['latest_result_id'] == 'version'
        assert client.get('/api/media/input/video').content == b'original-video'
        assert client.get('/api/media/output/version').content == b'output-video'


def test_deleted_parent_hides_children_but_restores_history(tmp_path):
    app, store = setup(tmp_path)
    with TestClient(app) as client:
        assert client.delete('/api/collections/default').status_code == 200
        assert client.get('/api/projects?collection_id=default').status_code == 404
        assert client.get('/api/projects').json()['projects'] == []
        assert client.get('/api/videos/version/transcript').status_code == 404
        assert client.post('/api/trigger/upload', json={'filename': 'new.mp4'}).status_code == 404
        assert client.get('/api/trash').json()['videos'] == []
        assert client.post('/api/collections/default/restore').status_code == 200
        assert len(client.get('/api/projects?collection_id=default').json()['projects']) == 1
        assert client.get('/api/videos/version/editor').status_code == 200


def test_delete_busy_video_rejected_and_disk_error_rolls_back(tmp_path, monkeypatch):
    app, store = setup(tmp_path)
    with TestClient(app) as client:
        store.data['executions']['version']['status'] = 'RUNNING'
        assert client.delete('/api/projects/video').status_code == 409
        store.data['executions']['version']['status'] = 'SUCCEEDED'
        store.data['calibrations']['cal'] = {'status': 'RUNNING', 'job_id': 'version'}
        assert client.delete('/api/projects/video').status_code == 409
        store.data['calibrations']['cal']['status'] = 'FAILED'
        def fail():
            raise OSError('Disk unavailable')
        monkeypatch.setattr(store, 'save', fail)
        assert client.delete('/api/projects/video').status_code == 500
        assert not store.data['inputs']['video'].get('deleted')
        assert client.get('/api/projects/video').status_code == 200


def test_upload_is_bound_to_selected_collection(tmp_path):
    app, store = setup(tmp_path / 'data')
    source = tmp_path / 'synthetic.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], check=True)
    with TestClient(app) as client:
        collection = client.post('/api/collections', json={'title': '新项目'}).json()
        ticket = client.post('/api/trigger/upload', json={'filename': 'tiny.mp4', 'collection_id': collection['id']}).json()
        assert client.put(ticket['url'], content=source.read_bytes()).status_code == 200
        rows = client.get('/api/projects?collection_id=' + collection['id']).json()['projects']
        assert len(rows) == 1 and rows[0]['collection_id'] == collection['id']
        assert client.get('/api/collections').json()['collections'][0]['video_count'] == 1
        assert len(client.get('/api/projects?collection_id=default').json()['projects']) == 1
        assert client.post('/api/trigger/upload', json={'filename': 'tiny.mp4', 'collection_id': 'missing'}).status_code == 404


def test_unused_upload_ticket_does_not_prevent_project_deletion(tmp_path):
    app, store = setup(tmp_path)
    with TestClient(app) as client:
        ticket = client.post('/api/trigger/upload', json={'filename': 'never-uploaded.mp4'}).json()
        assert client.delete('/api/collections/default').status_code == 200
        assert client.put(ticket['url'], content=b'test').status_code == 404
        assert store.active_uploads == {}
