# Accounts, trials, and data isolation

**English** | [简体中文](DEPLOYMENT-PRIVACY.zh-CN.md)

VisionEcho supports local and hosted modes. A local workspace contains the operator’s own media. Hosted mode assigns separate directories and indexes to accounts and guest sessions; it does not read or import the maintainer’s local `.local-data/` directory.

## User flow and trial limits

The website root opens an English introduction. Visitors may switch to Chinese, then enter the studio, log in, register, or start a guest trial. Interface language does not change subtitle or narration language.

- **Try as a guest:** creates an isolated workspace without registration. The session lasts 24 hours.
- **Register to keep work:** a username and password convert the current valid guest workspace into an account workspace, retaining its videos.
- **Log in:** shows only the account’s works. Logging in to an existing account does not merge earlier guest media.
- **Log out:** revokes the session on the server. Existing media links still require a valid session. An unregistered guest workspace cannot be recovered after logout, session expiry, or clearing its cookie.

| Guest limit | Current allowance |
|---|---|
| AI operations | 5 in total |
| Uploads | At most 5 |
| File size | 1 GiB: 1024 MiB / 1,073,741,824 bytes |
| Video duration | Up to 60 seconds, or a lower configured server limit |

Generation, revoicing, subtitle calibration, character detection, and per-segment AI rewriting share the AI allowance; each feature does not receive five separate uses. Usage persists with the workspace. Existing guests retain their used count when limits change, and refreshing does not reset it. An accepted processing task can consume an operation even if generation later fails.

Review and quality notices are optional aids, not download gates. Generated files can be exported directly; unsaved drafts do not automatically become part of the downloaded video. Local mode has no guest operation quota. Registered accounts currently have no total AI operation cap, but remain subject to configured file and duration limits and the shared processing slot.

## Accounts and sessions

Passwords must contain 12–24 characters and are stored using scrypt with a random salt. Cookies use HttpOnly and SameSite=Lax, with Secure enabled under HTTPS. Only session token hashes are stored. Account sessions last seven days.

Email verification, password recovery, multifactor authentication, and an administrator view of all works are not currently implemented. Workspace isolation does not provide automatic retention cleanup or backups.

## Start hosted mode

Build the frontend and install backend dependencies from a clean checkout. Do not copy private examples, `.local-data/`, or a real `.env.local`. Inject service credentials through the hosting platform’s secret configuration. See [.env.hosted.example](.env.hosted.example) for variables and [Linux deployment](deploy/README.md) for the container walkthrough.

Install Python 3.12, Node.js 22 or 24 LTS, and FFmpeg / FFprobe, then run from the repository root:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r local_backend/requirements.txt
npm --prefix dashboard/frontend ci
npm --prefix dashboard/frontend run build
PUBLIC_ORIGIN=https://your-domain.example HOSTED_DATA_DIR=/srv/visionecho-data ./run-hosted.sh
```

Replace the example domain and directory and supply Azure configuration through the environment. By default, the backend listens on `127.0.0.1:8000` behind an HTTPS reverse proxy. Production pages and API share one domain. Preserve Host, trust only actual proxy sources, and disable shared caching. `PUBLIC_ORIGIN` must be an exact HTTPS origin; HTTP loopback is accepted for local verification. `HOSTED_DATA_DIR` and `LOCAL_DATA_DIR` must neither match nor contain one another.

Hosted storage layout:

```text
hosted-data/
  access/access.sqlite3          # Accounts, session hashes, and rate-limit records
  workspaces/<opaque workspace ID>/ # Separate videos, jobs, subtitles, cards, and frames
```

The JSON workspace store supports one process. `run-hosted.sh` forces one worker, and a directory lock prevents a second instance from using the same hosted directory. All users share one media processing slot. Scaling requires a durable job queue and database.

## Data transfer and private examples

Account isolation does not make cloud AI processing local. Generation sends the required audio, keyframes, and text to configured Azure services. Revoicing, subtitle calibration, character detection, and AI rewriting send their respective inputs. No-dialogue mode skips speech recognition but still uses visual analysis and narration synthesis.

Works, upload tokens, source and output media, subtitles, keyframes, character cards, Trash, and background tasks all select a workspace from the session. Supplying another user’s ID does not change identity. Private API and media responses disable shared caching, and data is not stored in a public static directory.

`.gitignore` excludes local / hosted data and real environment configuration. `.dockerignore` uses a source allowlist to keep private media outside the container build context. The curated public landing-page demo is explicitly included with source and license notes. Other deployment tools must also publish from a clean checkout. Do not copy private media into public directories, repositories, images, introduction-page screenshots, or demo assets. Public demonstrations should use synthetic or explicitly authorized material. Existing local examples remain private and are not automatically published as hosted demos.

## Operational limits

Guest creation, registration, and login attempts have server-side rate limits; guest AI usage persists per workspace. Public services also need edge rate limits and an overall Azure budget, particularly because registered accounts currently have no total AI quota. Expired guests lose access, but their media is not automatically deleted. Configure retention, cleanup, and backups for the actual service.

Isolation tests cover multiple accounts and guests, logout and expiry, cross-account links, Range video requests, subtitles / frames / cards / calibration tasks, and guest-to-account conversion. Tests do not replace verification of the deployed HTTPS, reverse proxy, and storage configuration.
