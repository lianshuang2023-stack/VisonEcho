"""Local extended description: pause the picture without covering source dialogue."""
from __future__ import annotations

import copy
from contextlib import nullcontext
import math
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .pipeline import PipelineError, SAMPLE_RATE, _number, _run, _setting, build_narration_track, probe_media

OUTPUT_FPS = 30
MAX_INSERTIONS = 4
NARRATION_BUDGET_SECONDS = 8.0
TAIL_SECONDS = 0.15
MIX_SAMPLE_RATE = 48_000
MIX_CHANNELS = 2


def _word_intervals(transcript: dict[str, Any], duration: float) -> list[tuple[float, float]]:
    result = []
    for word in transcript.get("words", []):
        start, end = _number(word.get("start"), "Word start"), _number(word.get("end"), "Word end")
        if start < 0 or end <= start or start > duration:
            raise PipelineError("Dialogue word timestamps must be ordered within the source video.")
        result.append((start, min(end, duration)))
    return sorted(result)


def plan_extended_windows(transcript: dict[str, Any], duration: float) -> list[dict[str, float]]:
    """Choose up to four phrase boundaries, sampling only the scene before a pause."""
    duration = _number(duration, "Video duration")
    if duration <= 0:
        raise PipelineError("Video duration must be positive.")
    words = _word_intervals(transcript, duration)
    count = min(MAX_INSERTIONS, max(1, math.ceil(duration / 15)))
    candidates = []
    # Prefer complete phrases; word boundaries are a fallback for older transcripts.
    boundaries = [phrase.get("end") for phrase in transcript.get("phrases", [])]
    if not boundaries:
        boundaries = [end for _, end in words]
    for value in boundaries:
        end = min(duration, max(0.0, _number(value, "Dialogue phrase end")))
        if end <= 0 or any(start + 1e-6 < end < stop - 1e-6 for start, stop in words):
            continue
        next_start = next((start for start, _ in words if start >= end - 1e-6), duration)
        right = max(end, min(duration, next_start))
        first_frame = math.ceil((end - 1e-7) * OUTPUT_FPS) / OUTPUT_FPS
        last_frame = math.floor((right + 1e-7) * OUTPUT_FPS) / OUTPUT_FPS
        preferred = min(end + 0.1, right)
        anchor = min(last_frame, max(first_frame, round(preferred * OUTPUT_FPS) / OUTPUT_FPS)) if first_frame <= last_frame else end
        candidates.append(anchor)
    if not words:
        candidates = [min(duration, round(duration * (i + 1) / count * OUTPUT_FPS) / OUTPUT_FPS) for i in range(count)]
    # The end of the movie is always safe, including a single continuous utterance.
    candidates = sorted(set([candidate for candidate in candidates if candidate > 0.05] + [duration]))
    anchors: list[float] = []
    separation = min(5.0, duration / (count * 2))
    for index in range(count):
        target = duration * (index + 1) / count
        available = [candidate for candidate in candidates if all(abs(candidate - previous) >= separation for previous in anchors)]
        if available:
            anchors.append(min(available, key=lambda candidate: abs(candidate - target)))
    anchors.sort()
    result = []
    previous = 0.0
    for anchor in anchors:
        start = max(previous, anchor - 15.0)
        if anchor <= start:
            continue
        result.append({"source_start": start, "source_end": anchor, "insertion_time": anchor,
                       "start_time": start, "end_time": anchor, "silence_duration": NARRATION_BUDGET_SECONDS})
        previous = anchor
    return result


def _shift_transcript(transcript: dict[str, Any], pauses: list[tuple[float, float]]) -> dict[str, Any]:
    shifted = copy.deepcopy(transcript)

    def shift(value: float, end: bool = False) -> float:
        # A cue ending at the pause belongs to the preceding speech. A cue
        # starting there belongs to the following speech and moves past it.
        return value + sum(length for anchor, length in pauses if value > anchor + 1e-7 or (not end and value >= anchor - 1e-7))

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if "start" in value and "end" in value:
                value["start"] = shift(_number(value["start"], "Transcript start"))
                value["end"] = shift(_number(value["end"], "Transcript end"), end=True)
            for item in value.values():
                if isinstance(item, (dict, list)):
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    for field in ("words", "phrases", "cues"):
        visit(shifted.get(field, []))
    shifted["timeline"] = "extended"
    return shifted


def shift_transcript(transcript: dict[str, Any], insertions: list[dict[str, float]]) -> dict[str, Any]:
    """Translate a fresh source transcript onto an existing extended timeline."""
    pauses = [(_number(item.get("source_time"), "Source insertion time"), _number(item.get("duration"), "Pause duration")) for item in insertions]
    return _shift_transcript(transcript, pauses)


def _write_extended_audio(source_path: Path | None, narration_paths: list[Path],
                          segments: list[dict[str, Any]], target_path: Path, total_duration: float) -> None:
    """Splice finite PCM streams at sample boundaries without repeated AAC priming."""
    frame_bytes = MIX_CHANNELS * 2
    with (wave.open(str(source_path), "rb") if source_path else nullcontext(None)) as source, wave.open(str(target_path), "wb") as target:
        target.setparams((MIX_CHANNELS, 2, MIX_SAMPLE_RATE, 0, "NONE", "not compressed"))

        def copy_frames(stream, count: int) -> None:
            while count > 0:
                chunk = min(count, MIX_SAMPLE_RATE)
                data = stream.readframes(chunk) if stream else b""
                target.writeframesraw(data + bytes(chunk * frame_bytes - len(data)))
                count -= chunk

        source_cursor = output_cursor = 0
        for segment, narration_path in zip(segments, narration_paths):
            source_anchor = round(segment["insertion_time"] * MIX_SAMPLE_RATE)
            source_length = source_anchor - source_cursor
            copy_frames(source, source_length)
            source_cursor = source_anchor
            pause_frames = round(segment["insertion_duration"] * MIX_SAMPLE_RATE)
            with wave.open(str(narration_path), "rb") as narration:
                if (narration.getnchannels(), narration.getsampwidth(), narration.getframerate(), narration.getcomptype()) != (MIX_CHANNELS, 2, MIX_SAMPLE_RATE, "NONE"):
                    raise PipelineError("The inserted narration could not be converted to the output audio format.")
                if narration.getnframes() > pause_frames:
                    raise PipelineError("An inserted narration would exceed its pause duration.")
                copy_frames(narration, pause_frames)
            output_cursor += source_length + pause_frames
        copy_frames(source, round(total_duration * MIX_SAMPLE_RATE) - output_cursor)


def render_extended_video(input_path: Path, output_dir: Path, segments: list[dict[str, Any]],
                          transcript: dict[str, Any], settings: Any, on_step) -> dict[str, Any]:
    """Insert freeze-frame narration at source-time anchors, then shift text once.

    No provider calls occur here. Narration must already be local 24 kHz PCM.
    A single video path shifts source frame timestamps; CFR output holds the
    preceding frame across each gap. Audio is spliced as finite PCM streams.
    This avoids buffering multiple full-resolution branches behind concat and
    does not add repeated AAC priming delays to the original dialogue.
    """
    input_path, output_dir = Path(input_path).resolve(), Path(output_dir).resolve()
    media = probe_media(input_path, settings)
    if not media["has_video"]:
        raise PipelineError("Extended description requires a video stream.")
    source_duration = media["duration"]
    words = _word_intervals(transcript, source_duration)
    rendered = copy.deepcopy(segments)
    passed = sorted([segment for segment in rendered if segment.get("pass")], key=lambda segment: _number(segment.get("insertion_time"), "Description insertion time"))
    if len(passed) > MAX_INSERTIONS:
        raise PipelineError("Extended description supports at most four inserted pauses.")
    pauses: list[tuple[float, float]] = []
    for segment in passed:
        anchor = _number(segment.get("insertion_time"), "Description insertion time")
        if anchor < 0 or anchor > source_duration + 1e-6:
            raise PipelineError("The description insertion point is outside the original video.")
        if any(start + 1e-6 < anchor < end - 1e-6 for start, end in words):
            raise PipelineError("A description pause cannot split a spoken word.")
        if pauses and abs(anchor - pauses[-1][0]) < 1e-6:
            raise PipelineError("Description insertion points must be distinct.")
        audio_path = Path(segment.get("audio_path", ""))
        try:
            with wave.open(str(audio_path), "rb") as audio:
                if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
                    raise PipelineError("Narration must be uncompressed 24 kHz mono 16-bit PCM.")
                actual_duration = audio.getnframes() / SAMPLE_RATE
        except (OSError, wave.Error, EOFError) as exc:
            raise PipelineError("An inserted narration audio file cannot be read.") from exc
        if not 0 < actual_duration <= NARRATION_BUDGET_SECONDS + 0.01:
            raise PipelineError("Each inserted narration must be between zero and eight seconds long.")
        pause_duration = math.ceil((actual_duration + TAIL_SECONDS) * OUTPUT_FPS) / OUTPUT_FPS
        segment.update(source_start=segment.get("source_start", segment.get("start_time", anchor)),
                       source_end=segment.get("source_end", segment.get("end_time", anchor)),
                       insertion_time=anchor, insertion_duration=pause_duration, audio_duration=actual_duration,
                       start_time=anchor + sum(length for _, length in pauses), silence_duration=pause_duration,
                       narration_budget_seconds=NARRATION_BUDGET_SECONDS)
        segment["end_time"] = segment["start_time"] + pause_duration
        pauses.append((anchor, pause_duration))
    total_duration = source_duration + sum(length for _, length in pauses)
    for segment in rendered:
        if not segment.get("pass"):
            start = _number(segment.get("source_start", segment.get("start_time", 0)), "Description start")
            end = _number(segment.get("source_end", segment.get("end_time", start)), "Description end")
            segment["start_time"] = start + sum(length for anchor, length in pauses if start >= anchor)
            segment["end_time"] = end + sum(length for anchor, length in pauses if end > anchor)

    output_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = str(_setting(settings, "ffmpeg_bin", "ffmpeg"))
    video_stream = next(stream for stream in media["streams"] if stream.get("codec_type") == "video")
    width = max(2, int(video_stream["width"]) // 2 * 2)
    height = max(2, int(video_stream["height"]) // 2 * 2)
    rotation = next((side.get("rotation", 0) for side in video_stream.get("side_data_list", []) if "rotation" in side), 0)
    if abs(int(rotation)) % 180 == 90:
        width, height = height, width
    output_path, narration_path = output_dir / "described-video.mp4", output_dir / "narration.wav"
    on_step("MixAudioTracks", "RUNNING", {"num_segments": len(passed), "mode": "extended"})
    # A failed render must not replace a previously valid result with a partial MP4.
    with TemporaryDirectory(prefix=".extended-render-", dir=output_dir) as temp_name:
        temp_dir = Path(temp_name)
        source_audio = temp_dir / "source.wav" if media["has_audio"] else None
        if source_audio:
            _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                  "-protocol_whitelist", "file,pipe", "-i", str(input_path), "-map", "0:a:0", "-vn",
                  "-af", f"aresample={MIX_SAMPLE_RATE}:async=1:first_pts=0,apad,atrim=duration={source_duration:.8f}",
                  "-ac", str(MIX_CHANNELS), "-ar", str(MIX_SAMPLE_RATE), "-c:a", "pcm_s16le",
                  "-t", f"{source_duration:.8f}", str(source_audio)], "Extended source audio preparation", max(90, source_duration))
        narration_inputs = []
        for ordinal, segment in enumerate(passed):
            converted = temp_dir / f"narration-{ordinal}.wav"
            _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                  "-protocol_whitelist", "file,pipe", "-i", str(Path(segment["audio_path"]).resolve()),
                  "-ac", str(MIX_CHANNELS), "-ar", str(MIX_SAMPLE_RATE), "-c:a", "pcm_s16le", str(converted)],
                 "Extended narration audio preparation", 30)
            narration_inputs.append(converted)
        mixed_audio = temp_dir / "extended-audio.wav"
        _write_extended_audio(source_audio, narration_inputs, passed, mixed_audio, total_duration)
        # T is original frame time. The timestamp gaps let fps hold the preceding
        # frame, while bounded tpad also handles pauses at the end of the movie.
        offsets = "+".join(f"gte(T,{max(0, anchor - 1e-7):.8f})*{length:.8f}" for anchor, length in pauses) or "0"
        video_filter = (f"setpts=PTS-STARTPTS,setpts='PTS+({offsets})/TB',"
                        f"scale={width}:{height},setsar=1,format=yuv420p,"
                        f"fps=fps={OUTPUT_FPS}:start_time=0:round=near,"
                        f"tpad=stop_mode=clone:stop_duration={sum(length for _, length in pauses) + 1:.8f},"
                        f"trim=duration={total_duration:.8f},setpts=PTS-STARTPTS")
        temporary_output = temp_dir / "described-video.mp4"
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                   "-threads", "4", "-filter_threads", "1",
                   "-protocol_whitelist", "file,pipe", "-i", str(input_path),
                   "-protocol_whitelist", "file,pipe", "-i", str(mixed_audio),
                   "-map", "0:v:0", "-map", "1:a:0", "-vf", video_filter,
                   "-c:v", "libx264", "-threads", "4", "-preset", "veryfast", "-crf", "20",
                   "-pix_fmt", "yuv420p", "-r", str(OUTPUT_FPS), "-c:a", "aac", "-b:a", "192k",
                   "-ar", str(MIX_SAMPLE_RATE), "-t", f"{total_duration:.8f}", "-movflags", "+faststart", str(temporary_output)]
        _run(command, "Extended narrated video export", max(180, total_duration * 6))
        output_media = probe_media(temporary_output, settings)
        if not output_media["has_video"] or not output_media["has_audio"] or abs(output_media["duration"] - total_duration) > 0.25:
            raise PipelineError("The extended video failed its audio/video duration check.")
        temporary_output.replace(output_path)
    build_narration_track(rendered, narration_path, total_duration)
    on_step("MixAudioTracks", "SUCCEEDED", {"video_duration": total_duration, "inserted_pauses": len(passed)})
    insertions = [{"source_time": segment["insertion_time"], "output_start": segment["start_time"],
                   "output_end": segment["end_time"], "duration": segment["insertion_duration"]} for segment in passed]
    return {"segments": rendered, "transcript": _shift_transcript(transcript, pauses), "insertions": insertions,
            "output_path": str(output_path), "narration_path": str(narration_path), "video_duration": total_duration}
