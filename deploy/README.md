# Deploy VisionEcho on a Linux server

**English** | [简体中文](README.zh-CN.md)

This setup runs one HTTPS website. Caddy receives public requests, while VisionEcho handles sessions, video processing, and the API in a separate container. Accounts and guest media live in a persistent volume; the deployment does not read examples from a maintainer’s computer.

## Prerequisites

- A Linux x86_64 server with Docker Engine and the Docker Compose plugin.
- At least 2 CPU cores and 4 GB RAM are recommended, plus disk space for temporary media and exports. Only one generation task runs at a time.
- A domain you control, with an A record pointing to the server’s public IPv4 address. Remove incorrect AAAA records if working IPv6 is unavailable.
- Incoming TCP 80 and 443 allowed. Restrict SSH to maintainer sources. Do not publicly expose ports 8000, 5174, or database ports.
- For a server in mainland China serving a website under your own domain, complete applicable filing requirements first. This setup cannot create a working public HTTPS address without a domain.

Deploy from a clean code checkout. Do not upload `.local-data`, `.hosted-data`, `.env.local`, or private example media. Docker builds use the repository’s source allowlist; accounts, videos, and credentials do not belong in the image.

## Configure the domain and service credentials

Run these commands from the repository root for a first deployment. Keep existing configuration files during updates:

```bash
cp deploy/server.env.example deploy/server.env
chmod 600 deploy/server.env
cp deploy/Caddyfile.example deploy/Caddyfile
```

Edit `deploy/server.env` on the server. `DOMAIN` must be the actual domain without a scheme or path; put Azure credentials only in this private environment file. Compose sets `PUBLIC_ORIGIN` to the domain’s HTTPS origin. Do not paste environment files into chat, commit them, or share expanded configuration output.

Compose sets `MAX_UPLOAD_MB=1024`, a 1 GiB file limit. Guests may upload at most five videos, each at most 60 seconds, and use five AI operations in total. Generation, revoicing, subtitle calibration, character detection, and AI rewriting share that allowance. Registered accounts use the deployment’s duration limit and currently have no total AI operation cap.

The frontend splits files into requests no larger than 8 MiB. Caddy retains its `max_size 1GB` request limit and 150-second read / write timeouts. The backend validates total file size. Processing is asynchronous and generated files are downloaded once ready, so one HTTP request does not wait for the complete workflow.

## Build and start

Compose assigns Caddy a fixed private Docker IP. The backend trusts forwarded client addresses only from that IP, so login and guest rate limits use the visitor’s actual address. If the default subnet conflicts with an existing server network, change both `VISIONECHO_SUBNET` and `CADDY_PRIVATE_IP` in the environment file. Do not trust arbitrary proxy sources.

```bash
docker compose --env-file deploy/server.env -f deploy/compose.yml build app
docker compose --env-file deploy/server.env -f deploy/compose.yml up -d --no-build
docker compose --env-file deploy/server.env -f deploy/compose.yml ps
```

Alternatively, load a verified Linux amd64 image onto the server, or set `VISIONECHO_IMAGE` to a tag you are authorized to pull before starting. Do not assume a private repository supplies a public image; pull only an actual provided image address.

The application runs as UID / GID `10001`. A newly created `visionecho_app-data` named volume inherits ownership and mode `0700` from `/data` in the image. If using a host bind mount, first assign a new dedicated directory to `10001:10001`. Do not mount an existing private media directory.

## Verify

- Compose should show the app as `healthy`. Its image health check requests `/healthz` with the configured Host.
- Open the real HTTPS domain and verify the certificate. The first visit should show an English introduction with language switching, login, and guest trial entry points.
- Use two independent browser sessions. Accounts and guests should see only their own uploads. A media link copied to another session should return 404, or 401 after logout.
- Upload synthetic or explicitly authorized short footage. Verify chunked upload, progress, playback, and export. Do not use a maintainer’s private examples for public demonstrations.
- Verify guest limits of five uploads, 1 GiB / 60 seconds per file, and five AI operations. A generated result should be directly downloadable; optional review and quality notices must not block exports.

Inspect recent errors with the following command, but do not publish complete logs:

```bash
docker compose --env-file deploy/server.env -f deploy/compose.yml logs --tail=100 app caddy
```

If Caddy cannot obtain a certificate, check DNS, firewall rules for 80 / 443, server time, and applicable domain filing status. Do not hide configuration errors by disabling HTTPS or browser certificate checks.

## Update, back up, and stop

Wait for processing to finish before an update. Stop the containers, then back up the persistent volume so SQLite and workspace JSON are not copied mid-write. Backups include user media and account data and need restricted storage.

```bash
docker compose --env-file deploy/server.env -f deploy/compose.yml stop
# Back up app-data using the server or cloud platform's volume backup tools.
docker compose --env-file deploy/server.env -f deploy/compose.yml build app
docker compose --env-file deploy/server.env -f deploy/compose.yml up -d --no-build
```

`docker compose down` preserves named volumes by default. Do not use `down -v`, which deletes hosted data. Do not scale to multiple application replicas or workers: the workspace index and processing lock currently require one process.

See [Accounts, trials, and data isolation](../DEPLOYMENT-PRIVACY.md) for account boundaries, session lifetimes, and remaining limits. This directory contains deployment configuration; it does not imply that a server or domain has been purchased or the website is already live.
