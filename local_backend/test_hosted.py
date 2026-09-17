"""Cross-session privacy probes against every media/workspace API family."""
import copy
from contextlib import closing
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from local_backend import main
from local_backend.config import Settings
from local_backend.hosted import COOKIE, create_hosted_app

ORIGIN = 'https://testserver'
PASSWORD = 'local-test-password-only'


@pytest.fixture
def server(tmp_path, monkeypatch):
    private = tmp_path / 'private'
    private.mkdir()
    secret = b'private laptop cases must not be opened'
    (private / 'index.json').write_bytes(secret)
    settings = Settings(access_mode='hosted', public_origin=ORIGIN, data_dir=private,
                        hosted_data_dir=tmp_path / 'hosted', azure_openai_endpoint='https://example.invalid',
                        azure_openai_api_key='synthetic-secret', azure_speech_key='synthetic-speech', azure_speech_region='example')
    app = main.create_app(settings)
    def process(input_path, output_dir, config, gap, progress):
        output_dir.mkdir(parents=True, exist_ok=True)
        output = output_dir / 'out.mp4'; output.write_bytes(b'fake export')
        return {'segments': [], 'output_path': str(output)}
    monkeypatch.setattr(main, 'process_video', process)
    with TestClient(app, base_url=ORIGIN) as client:
        yield app, client, settings
    assert (private / 'index.json').read_bytes() == secret


def post(client, path, body=None, **options):
    return client.post(path, json=body or {}, headers={'Origin': ORIGIN}, **options)


def principal(app, client):
    return app.state.workspaces.auth.resolve(client.cookies.get(COOKIE))


def seed(app, client):
    store = app.state.workspaces.application(principal(app, client)).state.store
    directory = store.root / 'runs' / 'version'
    (directory / 'frames').mkdir(parents=True)
    (store.root / 'input/private-video.mp4').write_bytes(b'private media')
    (directory / 'out.mp4').write_bytes(b'private output')
    (directory / 'frames/segment-000-0.jpg').write_bytes(b'private frame')
    (directory / 'transcript.json').write_text(json.dumps({'cues': [{'id': 'cue', 'text': 'private dialogue', 'start': 0, 'end': 1}]}))
    store.data['inputs']['private-video'] = {'video_id': 'private-video', 'filename': 'private.mp4',
        'collection_id': 'default', 'duration': 2, 'last_modified': '2026-09-17', 'size_mb': 1}
    store.data['executions']['version'] = {'execution_arn': 'version', 'video_id': 'private-video', 'status': 'SUCCEEDED',
        'start_date': '2026-09-17', 'steps': [], 'result': {'transcript_path': str(directory / 'transcript.json'),
        'output_path': str(directory / 'out.mp4'), 'summary': {'video_duration': 2},
        'segments': [{'segment_index': 0, 'start_time': 0, 'end_time': 2, 'silence_duration': 2, 'audio_duration': 1,
                      'dvi_text': 'private narration', 'pass': True, 'frame_timestamps': [0.5]}]}}
    store.data['outputs']['version'] = {'filename': 'private-result.mp4', 'last_modified': '2026-09-17'}
    store.data['calibrations']['calibration'] = {'job_id': 'version', 'status': 'SUCCEEDED', 'result': {'cues': [{'text': 'private'}]}}
    store.data['character_detections']['detection'] = {'job_id': 'version', 'video_id': 'private-video', 'status': 'SUCCEEDED'}
    store.save()
    return store


PRIVATE_PATHS = [
    '/api/projects/private-video', '/api/trigger/videos/private-video/url', '/api/media/input/private-video',
    '/api/videos/version/url', '/api/media/output/version', '/api/media/output/version?download=true',
    '/api/videos/version/transcript', '/api/videos/version/export?kind=dialogue&format=srt',
    '/api/videos/version/editor', '/api/videos/version/segments/0/evidence',
    '/api/videos/version/segments/0/frames/f0', '/api/projects/private-video/characters',
    '/api/trigger/executions/version/status', '/api/transcript-calibrations/calibration',
    '/api/character-detections/detection', '/api/projects/private-video/characters/detection/latest',
    '/api/projects/private-video/thumbnail', '/api/cost/executions?video_id=private-video', '/api/executions/version/usage',
]


def test_guest_workspace_is_empty_and_cannot_read_other_user_files(server):
    app, alice, _ = server
    assert alice.get('/api/access/session').json()['user'] is None
    assert alice.get('/api/projects').status_code == 401
    assert post(alice, '/api/access/register', {'username': 'alice', 'password': PASSWORD}).status_code == 200
    alice_store = seed(app, alice)
    with closing(TestClient(app, base_url=ORIGIN)) as bob:
        assert post(bob, '/api/access/guest').status_code == 200
        assert principal(app, bob)['workspace_id'] != principal(app, alice)['workspace_id']
        assert bob.get('/api/projects').json()['projects'] == []
        assert bob.get('/api/videos').json()['videos'] == []
        for path in PRIVATE_PATHS:
            result = bob.get(path, headers={'Range': 'bytes=0-4'})
            assert result.status_code == 404, (path, result.text)
            assert 'private dialogue' not in result.text
        assert bob.put('/api/videos/version/segments/0/feedback', json={'revision': 0, 'issues': [], 'note': 'x'}, headers={'Origin': ORIGIN}).status_code == 404
        assert alice.get('/api/media/input/private-video').content == b'private media'
        assert alice.get('/api/media/output/version', headers={'Range': 'bytes=0-6'}).status_code == 206
        assert alice_store.root != app.state.workspaces.application(principal(app, bob)).state.store.root


def test_two_registered_accounts_are_isolated_and_logout_revokes_links(server):
    app, first, _ = server
    post(first, '/api/access/register', {'username': 'first', 'password': PASSWORD})
    seed(app, first)
    old_token = first.cookies.get(COOKIE)
    assert post(first, '/api/access/logout').json()['user'] is None
    assert first.get('/api/media/input/private-video').status_code == 401
    assert post(first, '/api/access/register', {'username': 'second', 'password': PASSWORD}).status_code == 200
    assert first.get('/api/projects').json()['projects'] == []
    assert first.get('/api/media/input/private-video').status_code == 404
    response = post(first, '/api/access/login', {'username': 'first', 'password': PASSWORD})
    assert response.status_code == 200
    assert first.get('/api/projects').json()['projects'][0]['video_id'] == 'private-video'
    assert app.state.workspaces.auth.resolve(old_token) is None


def test_guest_registration_keeps_trial_data_but_never_opens_local_cases(server):
    app, client, settings = server
    post(client, '/api/access/guest')
    before = principal(app, client)
    old_token = client.cookies.get(COOKIE)
    seed(app, client)
    result = post(client, '/api/access/register', {'username': 'converted', 'password': PASSWORD})
    assert result.status_code == 200
    assert result.json()['user']['kind'] == 'account'
    assert principal(app, client)['workspace_id'] == before['workspace_id']
    assert result.json()['limits']['max_video_seconds'] == settings.max_video_seconds
    assert client.get('/api/media/input/private-video').content == b'private media'
    assert app.state.workspaces.auth.resolve(old_token) is None


def test_cookies_csrf_private_cache_and_bad_credentials(server):
    _, client, _ = server
    assert client.post('/api/access/guest', json={}).status_code == 403
    assert client.post('/api/access/guest', json={}, headers={'Origin': 'https://unrelated.invalid'}).status_code == 403
    response = post(client, '/api/access/guest')
    cookie = response.headers['set-cookie'].lower()
    assert 'httponly' in cookie and 'secure' in cookie and 'samesite=lax' in cookie
    assert COOKIE not in response.text and 'token' not in response.text
    assert client.get('/api/projects').headers['cache-control'] == 'private, no-store'
    assert client.get('/api/projects').headers['vary'] == 'Cookie'
    invalid = post(client, '/api/access/login', {'username': 'user', 'password': 'short'})
    assert invalid.status_code == 422 and 'short' not in invalid.text
    assert client.get('/api/projects', headers={'Host': 'unrelated.invalid'}).status_code == 400
    assert client.get('/.local-data/index.json').status_code == 404
    assert client.get('/api/access/session?user_id=another').json()['user']['kind'] == 'guest'


def test_trial_limits_cannot_be_bypassed_by_alternate_paid_routes(server):
    app, client, _ = server
    post(client, '/api/access/guest')
    limits = client.get('/api/access/session').json()['limits']
    assert limits == {'max_video_seconds': 60, 'max_upload_mb': 1024, 'guest_generations_remaining': 5}
    store = seed(app, client)
    # Invalid attempts are refunded without allowing a paid job to run.
    assert post(client, '/api/trigger/executions', {'video_id': 'missing'}).status_code == 404
    assert client.get('/api/access/session').json()['limits']['guest_generations_remaining'] == 5
    for remaining in range(4, -1, -1):
        assert post(client, '/api/trigger/executions', {'video_id': 'private-video', 'detect_characters': False}).status_code == 200
        assert client.get('/api/access/session').json()['limits']['guest_generations_remaining'] == remaining
    assert client.get('/api/access/session').json()['limits']['guest_generations_remaining'] == 0
    for route in ['/api/trigger/executions', '/api/videos/version/render',
                  '/api/videos/version/transcript/calibrate', '/api/videos/version/characters/detect']:
        assert post(client, route).status_code == 403
    assert client.get('/api/media/input/private-video').status_code == 200
    assert store.data['guest_paid_operations'] == 5


def test_guest_upload_reservations_and_tokens_are_workspace_scoped(server):
    app, client, _ = server
    post(client, '/api/access/guest')
    url = post(client, '/api/trigger/upload', {'filename': 'first.mp4'}).json()['url']
    for index in range(2, 6):
        assert post(client, '/api/trigger/upload', {'filename': f'video-{index}.mp4'}).status_code == 200
    assert post(client, '/api/trigger/upload', {'filename': 'sixth.mp4'}).status_code == 403
    with closing(TestClient(app, base_url=ORIGIN)) as other:
        post(other, '/api/access/guest')
        assert other.put(url, content=b'not theirs', headers={'Origin': ORIGIN}).status_code == 404


def test_redirect_does_not_consume_guest_budget_without_a_job(server):
    app, client, _ = server
    post(client, '/api/access/guest')
    store = seed(app, client)
    response = post(client, '/api/trigger/executions/', {'video_id': 'private-video'}, follow_redirects=False)
    assert response.status_code == 307
    assert client.get('/api/access/session').json()['limits']['guest_generations_remaining'] == 5
    assert len(store.data['executions']) == 1
    assert post(client, '/api/trigger/executions/', {'video_id': 'private-video'}, follow_redirects=True).status_code == 200
    assert client.get('/api/access/session').json()['limits']['guest_generations_remaining'] == 4


def test_existing_guest_gets_new_limit_without_resetting_used_operations(server):
    app, client, config = server
    assert client.get('/api/access/session').json()['limits']['max_upload_mb'] == 1024
    post(client, '/api/access/guest')
    store = app.state.workspaces.application(principal(app, client)).state.store
    store.data['guest_paid_operations'] = 1
    store.save()
    assert config.max_upload_bytes == 500 * 1024 * 1024
    assert store.settings.max_upload_bytes == 1024 ** 3
    assert client.get('/api/health').json()['max_upload_mb'] == 1024
    assert client.get('/api/access/session').json()['limits']['guest_generations_remaining'] == 4
    post(client, '/api/access/guest')
    assert store.data['guest_paid_operations'] == 1


def test_expired_sessions_fail_closed_for_direct_media_links(server):
    app, client, _ = server
    now = app.state.workspaces.auth.clock()
    app.state.workspaces.auth.clock = lambda: now
    post(client, '/api/access/guest'); seed(app, client)
    app.state.workspaces.auth.clock = lambda: now + 24 * 3600 + 1
    assert client.get('/api/access/session').json()['user'] is None
    for path in PRIVATE_PATHS:
        assert client.get(path).status_code == 401
    assert client.cookies.get(COOKIE) is None
    assert post(client, '/api/access/register', {'username': 'after-expiry', 'password': PASSWORD}).status_code == 200


def test_hosted_storage_cannot_reuse_private_workspace(tmp_path):
    for hosted in [tmp_path, tmp_path / 'nested', tmp_path.parent]:
        with pytest.raises(ValueError):
            create_hosted_app(Settings(access_mode='hosted', public_origin=ORIGIN, data_dir=tmp_path, hosted_data_dir=hosted))
    with pytest.raises(ValueError):
        main.create_app(Settings(access_mode='hosted', data_dir=tmp_path / 'private', hosted_data_dir=tmp_path / 'public'))


def test_deleted_source_cannot_leak_calibration_result_even_to_owner(server):
    app, client, _ = server
    post(client, '/api/access/register', {'username': 'owner', 'password': PASSWORD})
    store = seed(app, client)
    store.data['inputs']['private-video']['deleted'] = True
    assert client.get('/api/transcript-calibrations/calibration').status_code == 404
