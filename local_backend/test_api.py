from pathlib import Path
import json
import subprocess

from fastapi.testclient import TestClient
from local_backend.config import Settings
from local_backend import main

def config(tmp_path, **overrides):
    return Settings(data_dir=tmp_path, azure_openai_endpoint='https://example.openai.azure.com/openai/v1',
                    azure_openai_api_key='test-secret-not-real', azure_speech_key='test-speech-not-real',
                    azure_speech_region='testregion', **overrides)

def test_health_never_exposes_keys_and_missing_config_blocks(tmp_path):
    cfg = Settings(data_dir=tmp_path, azure_openai_api_key='secret-value')
    with TestClient(main.create_app(cfg)) as client:
        response = client.get('/api/health')
        assert response.json()['configured'] is False
        assert 'secret-value' not in response.text
        assert client.post('/api/trigger/executions', json={'video_id': 'missing'}).status_code == 503

def test_path_traversal_and_cross_site_requests_are_rejected(tmp_path):
    with TestClient(main.create_app(config(tmp_path))) as client:
        for filename in ('../escape.mp4', '/escape.mp4', r'dir\escape.mp4', 'audio.wav'):
            assert client.post('/api/trigger/upload', json={'filename': filename}).status_code == 400
        response = client.post('/api/trigger/upload', json={'filename': 'ok.mp4'},
                               headers={'Origin': 'https://unrelated.example'})
        assert response.status_code == 403

def test_upload_limit_and_one_time_link(tmp_path):
    with TestClient(main.create_app(config(tmp_path, max_upload_bytes=4))) as client:
        url = client.post('/api/trigger/upload', json={'filename': 'big.mp4'}).json()['url']
        assert client.put(url, content=b'12345').status_code == 413
        assert client.put(url, content=b'123').status_code == 404
        assert client.get('/api/trigger/videos').json() == {'videos': []}
        assert list((tmp_path / 'input').iterdir()) == []

def test_real_media_upload_range_and_pipeline_response_contract(tmp_path, monkeypatch):
    source = tmp_path / 'generated.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                    'color=c=blue:s=160x120:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], check=True)
    captured = []
    def fake_pipeline(input_path, output_dir, settings, gap, on_step):
        captured.append(gap)
        on_step('ValidateInput', 'RUNNING', {})
        on_step('ValidateInput', 'SUCCEEDED', {})
        output_dir.mkdir(parents=True)
        output = output_dir / 'described.mp4'
        output.write_bytes(input_path.read_bytes())
        return {'output_path': str(output), 'segments': [
            {'segment_index': 0, 'start_time': 0, 'end_time': 1, 'silence_duration': 1,
             'dvi_text': 'A blue background.', 'audio_duration': 0.8, 'pass': True}], 'usage': {}}
    monkeypatch.setattr(main, 'process_video', fake_pipeline)
    with TestClient(main.create_app(config(tmp_path / 'data'))) as client:
        url = client.post('/api/trigger/upload', json={'filename': 'sample.mp4'}).json()['url']
        assert client.put(url, content=source.read_bytes()).status_code == 200
        video = client.get('/api/trigger/videos').json()['videos'][0]
        preview = client.get(f"/api/trigger/videos/{video['video_id']}/url").json()['url']
        assert client.get(preview, headers={'Range': 'bytes=0-15'}).status_code == 206
        created = client.post('/api/trigger/executions', json={'video_id': video['video_id'], 'min_silence_duration': 7}).json()
        job = created['execution_arn']
        assert captured == [2]
        assert client.get(f'/api/trigger/executions/{job}/status').json()['status'] == 'SUCCEEDED'
        assert client.get(f'/api/videos/{job}/segments').json()['segments'][0]['start'] == 0
        assert client.get(f'/api/videos/{job}/summary').json()['summary']['segments_passed'] == 1
        assert client.get(f'/api/media/output/{job}?download=true').headers['content-disposition'].startswith('attachment')
        assert len(client.get('/api/videos').json()['videos']) == 1

def test_failed_job_redacts_secret_and_restart_marks_interruption(tmp_path, monkeypatch):
    cfg = config(tmp_path)
    store = main.Store(cfg)
    store.data['inputs']['test'] = {'filename': 'test.mp4'}
    store.data['executions']['job'] = {'status': 'RUNNING', 'steps': [], 'stop_date': None}
    store.save()
    store.busy.acquire()
    def failed(*args):
        raise ValueError('Request failed: ' + cfg.azure_openai_api_key)
    monkeypatch.setattr(main, 'process_video', failed)
    main.run_job(store, 'job', 'test', 4)
    assert store.data['executions']['job']['status'] == 'FAILED'
    assert cfg.azure_openai_api_key not in (tmp_path / 'index.json').read_text()
    store.data['executions']['job']['status'] = 'RUNNING'
    store.save()
    assert main.Store(cfg).data['executions']['job']['status'] == 'ABORTED'

def test_job_creation_write_failure_releases_processing_lock(tmp_path, monkeypatch):
    app = main.create_app(config(tmp_path))
    store = app.state.store
    store.data['inputs']['sample'] = {'filename': 'sample.mp4'}
    def disk_error():
        raise OSError('Disk full')
    monkeypatch.setattr(store, 'save', disk_error)
    with TestClient(app) as client:
        response = client.post('/api/trigger/executions', json={'video_id': 'sample'})
        assert response.status_code == 500
        assert not store.busy.locked()
        assert store.data['executions'] == {}
