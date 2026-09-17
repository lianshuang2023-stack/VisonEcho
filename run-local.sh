#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo 'Create the Python environment first; see RUN-LOCAL.zh-CN.md.' >&2
  exit 1
fi
if [[ ! -d dashboard/frontend/node_modules ]]; then
  echo 'Install the frontend dependencies first; see RUN-LOCAL.zh-CN.md.' >&2
  exit 1
fi
.venv/bin/python - <<'PY'
import socket
for port in (8000, 5174):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', port))
        except PermissionError:
            raise SystemExit(f'This environment does not permit local port {port}. Run from a terminal with local server access.')
        except OSError as error:
            raise SystemExit(f'Cannot listen on port {port}: {error}. Check whether VisionEcho is already running.')
PY
.venv/bin/python -m uvicorn local_backend.main:create_app --factory --host 127.0.0.1 --port 8000 &
visionecho_api_pid=$!
visionecho_ui_pid=''
cleanup() {
  kill "$visionecho_api_pid" 2>/dev/null || true
  if [[ -n "$visionecho_ui_pid" ]]; then kill "$visionecho_ui_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
.venv/bin/python - <<'PY'
import time, urllib.request
for attempt in range(50):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=1) as response:
            if response.status == 200:
                break
    except OSError:
        time.sleep(0.1)
else:
    raise SystemExit('Local API did not start. Check the error above.')
PY
(cd dashboard/frontend && exec ./node_modules/.bin/vite) &
visionecho_ui_pid=$!
while kill -0 "$visionecho_api_pid" 2>/dev/null && kill -0 "$visionecho_ui_pid" 2>/dev/null; do
  sleep 1
done
echo 'A local service stopped; shutting down the other service.' >&2
exit 1
