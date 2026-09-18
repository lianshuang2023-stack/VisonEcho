# Run VisionEcho locally

**English** | [简体中文](RUN-LOCAL.zh-CN.md)

VisionEcho is a workspace for creating audio-described videos. Source videos, versions, and edits stay on the local device. Dialogue transcription, visual analysis, character analysis, and narration synthesis use the configured Azure services. Local mode does not require an account; hosted guest quotas do not apply to the local workspace.

## Dependencies and configuration

Install Python 3.12, Node.js 22 or 24 LTS, FFmpeg / FFprobe, and provision Azure OpenAI and Azure Speech resources. Run these commands from the repository root:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r local_backend/requirements-dev.txt
npm --prefix dashboard/frontend ci
```

For the first run, create `.env.local` from [.env.azure.example](.env.azure.example). Keep an existing configuration instead of overwriting it:

```bash
cp .env.azure.example .env.local
chmod 600 .env.local
```

Fill in the configuration with a local editor. `AZURE_OPENAI_DEPLOYMENT` must match a deployment in your Azure resource; the template defaults to `gpt-5.6-terra`. Speech accepts a custom resource endpoint or an explicit region. Set `AZURE_SPEECH_KEY` separately when Speech and OpenAI use different resources. Restart the services after configuration changes.

Only the backend reads `.env.local`, which Git ignores. Do not put credentials in frontend variables, documentation, or commits.

## Start

```bash
./run-local.sh
```

- Website: [http://127.0.0.1:5174/](http://127.0.0.1:5174/)
- API documentation: [http://127.0.0.1:8000/api/docs](http://127.0.0.1:8000/api/docs)

The website root opens the introduction in English. Switch to Chinese if preferred, then enter the studio. Interface language and light / dark appearance do not translate subtitles or change narration language. Press `Ctrl+C` to stop both services.

## Create a described video

1. In **My videos**, choose **Upload video**, assign an existing or new project, or leave it uncategorized, and upload an MP4. Local defaults are 500 MiB per file and 10 minutes; backend environment variables can adjust them.
2. Open the video and choose its original dialogue language: automatic detection, Chinese, English, or no dialogue. Choose the narration language and voice independently. English dialogue can have Chinese narration, and vice versa.
3. Select a narration mode and generate. Auto mode first uses natural dialogue gaps. When gaps are insufficient, it pauses the picture to insert narration, preserves the original dialogue, and extends the output. Natural gaps mode keeps the original duration; Extended mode adds pauses for narration.
4. Preview the video, narration, and subtitles. Generated files can be downloaded immediately, with review available as an optional step. Review labels, quality notices, and character confirmation do not block export. After editing the script or changing the current version’s voice, select **Revoice and save version** to update the rendered video.
5. Use the export menu for MP4, SRT / VTT subtitles, or a TXT narration script. Downloads reflect saved versions; unsaved drafts do not automatically appear in the rendered video.

Dialogue language controls source recognition; narration language controls the new script and speech. Subtitles retain the source language. Changing only an existing version’s voice preserves its script language.

| Narration language | Voices |
|---|---|
| Mandarin Chinese | Xiaoxiao (female), Yunxi (male), Xiaoyi (female) |
| English | Jenny (female), Guy (male), Aria (female) |

## Subtitles, multiple speakers, and videos without dialogue

Azure Speech SDK supplies final recognition results and word-level timestamps, with automatic Mandarin / English identification. The application uses conversation transcription for speaker separation when supported by the installed SDK, with continuous recognition as a fallback. Speaker labels are audio-based, do not establish real identities, and are not automatically linked to people in frames. Overlapping speech can be missed and requires listening back.

Long phrases split at measured word boundaries and sentence endings. Original recognition records retain punctuation; subtitle previews and exports remove sentence punctuation while preserving apostrophes within words, decimal / thousands separators in numbers, and English word spacing. The editor supports text, start / end time, speaker labels, and adding or removing cues. Cues may overlap for different identified speakers. Overlaps for the same or unknown speakers must be corrected. Low-confidence dialogue displays a review notice.

For material known to contain only music or ambience, choose **No dialogue** to skip transcription and generate visual narration. An empty recognition result from audible material is not treated as silence: it is marked as unreliable dialogue recognition. Auto and Extended modes place narration after the original video to avoid covering unknown speech. A missing audio track or near-silent audio is marked as having no transcribable dialogue. Recognized text without valid word timestamps stops processing instead of inventing timing.

Older machine-generated subtitle formatting is refreshed on read without replacing original files or manual edits. To update recognition, select the original dialogue language, save current edits, and choose **Recalibrate subtitles**. After confirmation, the original audio is transcribed again and replaces subtitles for the current version; original audio and narration stay unchanged. Failed recognition or concurrent subtitle edits preserve the existing captions. Recalibrating with **No dialogue** clears that version’s captions without speech recognition.

## Visual evidence and character cards

Expand **Visual evidence** beneath a narration segment to inspect keyframes, source timestamps, and observations recorded during generation. Selecting a frame seeks to that point in the source video. Older versions can obtain locally extracted review frames when generation evidence is absent; these are explicitly marked and are not represented as frames the model originally used. Observations support review but do not guarantee accuracy.

Save notes about incorrect people, actions, or missing content. Saving feedback alone does not call cloud services or rewrite generated audio. Scripts can be edited manually. AI rewriting makes a separate cloud request; revised text requires revoicing to appear in a new rendered version.

Generation enables automatic character detection by default. It builds appearance descriptions, thumbnails, and segment references from keyframes. Completed videos can also run character detection independently through character cards in **Project resources**, without regenerating narration. Each pass inspects up to 24 frames from 12 narration windows; sampling can miss people.

Distinctive fictional characters may receive names when costumes, masks, emblems, or animation designs provide sufficient visual evidence. The application does not infer real actors’ or ordinary people’s identities from faces; uncertain figures remain appearance-based. Existing manually assigned names are not overwritten. Editing an automatic name makes it a manual choice. Each video supports up to 40 character cards; failed detection can be retried separately.

You can also add a character from a keyframe, enter appearance, preferred name, and aliases, or associate a frame with an existing card. Keep separate cards when identity continuity is uncertain. Confirmed or automatically recognized names are generation references only when the frame clearly matches. Renaming or checking names provides affected segments and a replacement preview; applying replacements changes the draft only. Historical scripts and audio remain unchanged.

## Projects, versions, and Trash

**My videos** defaults to unarchived videos, sorted by recent edits. Projects organize and filter works; project management supports creating, renaming, and deleting categories. The default category appears as **Uncategorized**. Search matches video and project names. Uploads and edits refresh the list, and running jobs update automatically.

Each work’s more menu supports renaming, moving, archiving, and deleting. Deletion moves items to Trash, preserving source videos, captions, and versions for restoration. Deleting a project hides its videos as well. Archiving is separate from production state and deletion. Items involved in uploads or processing cannot be deleted while active.

Review and export-ready labels describe production and review progress. Existing generated files remain downloadable. Subtitles-only, partial narration, or missing narration outcomes are identified and must not be mistaken for complete audio description. Automatic extension currently uses at most four pause locations, with an eight-second narration budget per location. Subtitle and playback timelines adjust to the output.

## Verify

```bash
.venv/bin/python -m pytest local_backend -q
npm --prefix dashboard/frontend run build
cd dashboard/frontend
./node_modules/.bin/vitest run
```

Tests use synthetic media and simulated service responses to cover language selection, speaker-aware subtitles, no-dialogue handling, timelines, frame extraction, version inheritance, extended exports, recoverable deletion, and session isolation. Passing tests does not establish equal recognition accuracy for all videos.

To explicitly test configured Azure services, run the following from the repository root. It uses generated audio and geometric images and incurs real service usage:

```bash
.venv/bin/python -m local_backend.check_quality_smoke
```

Media tasks share one processing slot. Generation, revoicing, subtitle calibration, character detection, and AI rewriting may call Azure. Manual text saves, previews, and downloads of existing files are local.

## Current limits

- Descriptions use sampled keyframes. Fast actions, brief on-screen text, and scene changes still require review.
- Subtitle calibration is not a database transaction: a failed final index write can report a failed task after captions have been replaced.
- Refreshing or opening another tab during calibration does not automatically reconnect that page to the calibration task. Reopen the work after completion.
- Do not publish local data directories, private examples, or real configuration files. See [Accounts, trials, and data isolation](DEPLOYMENT-PRIVACY.md) for hosted behavior and [Linux deployment](deploy/README.md) for server instructions.

## Official interface references

- [Speech SDK word timing and final recognition results](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-speech-recognition-results?pivots=programming-language-python)
- [Speech conversation transcription and diarization](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization)
- [Speech custom endpoints](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-private-link#construct-endpoint-url)
