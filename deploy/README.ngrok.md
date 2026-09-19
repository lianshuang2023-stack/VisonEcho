# Deploy on a cloud server with ngrok

**English** | [简体中文](README.ngrok.zh-CN.md)

Run VisionEcho on a Linux x86_64 server and expose it through a fixed HTTPS hostname assigned to your ngrok account. This does not require a domain you own, and the original computer can be shut down. ngrok traffic, request, and account limits still apply. Cloud server, network, and Azure usage are billed separately.

`compose.ngrok.yml` is a standalone alternative to the [Caddy setup](README.md), running only `app` and `ngrok`. Do not combine the two Compose files. Its default project name remains `visionecho`, so an existing `app-data` volume under that project is reused. A new server starts with empty workspaces and does not automatically import computer media.

## Prerequisites

- Linux x86_64, Docker Engine, and the Docker Compose plugin; 2 cores and 4 GB RAM recommended.
- A fixed hostname assigned to your ngrok account and an agent authtoken for that account. An ngrok API key is not needed.
- Valid Azure configuration and outbound server access to ngrok, Azure, and image registries.
- A clean code checkout without private examples, `.env.local`, or an account database from the computer.

Public inbound ports 80 / 443 are unnecessary. The app publishes only `127.0.0.1:8000` on the server, and ngrok publishes no inspection port. Do not open 8000, 4040, or 5174 in the security group; restrict SSH to maintainer sources.

## Configure

For a first deployment, create the private environment file from the repository root. Keep and edit an existing file instead of overwriting it:

```bash
cp deploy/server.env.example deploy/server.env
chmod 600 deploy/server.env
```

Fill in Azure settings with a server-side editor, then add the following fields to the same `deploy/server.env`. These are placeholders only:

```dotenv
NGROK_DOMAIN=your-assigned-domain.ngrok-free.app
NGROK_AUTHTOKEN=REPLACE_WITH_YOUR_AGENT_AUTHTOKEN
NGROK_IMAGE=ngrok/ngrok:latest
NGROK_SUBNET=172.30.89.0/24
NGROK_PRIVATE_IP=172.30.89.2
APP_PRIVATE_IP=172.30.89.3
```

`NGROK_DOMAIN` must be an assigned hostname without `https://`, a path, or a port. The original `DOMAIN` variable is for Caddy and is ignored here. Compose sets the exact `PUBLIC_ORIGIN=https://…`; do not rewrite the forwarded Host to `localhost`.

The agent uses the official `ngrok/ngrok` image. The default tag is `latest`; after validating a deployment, pin `NGROK_IMAGE` to the downloaded image’s digest to avoid unexpected version changes. Both containers have fixed, distinct addresses: ngrok uses `172.30.89.2`, and the app uses `172.30.89.3`. Fixing the app address prevents Docker from assigning it the agent’s reserved address when the app starts first.

The app trusts forwarded headers only from `NGROK_PRIVATE_IP`. If the subnet conflicts, change `NGROK_SUBNET`, `NGROK_PRIVATE_IP` and `APP_PRIVATE_IP` together. Both addresses must be different, unused host addresses inside that subnet, and neither may be the network gateway. Do not set `FORWARDED_ALLOW_IPS=*`.

[ngrok.yml.example](ngrok.yml.example) is a credential-free v3 configuration mounted read-only. `agent.web_addr: false` disables the local web UI / API, and `--inspect=false` disables agent-side HTTP inspection. ngrok cloud processing and retention remain subject to account and platform settings; disabling local inspection does not mean traffic bypasses ngrok.

Keep real credentials only in the ignored `deploy/server.env`, not YAML, images, or Git. Only the agent container receives its ngrok token; only the app receives Azure keys. Do not publish `docker inspect` output or expanded Compose configuration without `--quiet`, since environment values may appear.

## Build and validate

These commands do not start a public endpoint. Build the latest app, then obtain the official agent image:

```bash
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml config --quiet
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml build app
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml pull ngrok
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml run --rm --no-deps ngrok config check --config /etc/ngrok.yml
```

If importing a verified image bundle, check the source commit in `build-info.txt`: older bundles do not contain newer code. Import with `docker load` and omit `build app`. Local validation confirmed that ngrok Agent 3.39.11 accepts the v3 configuration and CLI flags; the actual Linux container must still pass the checks above.

## Move an existing fixed hostname to the server

1. Start the cloud app and wait for its status to become `healthy`.
2. Confirm the old computer has no active generation or upload, then stop its ngrok agent using that hostname. Do not run two endpoints for the same hostname or enable pooling.
3. Start ngrok on the server. The hostname remains unchanged; the endpoint can appear offline briefly during the switch.

```bash
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml up -d --no-build app
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml ps
# Start the public endpoint only after the app is healthy and the old one has stopped.
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml up -d --no-build ngrok
```

After changing hostnames, recreate both app and ngrok containers so Host and Origin validation use the new name consistently. Do not publish the original computer’s private workspaces as examples. Migrating hosted user data requires a separately authorized backup migration, kept separate from private local media.

## Verify and operate

- Open the assigned HTTPS hostname and confirm the English introduction loads. Your ngrok plan may show a platform interstitial.
- Use two independent browser sessions to create guests and confirm empty, isolated workspaces.
- Validate upload, generation, playback, and export with synthetic or authorized short footage. Review is optional and does not block downloads of existing files.
- Check `docker compose … ps` and restricted logs. Do not publish complete logs. Port 4040 inspection is intentionally unavailable.

```bash
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml logs --tail=80 app ngrok
```

Containers use `restart: unless-stopped`; also ensure Docker starts at boot. To pause services, use `stop` with the same Compose file. Before backups or updates, wait for jobs to finish, stop the containers, and back up `app-data`. Do not run `down -v`, which removes the data volume. Only one app worker is supported.

See [Accounts, trials, and data isolation](../DEPLOYMENT-PRIVACY.md) for guest quotas, account boundaries, and retention.

## Official references

- [ngrok Docker image and usage](https://ngrok.com/docs/using-ngrok-with/docker)
- [Agent v3 configuration: web_addr](https://ngrok.com/docs/gateway/agent/config/v3)
- [ngrok CLI: http, --url, and --inspect](https://ngrok.com/docs/gateway/agent/cli)
