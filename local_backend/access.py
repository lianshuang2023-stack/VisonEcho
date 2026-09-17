"""Server-side hosted identities and opaque sessions, independent of local media.

The HTTP adapter owns cookies. This store never accepts browser-supplied
workspace IDs and never stores plaintext passwords or bearer tokens.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid


GUEST_TTL = 24 * 60 * 60
ACCOUNT_TTL = 7 * 24 * 60 * 60
LOGIN_WINDOW = 15 * 60
LOGIN_LIMIT = 10
CREATION_WINDOW = 60 * 60
GUEST_LIMIT = 5
REGISTER_LIMIT = 10
_USERNAME = re.compile(r'[a-z0-9][a-z0-9_-]{2,31}\Z')
_TOKEN = re.compile(r'[A-Za-z0-9_-]{32,128}\Z')


class AccessError(Exception):
    def __init__(self, status_code: int, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.retry_after = retry_after


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _password_hash(password, salt):
    return hashlib.scrypt(password.encode('utf-8'), salt=salt, n=16384, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)


def _valid_password(password):
    return isinstance(password, str) and 12 <= len(password) <= 128


def _username(username):
    if not isinstance(username, str):
        return None
    username = username.strip().lower()
    return username if _USERNAME.fullmatch(username) else None


def _token_digest(token):
    if not isinstance(token, str) or not _TOKEN.fullmatch(token):
        return None
    return hashlib.sha256(token.encode('ascii')).hexdigest()


class AccessStore:
    """One SQLite database per hosted instance; open a connection per operation.

    Password checks and session upgrades serialize with BEGIN IMMEDIATE so
    concurrent guesses cannot outrun throttling and a guest cannot be adopted
    by two accounts. Paths and account identifiers come from server settings.
    """

    def __init__(self, root: Path, *, clock=time.time):
        directory = Path(root).absolute()
        if directory.is_symlink():
            raise AccessError(500, '账户存储目录不能是符号链接。')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        self.root = directory.resolve()
        self.path = self.root / 'access.sqlite3'
        self.clock = clock
        self._dummy_salt = secrets.token_bytes(16)
        self._dummy_hash = _password_hash('not-a-real-user-password', self._dummy_salt)
        if self.path.is_symlink():
            raise AccessError(500, '账户数据库不能是符号链接。')
        # Pre-create privately before sqlite sees the file; sqlite inherits
        # these permissions for rollback journal files. No process-wide umask.
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        os.close(descriptor)
        self.path.chmod(0o600)
        connection = self._connect()
        try:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS principals (
                    workspace_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL CHECK(kind IN ('account','guest')),
                    username TEXT UNIQUE,
                    password_salt BLOB,
                    password_hash BLOB,
                    created_at REAL NOT NULL,
                    CHECK((kind='guest' AND username IS NULL AND password_salt IS NULL AND password_hash IS NULL)
                       OR (kind='account' AND username IS NOT NULL AND password_salt IS NOT NULL AND password_hash IS NOT NULL))
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES principals(workspace_id),
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace_id);
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS login_attempts (
                    bucket TEXT PRIMARY KEY,
                    window_start REAL NOT NULL,
                    failures INTEGER NOT NULL CHECK(failures >= 0)
                );
            ''')
        finally:
            connection.close()

    def _connect(self):
        if self.path.is_symlink():
            raise AccessError(500, '账户数据库路径无效。')
        connection = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA secure_delete=ON')
        return connection

    @contextmanager
    def _transaction(self):
        connection = self._connect()
        try:
            connection.execute('BEGIN IMMEDIATE')
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _now(self):
        value = float(self.clock())
        if not math.isfinite(value):
            raise AccessError(500, '服务器时间不可用。')
        return value

    @staticmethod
    def _principal(row):
        return {'workspace_id': row['workspace_id'], 'kind': row['kind'],
                'username': row['username'], 'expires_at': _iso(row['expires_at'])}

    def _resolve(self, connection, token, now):
        digest = _token_digest(token)
        if digest is None:
            return None
        return connection.execute('''
            SELECT p.workspace_id,p.kind,p.username,s.expires_at
            FROM sessions s JOIN principals p ON p.workspace_id=s.workspace_id
            WHERE s.token_hash=? AND s.expires_at>?
        ''', (digest, now)).fetchone()

    def _session(self, connection, workspace_id, kind, now):
        token = secrets.token_urlsafe(32)
        expiry = now + (GUEST_TTL if kind == 'guest' else ACCOUNT_TTL)
        connection.execute('INSERT INTO sessions(token_hash,workspace_id,created_at,expires_at) VALUES(?,?,?,?)',
                           (_token_digest(token), workspace_id, now, expiry))
        row = connection.execute('SELECT workspace_id,kind,username,? AS expires_at FROM principals WHERE workspace_id=?',
                                 (expiry, workspace_id)).fetchone()
        return {'token': token, 'principal': self._principal(row)}

    def resolve(self, token):
        with self._transaction() as connection:
            row = self._resolve(connection, token, self._now())
            return self._principal(row) if row is not None else None

    def _creation_slot(self, connection, action, remote, now, limit):
        bucket = action + ':' + hashlib.sha256(str(remote)[:256].encode()).hexdigest()
        previous = connection.execute('SELECT window_start,failures FROM login_attempts WHERE bucket=?', (bucket,)).fetchone()
        active = previous is not None and previous['window_start'] + CREATION_WINDOW > now
        if active and previous['failures'] >= limit:
            raise AccessError(429, '创建尝试过多，请稍后重试。', max(1, math.ceil(previous['window_start'] + CREATION_WINDOW - now)))
        start, count = (previous['window_start'], previous['failures'] + 1) if active else (now, 1)
        connection.execute('INSERT INTO login_attempts(bucket,window_start,failures) VALUES(?,?,?) '
                           'ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,failures=excluded.failures',
                           (bucket, start, count))

    def start_guest(self, existing_token=None, remote=''):
        with self._transaction() as connection:
            now = self._now()
            existing = self._resolve(connection, existing_token, now)
            if existing is not None:
                # Reopening trial never rotates/extends its fixed lifetime,
                # nor silently replaces a signed-in account with a new guest.
                return {'token': existing_token, 'principal': self._principal(existing)}
            self._creation_slot(connection, 'guest', remote, now, GUEST_LIMIT)
            workspace_id = uuid.uuid4().hex
            connection.execute('INSERT INTO principals(workspace_id,kind,created_at) VALUES(?,?,?)',
                               (workspace_id, 'guest', now))
            return self._session(connection, workspace_id, 'guest', now)

    def register(self, username, password, guest_token=None, remote=''):
        # Commit an attempt before validation and expensive password hashing so
        # repeatedly malformed/duplicate registrations cannot bypass the cap.
        with self._transaction() as connection:
            self._creation_slot(connection, 'register', remote, self._now(), REGISTER_LIMIT)
        normalized = _username(username)
        if normalized is None:
            raise AccessError(422, '用户名须为 3 至 32 位小写字母、数字、下划线或连字符，并以字母或数字开头。')
        if not _valid_password(password):
            raise AccessError(422, '密码须为 12 至 128 个字符。')
        salt = secrets.token_bytes(16)
        password_hash = _password_hash(password, salt)
        try:
            with self._transaction() as connection:
                now = self._now()
                guest = self._resolve(connection, guest_token, now) if guest_token is not None else None
                if guest_token is not None and guest is None:
                    raise AccessError(401, '体验会话已失效，请重新开始体验或直接注册。')
                if guest is not None and guest['kind'] != 'guest':
                    raise AccessError(409, '当前已登录，请先退出后再创建账户。')
                if connection.execute('SELECT 1 FROM principals WHERE username=?', (normalized,)).fetchone():
                    raise AccessError(409, '无法使用此用户名创建账户，请尝试其他用户名或登录。')
                workspace_id = guest['workspace_id'] if guest is not None else uuid.uuid4().hex
                if guest is None:
                    connection.execute('''INSERT INTO principals(workspace_id,kind,username,password_salt,password_hash,created_at)
                                          VALUES(?,?,?,?,?,?)''', (workspace_id, 'account', normalized, salt, password_hash, now))
                else:
                    connection.execute('''UPDATE principals SET kind='account',username=?,password_salt=?,password_hash=?
                                          WHERE workspace_id=? AND kind='guest' ''', (normalized, salt, password_hash, workspace_id))
                    connection.execute('DELETE FROM sessions WHERE workspace_id=?', (workspace_id,))
                return self._session(connection, workspace_id, 'account', now)
        except sqlite3.IntegrityError:
            raise AccessError(409, '无法创建账户，请尝试其他用户名或重新登录。') from None

    def login(self, username, password, remote=''):
        normalized = _username(username)
        # Invalid inputs take the same response and bounded password-check path
        # as unknown accounts. Store only a keyed bucket digest, never a raw IP.
        bucket_user = normalized or (str(username)[:128].strip().lower() if username is not None else '')
        bucket = hashlib.sha256(json.dumps([bucket_user, str(remote)[:256]], ensure_ascii=True).encode()).hexdigest()
        failure = None
        response = None
        with self._transaction() as connection:
            now = self._now()
            attempt = connection.execute('SELECT window_start,failures FROM login_attempts WHERE bucket=?', (bucket,)).fetchone()
            active = attempt is not None and attempt['window_start'] + LOGIN_WINDOW > now
            if active and attempt['failures'] >= LOGIN_LIMIT:
                failure = AccessError(429, '登录尝试过多，请稍后重试。', max(1, math.ceil(attempt['window_start'] + LOGIN_WINDOW - now)))
            else:
                account = connection.execute("SELECT * FROM principals WHERE username=? AND kind='account'",
                                             (normalized,)).fetchone() if normalized else None
                salt = account['password_salt'] if account else self._dummy_salt
                expected = account['password_hash'] if account else self._dummy_hash
                supplied = _password_hash(password if _valid_password(password) else 'invalid-password-value', salt)
                valid = hmac.compare_digest(supplied, expected) and account is not None and _valid_password(password)
                if valid:
                    connection.execute('DELETE FROM login_attempts WHERE bucket=?', (bucket,))
                    response = self._session(connection, account['workspace_id'], 'account', now)
                else:
                    start = attempt['window_start'] if active else now
                    failures = attempt['failures'] + 1 if active else 1
                    connection.execute('INSERT INTO login_attempts(bucket,window_start,failures) VALUES(?,?,?) '
                                       'ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,failures=excluded.failures',
                                       (bucket, start, failures))
                    failure = AccessError(401, '用户名或密码不正确。')
                connection.execute('DELETE FROM login_attempts WHERE window_start<?', (now - CREATION_WINDOW * 2,))
        # Raise only after committing the failed-attempt count.
        if failure is not None:
            raise failure
        return response

    def logout(self, token):
        digest = _token_digest(token)
        if digest is None:
            return
        with self._transaction() as connection:
            connection.execute('DELETE FROM sessions WHERE token_hash=?', (digest,))
