# VisionEcho frontend development

[English](FRONTEND.md) | [简体中文](FRONTEND.zh-CN.md)

The frontend is a React 19 and TypeScript single-page application built with Vite 8. It uses Fluent UI components, Lucide icons, Tailwind CSS and application styles. It includes the product overview, workspace access, video library and production editor.

## Application structure

| File or directory | Responsibility |
|---|---|
| `src/main.tsx`, `src/App.tsx` | Mount React, UI preferences, the access gate and workspace. |
| `src/components/AccessGate.tsx`, `src/accessSession.ts` | Load local or hosted sessions; provide guest access, account forms and session refresh in hosted mode. |
| `src/pageNavigation.ts` | Coordinate overview sections and workspace navigation through URL hashes without a routing library. |
| `src/components/LandingPage.tsx` | Product overview and the illustrative original/described sample. |
| `src/components/LandingTimingDemo.tsx`, `LandingImpact.tsx`, `useLandingMotion.ts` | Timing explanation, accessibility content and overview animation, including reduced-motion handling. |
| `src/components/LocalVideoWorkspace.tsx` | Video library, search and filters, project organization, uploads, settings and trash. |
| `src/components/workspace/ProjectStudio.tsx` | Coordinate preparation, generation, review and export; manage player, version and editing state. |
| `src/components/workspace/StudioProgress.tsx` | Generation steps and processing progress. |
| `src/components/workspace/StudioReviewPanel.tsx`, `useStudioReview.ts` | Segment review states, risk filters, text edits and requested model rewrites. |
| `src/components/workspace/EvidencePanel.tsx` | Reference frames, source-video jumps and saved visual correction feedback. |
| `src/components/workspace/CharacterPanel.tsx`, `characterUtils.ts` | Character cards, detection results, name confirmation and replacement previews. |
| `src/components/workspace/ComparisonPreview.tsx`, `timeline.ts` | Original/described comparison and source/output time mapping for extended narration. |
| `src/components/workspace/subtitleDisplay.ts` | Subtitle validation, speaker labels and overlapping-cue display. |
| `src/components/workspace/StudioQualityReport.tsx`, `StudioExportMenu.tsx` | Export view and format selection. Despite its filename, `StudioQualityReport` is an export panel, not an automated quality score. |
| `src/api.ts`, `src/localWorkspaceApi.ts`, `src/types.ts` | Same-origin API transport, upload requests, typed workspace operations and data contracts. |
| `src/UiPreferencesProvider.tsx`, `src/uiPreferences.ts` | Interface language, theme persistence and Fluent UI theme tokens. |
| `src/workspace.css`, `src/ui-theme.css`, component CSS files | Workspace layout, light/dark themes and styles for the overview, access and editor modules. |

## Local development

Run `./run-local.sh` from the repository root to start both services. To run only the frontend, first start FastAPI on `127.0.0.1:8000`, then use:

```bash
cd dashboard/frontend
npm ci
npm run dev
```

Vite development and preview servers bind to `127.0.0.1:5174` and proxy `/api/*`, including uploads and media requests, to the backend. No frontend mode variable is required. The root URL opens the overview; `#visionecho-content` opens the workspace when the session permits access. See the [local setup guide](../../RUN-LOCAL.md).

## State and API contracts

- React state holds the selected video, version and unsaved edits. The backend stores projects, tasks, media, saved subtitles, evidence feedback, character cards and review records. Generation progress is polled from the backend.
- Generation and revoicing create new versions. Subtitle and review updates carry revision numbers to reject stale writes. The UI asks before discarding unsaved edits.
- Dialogue language, narration language and interface language are independent. Dialogue options are automatic detection, Chinese, English and no dialogue. Changing the voice preserves the current version's narration language.
- Subtitle editing supports adding and deleting cues, changing text and times, and editing speaker labels. Overlap is valid only for different known speakers. Saved edits update previews and subtitle downloads; subtitles are not burned into the MP4.
- Extended narration changes output duration. Playback, source-frame jumps and subtitle display must use the appropriate source or output time; keep conversions in `timeline.ts`.
- Segment rewrites update the editing draft. Revoicing saves changed narration into a new video version. Review states organize corrections but do not block downloads.
- The export menu downloads the saved MP4, dialogue SRT/VTT or voiced narration TXT. Unsaved changes are excluded.
- UI language and theme use browser local storage. A fresh overview visit starts in English; a direct workspace visit restores the saved Chinese or English preference. Both restore the theme selection.
- API requests use same-origin `/api` URLs. `api.ts` reports session expiry on HTTP 401 and does not automatically retry mutations. Hosted access uses a server session; deployment and workspace isolation belong to the backend.

## Build and verification

```bash
npm run build
npm test
npm run lint
```

The build runs TypeScript checks and writes static files to `dist/`. Vitest uses jsdom and Testing Library; tests live alongside components and under `src/__tests__/`. `npm run preview` previews the build and still requires the backend. A deployed static frontend also needs same-origin `/api` routing to the configured backend; see the [deployment guide](../../deploy/README.md).

## Configuration and sample assets

Azure credentials are read by the backend from the repository-root `.env.local` file or server environment. Never put credentials in frontend code or `VITE_*` variables; exposed Vite variables are bundled into the client. `GET /api/health` reports configuration, available languages and upload limits without testing a live Azure connection.

The overview media in `public/assets/landing/` is a prepared illustration, not an output from the Azure generation pipeline. Keep its source, license and production notes with the assets: [sample provenance](public/assets/landing/SOURCE.md).
