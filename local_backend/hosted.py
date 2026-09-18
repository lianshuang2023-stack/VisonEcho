"""Hosted entry: opaque sessions dispatch into separate per-user workspaces.

The laptop Store is never opened here. Media, tasks and all derived resources
use the same authenticated workspace dispatch as the JSON API.
"""
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path
import re
from threading import Lock
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request as ASGIRequest
from starlette.staticfiles import StaticFiles

from .access import AccessError, AccessStore, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH

COOKIE = 'visionecho_session'
GUEST_SECONDS = 60
GUEST_BYTES = 1024 * 1024 * 1024
GUEST_OPERATIONS = 5
GUEST_UPLOADS = 5
PAID_ROUTE = re.compile(r'^/api/(?:trigger/executions|videos/[^/]+/(?:render|transcript/calibrate|characters/detect|segments/[^/]+/rewrite))/?$')


class Credentials(BaseModel):
    model_config = ConfigDict(extra='forbid')
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH)


class Workspaces:
    def __init__(self, settings):
        self.settings = settings
        self.root = settings.hosted_data_dir.resolve()
        private = settings.data_dir.resolve()
        if self.root == private or self.root.is_relative_to(private) or private.is_relative_to(self.root):
            raise ValueError('HOSTED_DATA_DIR must be separate from the private LOCAL_DATA_DIR.')
        if settings.hosted_data_dir.is_symlink():
            raise ValueError('HOSTED_DATA_DIR must not be a symlink.')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.auth = AccessStore(self.root / 'access')
        self.lock, self.processing = Lock(), Lock()
        self.apps = {}

    def application(self, principal):
        from .main import create_app
        key = principal['workspace_id']
        if not re.fullmatch(r'[a-f0-9]{32}', key):
            raise AccessError(401, 'Invalid session. Sign in again.')
        with self.lock:
            directory = self.root / 'workspaces' / key
            if (directory.is_symlink() or (self.root / 'workspaces').is_symlink()
                    or not directory.resolve().is_relative_to(self.root)):
                raise AccessError(503, 'Workspace storage is unavailable.')
            if key not in self.apps:
                if len(self.apps) >= 1024:
                    raise AccessError(503, 'Server workspace capacity reached. Try again later.')
                config = replace(self.settings, access_mode='local', data_dir=directory)
                app = create_app(config)
                app.state.store.busy = self.processing
                self.apps[key] = app
            app = self.apps[key]
            config = app.state.store.settings
            guest = principal['kind'] == 'guest'
            config.max_video_seconds = min(GUEST_SECONDS, self.settings.max_video_seconds) if guest else self.settings.max_video_seconds
            config.max_upload_bytes = GUEST_BYTES if guest else self.settings.max_upload_bytes
            config.workspace_upload_limit = GUEST_UPLOADS if guest else None
            return app

    def session(self, principal):
        if principal is None:
            return {'mode': 'hosted', 'user': None, 'limits': {
                'max_video_seconds': GUEST_SECONDS, 'max_upload_mb': GUEST_BYTES // 1024**2,
                'guest_generations_remaining': GUEST_OPERATIONS}}
        app = self.application(principal)
        store = app.state.store
        with store.lock:
            limits = {'max_video_seconds': store.settings.max_video_seconds,
                      'max_upload_mb': store.settings.max_upload_bytes // 1024**2}
            if principal['kind'] == 'guest':
                limits['guest_generations_remaining'] = max(0, GUEST_OPERATIONS - store.data.get('guest_paid_operations', 0))
        return {'mode': 'hosted', 'user': {'id': principal['workspace_id'],
                **{key: principal[key] for key in ('kind', 'username', 'expires_at')}}, 'limits': limits}


class WorkspaceGateway:
    def __init__(self, registry):
        self.registry = registry

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return
        request = ASGIRequest(scope)
        principal = self.registry.auth.resolve(request.cookies.get(COOKIE, ''))
        if not principal:
            return await JSONResponse({'error': 'Please sign in or start a guest trial.'}, 401)(scope, receive, send)
        if not request.url.path.startswith('/api/'):
            return await JSONResponse({'error': 'Not found.'}, 404)(scope, receive, send)
        try:
            app = self.registry.application(principal)
        except AccessError as error:
            return await JSONResponse({'error': error.message}, error.status_code)(scope, receive, send)
        store = app.state.store
        charged = False
        if principal['kind'] == 'guest':
            if request.method == 'POST' and PAID_ROUTE.fullmatch(request.url.path):
                with store.lock:
                    spent = store.data.get('guest_paid_operations', 0)
                    if spent >= GUEST_OPERATIONS:
                        return await JSONResponse({'error': 'Guest trial used. Register to keep your work and continue.'}, 403)(scope, receive, send)
                    store.data['guest_paid_operations'] = spent + 1
                    try:
                        store.save()
                    except OSError:
                        store.data['guest_paid_operations'] = spent
                        return await JSONResponse({'error': 'Cannot reserve the trial. Try again.'}, 503)(scope, receive, send)
                    charged = True
        async def private_send(message):
            nonlocal charged
            if message['type'] == 'http.response.start':
                paid_attempt = any(k.lower() == b'x-visionecho-paid-operation' and v == b'1'
                                   for k, v in message.get('headers', []))
                # Never allow a CDN/browser shared cache to serve one user’s
                # media, frames, exports or JSON to another session.
                message['headers'] = [(k, v) for k, v in message.get('headers', []) if k.lower() not in (b'cache-control', b'vary', b'x-visionecho-paid-operation')]
                message['headers'].extend([(b'cache-control', b'private, no-store'), (b'vary', b'Cookie')])
                if charged and not paid_attempt and not 200 <= message['status'] < 300:
                    with store.lock:
                        store.data['guest_paid_operations'] = max(0, store.data.get('guest_paid_operations', 1) - 1)
                        store.save()
                    charged = False
            await send(message)
        await app(scope, receive, private_send)


def create_hosted_app(settings):
    origin = settings.public_origin.rstrip('/')
    parsed = urlsplit(origin)
    local_http = parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', 'testserver')
    if (not parsed.hostname or (parsed.scheme != 'https' and not local_http) or parsed.path
            or parsed.query or parsed.fragment or parsed.username or parsed.password):
        raise ValueError('Hosted mode requires PUBLIC_ORIGIN as an HTTPS origin (HTTP loopback is allowed for testing).')
    settings = replace(settings, public_origin=origin)
    registry = Workspaces(settings)
    @asynccontextmanager
    async def lifespan(app):
        # JSON video stores and processing locks are single-process. Fail closed
        # if a second worker points at the same hosted directory.
        with (registry.root / 'server.lock').open('a') as lockfile:
            try:
                fcntl.flock(lockfile.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('Run one VisionEcho worker per HOSTED_DATA_DIR.') from None
            yield
            fcntl.flock(lockfile.fileno(), fcntl.LOCK_UN)
    app = FastAPI(title='VisionEcho', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.workspaces = registry
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[parsed.hostname])

    @app.middleware('http')
    async def origin_guard(request, call_next):
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            if request.headers.get('origin') != origin or request.headers.get('sec-fetch-site') == 'cross-site':
                return JSONResponse({'error': 'Same-origin requests only.'}, 403)
        response = await call_next(request)
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'private, no-store'
            response.headers['Vary'] = 'Cookie'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        return response

    @app.exception_handler(AccessError)
    async def access_error(request, error):
        headers = {'Retry-After': str(error.retry_after)} if error.retry_after else None
        return JSONResponse({'error': error.message}, error.status_code, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def invalid_credentials(request, error):
        return JSONResponse({'error': '请输入有效用户名（3–32 位）和密码（12–24 个字符）。'}, 422)

    def token(request):
        return request.cookies.get(COOKIE)

    def authenticated(response_data):
        response = JSONResponse(registry.session(response_data['principal']))
        expires = datetime.fromisoformat(response_data['principal']['expires_at'].replace('Z', '+00:00'))
        ttl = max(0, int((expires - datetime.now(timezone.utc)).total_seconds()))
        response.set_cookie(COOKIE, response_data['token'], max_age=ttl, httponly=True,
                            secure=parsed.scheme == 'https', samesite='lax', path='/')
        return response

    @app.get('/api/access/session')
    def session(request: Request):
        principal = registry.auth.resolve(token(request))
        response = JSONResponse(registry.session(principal))
        if principal is None and token(request):
            response.delete_cookie(COOKIE, path='/', secure=parsed.scheme == 'https', httponly=True, samesite='lax')
        return response

    @app.get('/healthz')
    def healthcheck():
        # Host/process liveness only; no account data, keys or paid cloud probes.
        return {'status': 'ok', 'mode': 'hosted'}

    @app.post('/api/access/guest')
    def guest(request: Request):
        return authenticated(registry.auth.start_guest(token(request), remote=request.client.host if request.client else ''))

    @app.post('/api/access/register')
    def register(request: Request, payload: Credentials):
        return authenticated(registry.auth.register(payload.username, payload.password, guest_token=token(request),
                             remote=request.client.host if request.client else ''))

    @app.post('/api/access/login')
    def login(request: Request, payload: Credentials):
        return authenticated(registry.auth.login(payload.username, payload.password, remote=request.client.host if request.client else ''))

    @app.post('/api/access/logout')
    def logout(request: Request):
        registry.auth.logout(token(request))
        response = JSONResponse(registry.session(None))
        response.delete_cookie(COOKIE, path='/', secure=parsed.scheme == 'https', httponly=True, samesite='lax')
        return response

    frontend = Path(__file__).resolve().parents[1] / 'dashboard' / 'frontend' / 'dist'
    @app.get('/')
    def home():
        if not (frontend / 'index.html').is_file():
            return JSONResponse({'error': 'Build the frontend before starting hosted mode.'}, 503)
        return FileResponse(frontend / 'index.html', headers={'Cache-Control': 'no-cache'})
    @app.get('/favicon.svg')
    def favicon():
        return FileResponse(frontend / 'favicon.svg')
    if (frontend / 'assets').is_dir():
        app.mount('/assets', StaticFiles(directory=frontend / 'assets'), name='assets')
    app.mount('/', WorkspaceGateway(registry))
    return app
