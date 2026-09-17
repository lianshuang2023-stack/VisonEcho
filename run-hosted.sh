#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ ! -x .venv/bin/python || ! -f dashboard/frontend/dist/index.html ]]; then
  echo 'Install backend dependencies and run npm --prefix dashboard/frontend run build first.' >&2
  exit 1
fi
if [[ -z "${PUBLIC_ORIGIN:-}" || -z "${HOSTED_DATA_DIR:-}" ]]; then
  echo 'Set PUBLIC_ORIGIN and a separate HOSTED_DATA_DIR before starting hosted mode.' >&2
  exit 1
fi
# A TLS reverse proxy should forward to this loopback service. Do not use
# --reload or multiple workers with the local JSON workspace store.
ACCESS_MODE=hosted exec .venv/bin/python -m uvicorn local_backend.main:create_app --factory \
  --host "${VISIONECHO_HOST:-127.0.0.1}" --port "${VISIONECHO_PORT:-8000}" --workers 1
