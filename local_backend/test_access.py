"""Hosted account/session isolation with an independent temporary SQLite store."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import sqlite3

import pytest

from local_backend.access import (AccessError, AccessStore, ACCOUNT_TTL, GUEST_TTL,
                                  LOGIN_LIMIT, LOGIN_WINDOW, GUEST_LIMIT, REGISTER_LIMIT, CREATION_WINDOW)

PASSWORD = 'correct-horse-battery'


@pytest.fixture
def access(tmp_path):
    now = [1_800_000_000.0]
    store = AccessStore(tmp_path / 'hosted', clock=lambda: now[0])
    return store, now


def timestamp(principal):
    return datetime.fromisoformat(principal['expires_at']).timestamp()


def test_guests_have_private_random_workspaces_and_fixed_expiry(access):
    store, now = access
    first, second = store.start_guest(), store.start_guest()
    principal = first['principal']
    assert principal['kind'] == 'guest' and principal['username'] is None
    assert len(principal['workspace_id']) == 32
    assert first['token'] != second['token'] and principal['workspace_id'] != second['principal']['workspace_id']
    assert set(principal) == {'workspace_id', 'kind', 'username', 'expires_at'}
    assert timestamp(principal) == now[0] + GUEST_TTL
    now[0] += 300
    assert store.start_guest(first['token']) == first
    assert store.resolve(first['token']) == principal
    now[0] = timestamp(principal)
    assert store.resolve(first['token']) is None
    replacement = store.start_guest(first['token'])
    assert replacement['principal']['workspace_id'] != principal['workspace_id']


def test_register_login_restore_and_logout_are_token_scoped(access):
    store, now = access
    registered = store.register(' Alice_One ', PASSWORD)
    principal = registered['principal']
    assert principal['kind'] == 'account' and principal['username'] == 'alice_one'
    assert timestamp(principal) == now[0] + ACCOUNT_TTL
    login = store.login('ALICE_ONE', PASSWORD)
    assert login['token'] != registered['token']
    assert login['principal']['workspace_id'] == principal['workspace_id']
    assert store.start_guest(login['token']) == login
    store.logout(registered['token'])
    assert store.resolve(registered['token']) is None
    assert store.resolve(login['token']) == principal
    reopened = AccessStore(store.root, clock=lambda: now[0])
    assert reopened.resolve(login['token']) == principal
    now[0] += ACCOUNT_TTL
    assert reopened.resolve(login['token']) is None


def test_sqlite_stores_only_salted_password_and_token_hashes(access):
    store, _ = access
    first = store.register('alice', PASSWORD)
    second = store.register('bob', PASSWORD)
    with sqlite3.connect(store.path) as connection:
        rows = connection.execute('SELECT username,password_salt,password_hash FROM principals ORDER BY username').fetchall()
        session_hashes = [row[0] for row in connection.execute('SELECT token_hash FROM sessions')]
    assert rows[0][1] != rows[1][1] and rows[0][2] != rows[1][2]
    assert all(len(row[1]) == 16 and len(row[2]) == 32 for row in rows)
    assert hashlib.sha256(first['token'].encode()).hexdigest() in session_hashes
    disk = store.path.read_bytes()
    assert PASSWORD.encode() not in disk and first['token'].encode() not in disk and second['token'].encode() not in disk
    assert store.root.stat().st_mode & 0o777 == 0o700
    assert store.path.stat().st_mode & 0o777 == 0o600


def test_guest_registration_atomically_keeps_workspace_and_revokes_old_session(access):
    store, _ = access
    guest = store.start_guest()
    account = store.register('owner', PASSWORD, guest['token'])
    assert account['principal']['workspace_id'] == guest['principal']['workspace_id']
    assert account['principal']['kind'] == 'account'
    assert store.resolve(guest['token']) is None
    assert store.resolve(account['token']) == account['principal']
    assert store.login('owner', PASSWORD)['principal']['workspace_id'] == guest['principal']['workspace_id']


def test_login_does_not_adopt_guest_workspace(access):
    store, _ = access
    account = store.register('owner', PASSWORD)
    guest = store.start_guest()
    signed_in = store.login('owner', PASSWORD)
    assert signed_in['principal']['workspace_id'] == account['principal']['workspace_id']
    assert signed_in['principal']['workspace_id'] != guest['principal']['workspace_id']
    assert store.resolve(guest['token']) == guest['principal']


def test_expired_upgrade_and_account_as_guest_are_rejected_without_new_account(access):
    store, now = access
    guest = store.start_guest()
    now[0] += GUEST_TTL
    with pytest.raises(AccessError) as error:
        store.register('expired', PASSWORD, guest['token'])
    assert error.value.status_code == 401
    account = store.register('owner', PASSWORD)
    with pytest.raises(AccessError) as error:
        store.register('other', PASSWORD, account['token'])
    assert error.value.status_code == 409
    with pytest.raises(AccessError):
        store.login('expired', PASSWORD)
    assert store.resolve(account['token']) == account['principal']


def test_duplicate_registration_does_not_consume_guest(access):
    store, _ = access
    store.register('owner', PASSWORD)
    guest = store.start_guest()
    with pytest.raises(AccessError) as error:
        store.register('OWNER', PASSWORD, guest['token'])
    assert error.value.status_code == 409
    assert store.resolve(guest['token']) == guest['principal']


def test_same_guest_cannot_be_upgraded_twice_concurrently(access):
    store, _ = access
    guest = store.start_guest()
    def register(name):
        try:
            return store.register(name, PASSWORD, guest['token'])
        except AccessError as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(register, ['first', 'second']))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert 401 in results
    with sqlite3.connect(store.path) as connection:
        assert connection.execute("SELECT count(*) FROM principals WHERE kind='account'").fetchone()[0] == 1


@pytest.mark.parametrize('username,password', [
    ('ab', PASSWORD), ('_abc', PASSWORD), ('a' * 33, PASSWORD), ('../owner', PASSWORD),
    ('含中文', PASSWORD), ('a b', PASSWORD), ('owner', 'x' * 11), ('owner', 'x' * 25), ('owner', None),
])
def test_registration_validates_inputs_without_accounts(access, username, password):
    store, _ = access
    with pytest.raises(AccessError) as error:
        store.register(username, password)
    assert error.value.status_code == 422
    with sqlite3.connect(store.path) as connection:
        assert connection.execute('SELECT count(*) FROM principals').fetchone()[0] == 0


@pytest.mark.parametrize('length', [12, 24])
def test_password_length_boundaries_register_and_login(access, length):
    store, _ = access
    password = 'x' * length
    registered = store.register('owner', password)
    assert store.login('owner', password)['principal']['workspace_id'] == registered['principal']['workspace_id']


def test_login_messages_do_not_reveal_account_existence(access):
    store, _ = access
    store.register('owner', PASSWORD)
    errors = []
    for username, password in [('owner', 'wrong-password-here'), ('missing', PASSWORD), ('invalid name', PASSWORD), ('owner', None)]:
        with pytest.raises(AccessError) as error:
            store.login(username, password, remote='192.0.2.1')
        errors.append((error.value.status_code, error.value.message))
    assert len(set(errors)) == 1 and errors[0][0] == 401


def test_persisted_login_throttle_limits_failures_and_expires(access):
    store, now = access
    store.register('owner', PASSWORD)
    for _ in range(LOGIN_LIMIT):
        with pytest.raises(AccessError) as error:
            store.login('owner', 'wrong-password-here', '192.0.2.1')
        assert error.value.status_code == 401
    restarted = AccessStore(store.root, clock=lambda: now[0])
    with pytest.raises(AccessError) as error:
        restarted.login('OWNER', PASSWORD, '192.0.2.1')
    assert error.value.status_code == 429 and error.value.retry_after == LOGIN_WINDOW
    assert restarted.login('owner', PASSWORD, '192.0.2.2')['principal']['username'] == 'owner'
    now[0] += LOGIN_WINDOW
    assert restarted.login('owner', PASSWORD, '192.0.2.1')['principal']['username'] == 'owner'


def test_successful_login_resets_its_failed_attempt_bucket(access):
    store, _ = access
    store.register('owner', PASSWORD)
    for _ in range(2):
        with pytest.raises(AccessError):
            store.login('owner', 'wrong-password-here')
    store.login('owner', PASSWORD)
    with sqlite3.connect(store.path) as connection:
        assert connection.execute("SELECT count(*) FROM login_attempts WHERE bucket NOT LIKE 'register:%'").fetchone()[0] == 0


def test_session_creation_failure_rolls_back_guest_upgrade(access, monkeypatch):
    store, _ = access
    guest = store.start_guest()
    def fail(*args):
        raise sqlite3.OperationalError('disk unavailable')
    monkeypatch.setattr(store, '_session', fail)
    with pytest.raises(sqlite3.OperationalError):
        store.register('owner', PASSWORD, guest['token'])
    assert store.resolve(guest['token']) == guest['principal']
    with sqlite3.connect(store.path) as connection:
        assert connection.execute("SELECT count(*) FROM principals WHERE kind='account'").fetchone()[0] == 0


@pytest.mark.parametrize('token', [None, '', '../workspace', 'x' * 500, 'not a token', 42])
def test_invalid_session_values_do_not_select_workspaces(access, token):
    store, _ = access
    assert store.resolve(token) is None
    store.logout(token)


def test_symlink_database_cannot_read_other_files(tmp_path):
    directory = tmp_path / 'hosted'
    directory.mkdir()
    other = tmp_path / 'other.sqlite3'
    other.write_bytes(b'untouched private file')
    (directory / 'access.sqlite3').symlink_to(other)
    with pytest.raises(AccessError):
        AccessStore(directory)
    assert other.read_bytes() == b'untouched private file'


def test_guest_creation_throttle_persists_and_reuse_does_not_consume_quota(access):
    store, now = access
    created = [store.start_guest(remote='192.0.2.1') for _ in range(GUEST_LIMIT)]
    assert store.start_guest(created[0]['token'], remote='192.0.2.1') == created[0]
    reopened = AccessStore(store.root, clock=lambda: now[0])
    with pytest.raises(AccessError) as error:
        reopened.start_guest(remote='192.0.2.1')
    assert error.value.status_code == 429 and error.value.retry_after == CREATION_WINDOW
    assert reopened.start_guest(remote='192.0.2.2')['principal']['workspace_id']
    now[0] += CREATION_WINDOW
    assert reopened.start_guest(remote='192.0.2.1')['principal']['workspace_id']


def test_registration_throttle_counts_invalid_requests_before_hashing(access, monkeypatch):
    store, _ = access
    for _ in range(REGISTER_LIMIT):
        with pytest.raises(AccessError) as error:
            store.register('bad name', 'short', remote='192.0.2.1')
        assert error.value.status_code == 422
    with pytest.raises(AccessError) as error:
        store.register('valid', PASSWORD, remote='192.0.2.1')
    assert error.value.status_code == 429
