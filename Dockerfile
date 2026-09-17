# syntax=docker/dockerfile:1
# Build with --platform linux/amd64 for the Azure Speech Linux runtime.
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY dashboard/frontend/package.json dashboard/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/frontend/index.html dashboard/frontend/tsconfig*.json dashboard/frontend/vite.config.ts ./
COPY dashboard/frontend/src/ ./src/
COPY dashboard/frontend/public/ ./public/
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV ACCESS_MODE=hosted
ENV HOSTED_DATA_DIR=/data
ENV LOCAL_DATA_DIR=/app/.local-data
WORKDIR /app

# Debian's FFmpeg package also supplies the shared codec libraries. The Speech
# SDK requires OpenSSL and ALSA even when transcribing files instead of a mic.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg libasound2 libssl3 && rm -rf /var/lib/apt/lists/*
COPY local_backend/requirements.txt ./local_backend/requirements.txt
RUN python -m pip install --only-binary=:all: -r local_backend/requirements.txt && python -c "import azure.cognitiveservices.speech as speech; speech.audio.AudioStreamFormat(samples_per_second=16000, bits_per_sample=16, channels=1)" && ffmpeg -version >/dev/null && ffprobe -version >/dev/null

RUN groupadd --gid 10001 visionecho && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin visionecho && install -d -m 0700 -o 10001 -g 10001 /data
COPY local_backend/ ./local_backend/
COPY --from=frontend /build/dist/ ./dashboard/frontend/dist/
COPY LICENSE NOTICE ./

# PUBLIC_ORIGIN and Azure credentials are runtime environment variables. A
# persistent volume mounted at /data must be writable by uid/gid 10001.
USER 10001:10001
EXPOSE 8000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["python", "-c", "import os,urllib.request,urllib.parse; origin=urllib.parse.urlsplit(os.environ['PUBLIC_ORIGIN']); request=urllib.request.Request('http://127.0.0.1:8000/healthz',headers={'Host':origin.netloc}); response=urllib.request.urlopen(request,timeout=4); assert response.status == 200"]
CMD ["python", "-m", "uvicorn", "local_backend.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
