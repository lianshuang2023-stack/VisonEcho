"""Render an immutable audio-description revision without repeating recognition."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import shutil
import time
from typing import Any

import httpx

from .pipeline import (
    MAX_AUDIO_SPEED, SAMPLE_RATE, PipelineError, StepCallback, _mix_video,
    _number, _run, _setting, _synthesize, _word_count, audio_speed_to_fit,
    build_narration_track, probe_media, speech_synthesis_url,
)


def render_revision(input_path: Path, output_dir: Path, settings: Any,
                    source_result: dict[str, Any], edits: list[dict[str, Any]],
                    on_step: StepCallback) -> dict[str, Any]:
    """Re-synthesize source windows; edits can change text, never timing.

    The route resolves the trusted source result and validates edit indices.
    Each render writes a new directory and leaves its source artifacts intact.
    """
    started = time.monotonic()
    input_path, output_dir = Path(input_path).resolve(), Path(output_dir).resolve()
    on_step("ValidateInput", "RUNNING", {})
    if not input_path.is_file():
        raise PipelineError("The uploaded video file is missing.")
    transcript_source = Path(source_result.get("transcript_path") or "").resolve()
    if not transcript_source.is_file():
        raise PipelineError("The source transcript is missing; restore it before creating a revision.")
    if output_dir.exists() and (not output_dir.is_dir() or any(output_dir.iterdir())):
        raise PipelineError("A revision must use a new, empty output directory to preserve earlier versions.")
    for name in ("output_path", "transcript_path", "narration_path"):
        path = source_result.get(name)
        if path and output_dir == Path(path).resolve().parent:
            raise PipelineError("A revision cannot replace its source version.")
    media = probe_media(input_path, settings)
    extended = source_result.get('narration_mode') == 'extended'
    if extended:
        transcript_source = Path(source_result.get('source_transcript_path') or '').resolve()
        if not transcript_source.is_file():
            raise PipelineError('扩展版本缺少原片时间轴，请从原片重新生成。')
    if not media["has_video"]:
        raise PipelineError("The uploaded file has no video stream.")
    limit = _number(_setting(settings, "max_video_seconds", 600), "Maximum video duration")
    if media["duration"] > limit:
        raise PipelineError(f"This video is {media['duration']:.1f} seconds long; the local limit is {limit:g} seconds.")
    segments = deepcopy(source_result["segments"])
    text_edits = {edit["segment_index"]: edit["dvi_text"] for edit in edits}
    if set(text_edits) - {segment["segment_index"] for segment in segments}:
        raise PipelineError("A revised description refers to an unknown source segment.")
    for segment in segments:
        for field in ("audio_path", "audio_duration", "raw_audio_duration", "tempo_multiplier",
                      "ssml_rate_percent", "pass", "skip_reason", "wpm", "word_count", "char_count"):
            segment.pop(field, None)
        start = _number(segment.get('source_start') if extended else segment["start_time"], "Description start")
        end = _number(segment.get('source_end') if extended else segment["end_time"], "Description end")
        if start < 0 or end <= start or end > media["duration"] + 1e-6:
            raise PipelineError("A source description window lies outside the uploaded video.")
        text = text_edits.get(segment["segment_index"], segment.get("dvi_text", ""))
        if not isinstance(text, str):
            raise PipelineError("Revised descriptions must be text.")
        text = " ".join(text.split())
        if text != " ".join(str(segment.get("dvi_text", "")).split()):
            # A rewritten sentence has not been visually matched to the old
            # cards. Keep frame references for review, not asserted identities.
            segment["character_ids"] = []
        segment.update(dvi_text=text, start_time=start, end_time=end, silence_duration=end - start,
                       audio_duration=0.0, word_count=_word_count(text), char_count=len(text), wpm=0.0)
        segment["pass"] = False
        if extended:
            segment['silence_duration'] = 8.0
        if not text:
            segment["skip_reason"] = "Narration was omitted because the revised description is empty."
    if any(segment["dvi_text"] for segment in segments):
        if not _setting(settings, "azure_speech_key"):
            raise PipelineError("Configure the server-side Azure Speech key before rendering narration.")
        speech_synthesis_url(settings)
    output_dir.mkdir(parents=True, exist_ok=True)
    audio_dir = output_dir / "narration"
    audio_dir.mkdir()
    transcript_path = output_dir / "transcript.json"
    shutil.copyfile(transcript_source, transcript_path)
    source_transcript_path = output_dir / 'source-transcript.json'
    shutil.copyfile(transcript_source, source_transcript_path)
    if isinstance(source_result.get("source_transcript_edits"), dict):
        (output_dir / "transcript-edits.json").write_text(
            json.dumps(source_result["source_transcript_edits"], ensure_ascii=False, indent=2), encoding="utf-8")
    on_step("ValidateInput", "SUCCEEDED", {"video_duration": media["duration"], "has_audio": media["has_audio"]})
    usage = {"openai_requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
             "transcription_audio_seconds": 0.0, "tts_requests": 0, "tts_characters": 0}
    on_step("SynthesizeAudio", "RUNNING", {"num_segments": len(segments)})
    with httpx.Client(timeout=httpx.Timeout(600, connect=20), follow_redirects=False) as client:
        for ordinal, segment in enumerate(segments, start=1):
            if segment["dvi_text"]:
                raw_path = audio_dir / f"segment-{segment['segment_index']:03d}-raw.wav"
                rate = _synthesize(segment["dvi_text"], raw_path, segment["silence_duration"], settings, client)
                usage["tts_requests"] += 1
                usage["tts_characters"] += segment["char_count"]
                duration = probe_media(raw_path, settings)["duration"]
                speed = audio_speed_to_fit(duration, segment["silence_duration"])
                segment.update(raw_audio_duration=duration, ssml_rate_percent=rate)
                if speed is None:
                    segment["skip_reason"] = (f"Narration takes {duration:.2f}s and cannot fit in "
                                              f"{segment['silence_duration']:.2f}s within the {MAX_AUDIO_SPEED:g}x tempo limit.")
                else:
                    fitted_path = audio_dir / f"segment-{segment['segment_index']:03d}.wav"
                    _run([str(_setting(settings, "ffmpeg_bin", "ffmpeg")), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                          "-protocol_whitelist", "file,pipe", "-i", str(raw_path),
                          "-af", f"atempo={speed:.8f}", "-ar", str(SAMPLE_RATE), "-ac", "1",
                          "-c:a", "pcm_s16le", str(fitted_path)], "Narration tempo adjustment", 60)
                    fitted_duration = probe_media(fitted_path, settings)["duration"]
                    if fitted_duration > segment["silence_duration"] - 0.03:
                        segment["skip_reason"] = "Narration still exceeds the safe dialogue window after tempo adjustment."
                    else:
                        segment.update(audio_path=str(fitted_path), audio_duration=fitted_duration, tempo_multiplier=speed,
                                       wpm=segment["word_count"] / fitted_duration * 60)
                        segment["pass"] = True
            on_step("SynthesizeAudio", "RUNNING", {"completed_segments": ordinal, "num_segments": len(segments)})
    on_step("SynthesizeAudio", "SUCCEEDED", {"passed_segments": sum(s["pass"] for s in segments), "num_segments": len(segments)})
    on_step("MixAudioTracks", "RUNNING", {})
    narration_path, output_path = output_dir / "narration.wav", output_dir / "described-video.mp4"
    insertions = []
    output_duration = media['duration']
    if extended:
        from .extended import render_extended_video, shift_transcript
        original_transcript = json.loads(source_transcript_path.read_text())
        rendered = render_extended_video(input_path, output_dir, segments, original_transcript, settings, on_step)
        segments = rendered['segments']
        output_duration = rendered['video_duration']
        insertions = rendered['insertions']
        transcript_path.write_text(json.dumps(rendered['transcript'], ensure_ascii=False, indent=2))
        if source_result.get('source_transcript_edits'):
            from .timeline import cues_to_source
            draft = deepcopy(source_result['source_transcript_edits'])
            original_cues = cues_to_source(draft['cues'], source_result.get('insertions', []))
            draft['cues'] = shift_transcript({'cues': original_cues}, insertions)['cues']
            (output_dir / 'transcript-edits.json').write_text(json.dumps(draft, ensure_ascii=False, indent=2))
    else:
        build_narration_track(segments, narration_path, media["duration"])
        _mix_video(input_path, narration_path, output_path, segments, media, settings)
    on_step("MixAudioTracks", "SUCCEEDED", {"video_duration": media["duration"]})
    on_step("RecordSummary", "RUNNING", {})
    summary = {"total_segments": len(segments), "passed_segments": sum(s["pass"] for s in segments),
               "failed_segments": sum(not s["pass"] for s in segments),
               "total_silence_duration": sum(s["silence_duration"] for s in segments),
               "total_audio_duration": sum(s["audio_duration"] for s in segments),
               "video_duration": output_duration, 'source_video_duration': media['duration'], "processing_seconds": time.monotonic() - started}
    if not segments:
        summary["message"] = "No dialogue-free interval meets the minimum duration. The exported video contains the original audio."
    elif not summary["passed_segments"]:
        summary["message"] = "No narration could be fitted. Review skipped segment reasons."
    result = {"segments": segments, "summary": summary, "output_path": str(output_path), "usage": usage,
              'dialogue_status': (source_result.get('source_transcript_edits') or {}).get('dialogue_status', source_result.get('dialogue_status')),
              'dialogue_reason': (source_result.get('source_transcript_edits') or {}).get('dialogue_reason', source_result.get('dialogue_reason')),
              "transcript_path": str(transcript_path), "narration_path": str(narration_path),
              "language": _setting(settings, "speech_language", "en-US"),
              "dialogue_language": _setting(settings, "dialogue_language", "auto"),
              "narration_style": source_result.get('narration_style', 'concise'),
              "voice": _setting(settings, "azure_speech_voice", "en-US-JennyNeural"),
              'narration_mode': 'extended' if extended else 'standard', 'insertions': insertions,
              'source_transcript_path': str(source_transcript_path),
              'outcome': 'audio_description' if summary['passed_segments'] else 'subtitles_only'}
    (output_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    on_step("RecordSummary", "SUCCEEDED", {"summary": summary})
    return result
