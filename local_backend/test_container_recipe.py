"""Static packaging guardrails; these do not substitute for a Docker build."""
from pathlib import Path
import re
import json
import shlex


ROOT = Path(__file__).resolve().parents[1]


def test_runtime_recipe_uses_a_single_nonroot_hosted_service():
    dockerfile = (ROOT / 'Dockerfile').read_text()
    assert 'FROM node:22-bookworm-slim AS frontend' in dockerfile
    assert 'FROM python:3.12-slim-bookworm AS runtime' in dockerfile
    assert 'ACCESS_MODE=hosted' in dockerfile and 'HOSTED_DATA_DIR=/data' in dockerfile
    assert 'USER 10001:10001' in dockerfile and 'VOLUME ["/data"]' in dockerfile
    assert '--workers", "1"' in dockerfile and '--port", "8000"' in dockerfile
    assert '--reload' not in dockerfile
    assert 'COPY --from=frontend /build/dist/' in dockerfile
    assert 'ffmpeg libasound2 libssl3' in dockerfile
    assert 'AudioStreamFormat' in dockerfile
    assert ' +    ' not in dockerfile
    for line in dockerfile.splitlines():
        if line.startswith('RUN '):
            assert shlex.split(line[4:])
        if line.startswith('CMD '):
            assert json.loads(line[4:])[0] == 'python'
        if line.startswith('HEALTHCHECK '):
            command = json.loads(line.split(' CMD ', 1)[1])
            compile(command[2], '<container-healthcheck>', 'exec')
            assert '/healthz' in command[2] and "'Host':origin.netloc" in command[2]


def test_docker_sources_are_explicit_and_exclude_private_storage():
    dockerfile = (ROOT / 'Dockerfile').read_text()
    copy_lines = [line for line in dockerfile.splitlines() if line.startswith('COPY ')]
    assert copy_lines
    assert all(not re.match(r'COPYs+.s', line) for line in copy_lines)
    assert all('.env' not in line and '.local-data' not in line and '.hosted-data' not in line for line in copy_lines)
    assert not re.search(r'^s*(ARG|ENV)s+.*(?:API_KEY|SPEECH_KEY)s*=', dockerfile, re.M)
    ignore = (ROOT / '.dockerignore').read_text().splitlines()
    rules = [line for line in ignore if line and not line.startswith('#')]
    assert rules[0] == '**', 'Build context must start from an explicit source allowlist.'
    for required in ('!Dockerfile', '!local_backend/*.py', '**/.env', '**/.env.*', '**/.local-data/**',
                     '**/.hosted-data/**', '**/*.sqlite3', 'local_backend/test_*.py', 'local_backend/check_*.py'):
        assert required in rules
