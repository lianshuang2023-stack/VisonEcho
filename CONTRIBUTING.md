# Contributing to VisionEcho

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

## Reporting an issue

Open an issue in this repository with the expected result, actual result, steps to reproduce, operating system and browser version. Include a minimal test sample that you have permission to share. Do not upload credentials, private videos or a complete local workspace.

## Code changes

1. Create a working branch from the current main branch.
2. Keep changes focused. Cover behavior changes with synthetic media or mocked-service tests.
3. Describe the change, validation results and known limitations in the commit or pull request.
4. Update both English and Chinese documentation when a documented behavior changes.

```bash
.venv/bin/python -m pytest local_backend -q
npm --prefix dashboard/frontend run build
npm --prefix dashboard/frontend run lint
npm --prefix dashboard/frontend test
```

Azure calls should follow explicit user actions. Tests use mocked services by default; live checks require your own resources and consume billable usage.

## Collaboration

Follow the [code of conduct](CODE_OF_CONDUCT.md). Report possible exposure of data or credentials through an existing private channel to the maintainers; do not post sensitive details in public issues. See [LICENSE](LICENSE) for the license.
