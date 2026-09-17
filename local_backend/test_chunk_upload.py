"""Sequential bounded uploads using synthetic bytes, never cloud requests."""
from copy import deepcopy
from contextlib import closing
from pathlib import Path
import os
import time

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from local_backend import main
from local_backend.config import Settings


@pytest.fixture
def upload(tmp_path, monkeypatch):
    config = Settings(data_dir=tmp_path / 'data', max_upload_bytes=1024**3)
    monkeypatch.setattr(main, 'UPLOAD_CHUNK_BYTES', 4)
    monkeypatch.setattr(main, 'validate_upload', lambda path, settings: 3.0)
    app = main.create_app(config)
    with TestClient(app) as client:
        yield client, app.state.store


def reserve(client, size=10):
    return client.post('/api/trigger/upload', json={'filename': 'synthetic.mp4', 'size_bytes': size}).json()


def chunk(client, reservation, index, content):
    return client.put(reservation['chunk_url'].replace('{index}', str(index)), content=content)


def complete(client, reservation):
    return client.post(reservation['complete_url'], json={})


def test_chunks_assemble_exactly_once_and_complete_is_idempotent(upload):
    client, store = upload
    reservation = reserve(client)
    assert reservation['chunk_size'] == 4
    assert chunk(client, reservation, 0, b'abcd').json() == {'index': 0, 'received_bytes': 4}
    assert chunk(client, reservation, 0, b'abcd').status_code == 200
    assert chunk(client, reservation, 1, b'efgh').status_code == 200
    assert chunk(client, reservation, 2, b'ij').status_code == 200
    assert complete(client, reservation).json() == {'key': reservation['key']}
    assert complete(client, reservation).json() == {'key': reservation['key']}
    assert (store.root / reservation['key']).read_bytes() == b'abcdefghij'
    assert len(store.data['inputs']) == 1 and not store.active_uploads and not store.pending


def test_order_length_and_changed_retry_do_not_corrupt_previous_chunks(upload):
    client, store = upload
    reservation = reserve(client)
    assert chunk(client, reservation, 1, b'efgh').status_code == 409
    assert chunk(client, reservation, -1, b'abcd').status_code == 409
    assert chunk(client, reservation, 0, b'ab').status_code == 400
    assert chunk(client, reservation, 0, b'abcde').status_code == 413
    assert chunk(client, reservation, 0, b'abcd').status_code == 200
    assert chunk(client, reservation, 0, b'xxxx').status_code == 409
    assert complete(client, reservation).status_code == 409
    assert chunk(client, reservation, 1, b'efgh').status_code == 200
    assert chunk(client, reservation, 2, b'ij').status_code == 200
    assert complete(client, reservation).status_code == 200
    assert (store.root / reservation['key']).read_bytes() == b'abcdefghij'


def test_declared_size_and_legacy_mode_validation(upload):
    client, store = upload
    for size, code in [(0, 422), (-1, 422), ('10', 422), (1024**3 + 1, 413)]:
        assert client.post('/api/trigger/upload', json={'filename': 'sample.mp4', 'size_bytes': size}).status_code == code
    assert client.post('/api/trigger/upload', json={'filename': 'sample.mp4', 'size_bytes': 1024**3}).status_code == 200
    old = client.post('/api/trigger/upload', json={'filename': 'legacy.mp4'}).json()
    assert 'chunk_size' not in old
    assert client.put(old['url'], content=b'legacy').status_code == 200
    assert (store.root / old['key']).read_bytes() == b'legacy'
    current = reserve(client)
    assert client.put(current['url'], content=b'do not bypass chunk bound').status_code == 409
    assert chunk(client, current, 0, b'abcd').status_code == 200


def test_active_chunks_protect_collection_deletion_and_expire_safely(upload):
    client, store = upload
    reservation = reserve(client)
    assert chunk(client, reservation, 0, b'abcd').status_code == 200
    assert client.delete('/api/collections/default').status_code == 409
    spool = next((store.root / 'chunk-uploads').glob('*.part'))
    pending = next(iter(store.active_uploads.values()))
    pending['expires_at'] = time.time() - 1
    original = store.root / 'input/keep.mp4'
    original.write_bytes(b'original must remain')
    assert chunk(client, reservation, 1, b'efgh').status_code == 404
    assert not spool.exists() and not store.active_uploads
    assert original.read_bytes() == b'original must remain'


def test_orphaned_chunk_cleanup_only_removes_old_owned_spool_files(upload):
    client, store = upload
    directory = store.root / 'chunk-uploads'
    directory.mkdir()
    orphan = directory / 'orphan-123.part'
    recent = directory / 'recent-456.part'
    outside = store.root / 'outside.part'
    for path in [orphan, recent, outside]:
        path.write_bytes(b'keep unless stale spool')
    os.utime(orphan, (time.time() - 7200, time.time() - 7200))
    link = directory / 'symlink-123.part'
    link.symlink_to(outside)
    reserve(client)
    assert not orphan.exists() and recent.exists() and link.is_symlink() and outside.exists()


def test_complete_validation_failure_and_save_failure_allow_safe_retry(upload, monkeypatch):
    client, store = upload
    reservation = reserve(client, 4)
    chunk(client, reservation, 0, b'abcd')
    def invalid(*args):
        raise HTTPException(400, 'Invalid video')
    monkeypatch.setattr(main, 'validate_upload', invalid)
    assert complete(client, reservation).status_code == 400
    assert not store.data['inputs']
    monkeypatch.setattr(main, 'validate_upload', lambda *args: 3)
    save = store.save
    monkeypatch.setattr(store, 'save', lambda: (_ for _ in ()).throw(OSError('disk full')))
    assert complete(client, reservation).status_code == 503
    assert not store.data['inputs'] and not (store.root / reservation['key']).exists()
    assert next((store.root / 'chunk-uploads').glob('*.part')).read_bytes() == b'abcd'
    monkeypatch.setattr(store, 'save', save)
    assert complete(client, reservation).status_code == 200


def test_receiving_chunk_prevents_overlapping_request(upload):
    client, store = upload
    reservation = reserve(client)
    pending = next(iter(store.pending.values()))
    pending['receiving'] = True
    assert chunk(client, reservation, 0, b'abcd').status_code == 409
    pending['receiving'] = False
    assert chunk(client, reservation, 0, b'abcd').status_code == 200


def test_spool_or_input_symlinks_never_redirect_uploaded_data(upload):
    client, store = upload
    reservation = reserve(client, 4)
    pending = next(iter(store.pending.values()))
    spool = store.root / 'chunk-uploads'
    spool.mkdir()
    private = store.root / 'keep.txt'
    private.write_bytes(b'private')
    (spool / (pending['id'] + '.part')).symlink_to(private)
    assert chunk(client, reservation, 0, b'abcd').status_code == 409
    assert private.read_bytes() == b'private'
    (spool / (pending['id'] + '.part')).unlink()
    assert chunk(client, reservation, 0, b'abcd').status_code == 200
    original_input = store.root / 'input'
    original_input.rename(store.root / 'input-elsewhere')
    original_input.symlink_to(store.root / 'input-elsewhere', target_is_directory=True)
    assert complete(client, reservation).status_code == 409
    assert not store.data['inputs']


def test_chunk_tokens_cannot_cross_hosted_sessions(tmp_path, monkeypatch):
    from local_backend.hosted import create_hosted_app
    monkeypatch.setattr(main, 'UPLOAD_CHUNK_BYTES', 4)
    monkeypatch.setattr(main, 'validate_upload', lambda *args: 3)
    origin = 'https://testserver'
    app = create_hosted_app(Settings(public_origin=origin, data_dir=tmp_path / 'private', hosted_data_dir=tmp_path / 'hosted'))
    with TestClient(app, base_url=origin, headers={'Origin': origin}) as alice:
        alice.post('/api/access/guest', json={})
        reservation = reserve(alice, 4)
        with closing(TestClient(app, base_url=origin, headers={'Origin': origin})) as bob:
            bob.post('/api/access/guest', json={})
            assert chunk(bob, reservation, 0, b'abcd').status_code == 404
            assert complete(bob, reservation).status_code == 404
        assert chunk(alice, reservation, 0, b'abcd').status_code == 200
        assert complete(alice, reservation).status_code == 200
