"""Continuous Azure Speech recognition with measured, stream-relative word times."""
from __future__ import annotations

import importlib
from difflib import SequenceMatcher
import json
import math
import re
import threading
import time
import unicodedata
import wave
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit


CUE_FORMAT_VERSION = 2
SUPPORTED_LANGUAGES = ("zh-CN", "en-US")


class TranscriptionError(ValueError):
    """A transcription failure safe to show after credential redaction."""


def _load_sdk():
    try:
        return importlib.import_module("azure.cognitiveservices.speech")
    except ImportError as exc:
        raise TranscriptionError("Install azure-cognitiveservices-speech to calibrate dialogue subtitles.") from exc


def _safe_error(message: Any, settings: Any) -> str:
    text = str(message)
    for name in ("azure_speech_key", "azure_openai_api_key"):
        secret = getattr(settings, name, "")
        if secret:
            text = text.replace(secret, "[REDACTED]")
    # SDK errors sometimes include authenticated connection URLs.
    text = re.sub(r"(?i)([?&](?:authorization|token|api[-_]?key|subscription[-_]?key)=)[^\s&]+", r"\1[REDACTED]", text)
    return text[:1000]


def _finite(value: Any, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise TranscriptionError(f"Azure Speech returned an invalid {label}.") from exc
    if not math.isfinite(number):
        raise TranscriptionError(f"Azure Speech returned an invalid {label}.")
    return number


def _confidence(value: Any) -> float | None:
    if value is None:
        return None
    result = _finite(value, "confidence")
    if not 0 <= result <= 1:
        raise TranscriptionError("Azure Speech returned confidence outside 0–1.")
    return result


def _join_text(parts: list[str], language: str) -> str:
    # The recognizer can return English words even in a Chinese utterance. A
    # locale-wide separator used to turn these into "helloimhere". Join by
    # script instead, preserving spaces between Latin words in either locale.
    result = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if result and not (_is_cjk(result[-1]) or _is_cjk(part[0])):
            result += " "
        result += part
    return re.sub(r"\s+([,.!?;:，。！？；：、])", r"\1", result)


def _is_cjk(character: str) -> bool:
    return "\u3400" <= character <= "\u9fff" or character in "，。！？；：、"


# Punctuation is retained in the original Display string. These tokens are only
# used as exact alignment anchors between Display and measured lexical Words.
_ALIGN_TOKEN = re.compile(r"[\u3400-\u9fff]|\d+(?:[,.]\d+)*|[^\W\d_\u3400-\u9fff]+(?:['’][^\W\d_\u3400-\u9fff]+)*")


def _tokens(text: str):
    return [(unicodedata.normalize("NFKC", match.group()).casefold().replace("’", "'"),
             match.start(), match.end()) for match in _ALIGN_TOKEN.finditer(text)]


def _display_units(text: str, words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach Display spans to measured word groups, keeping ITN spans atomic.

    For example, spoken "two hundred dollars" maps to Display "$200" as one
    group. We never invent sub-word times or replace Display with lexical text.
    When a boundary cannot be aligned, its surrounding group stays together.
    """
    display_tokens = _tokens(text)
    lexical_tokens, token_words = [], []
    for index, word in enumerate(words):
        for token, _, _ in _tokens(str(word["text"])):
            lexical_tokens.append(token)
            token_words.append(index)
    cuts = {0: 0, len(words): len(text)}

    def add_cut(source_end: int, display_end: int):
        if not source_end or not display_end:
            return
        word_index = token_words[source_end - 1]
        if source_end < len(token_words) and token_words[source_end] == word_index:
            return  # A single measured word cannot be divided.
        offset = display_tokens[display_end - 1][2]
        following = display_tokens[display_end][1] if display_end < len(display_tokens) else len(text)
        # Keep sentence punctuation with its word, leaving opening quotes and
        # currency symbols for the next span. Whitespace is stripped per cue.
        punctuation = re.match(r"[,.;:!?，。；：！？、…%％)\]】」』\"'”’]*", text[offset:following])
        offset += len(punctuation.group())
        if word_index + 1 < len(words) and offset < len(text):
            cuts[word_index + 1] = offset

    matcher = SequenceMatcher(None, lexical_tokens, [item[0] for item in display_tokens], autojunk=False)
    for kind, i1, i2, j1, j2 in matcher.get_opcodes():
        if kind == "equal":
            for source, target in zip(range(i1, i2), range(j1, j2)):
                add_cut(source + 1, target + 1)
        elif kind == "replace":
            add_cut(i2, j2)
    units = []
    previous_word = previous_offset = 0
    for word_end, offset in sorted(cuts.items()):
        if word_end <= previous_word or offset <= previous_offset:
            continue
        span = text[previous_offset:offset].strip()
        if not span:
            continue
        units.append({"text": span, "start": words[previous_word]["start"],
                      "end": words[word_end - 1]["end"],
                      "display_start": previous_offset, "display_end": offset})
        previous_word, previous_offset = word_end, offset
    return units


def _detected_language(payload, result, sdk, requested):
    if requested != "auto":
        return requested
    primary = payload.get("PrimaryLanguage")
    language = primary.get("Language") if isinstance(primary, dict) else None
    if language not in SUPPORTED_LANGUAGES:
        language = sdk.AutoDetectSourceLanguageResult(result).language
    if language not in SUPPORTED_LANGUAGES:
        raise TranscriptionError("Azure Speech could not identify the dialogue language. Select Chinese or English and retry.")
    return language


def _empty_recognition(payload: dict[str, Any], fallback_text: str) -> bool:
    """Azure can finalize nonspeech with Success, empty text and no Words.

    Only an explicitly empty best hypothesis is a no-dialogue result. Missing
    timings for any recognized content must still fail rather than create a
    false narration window over speech.
    """
    alternatives = payload.get('NBest')
    if not isinstance(alternatives, list) or not alternatives or not isinstance(alternatives[0], dict):
        return False
    best = alternatives[0]
    text_fields = [fallback_text, payload.get('DisplayText'),
                   *[best.get(key) for key in ('Display', 'Lexical', 'ITN', 'MaskedITN')]]
    return (any(key in best for key in ('Display', 'Lexical', 'ITN', 'MaskedITN'))
            and all(value is None or isinstance(value, str) and not value.strip() for value in text_fields)
            and (best.get('Words') is None or best.get('Words') == []))


def _parse_result(payload: dict[str, Any], fallback_text: str, duration: float, language: str):
    """Parse the best FINAL hypothesis. Word offsets are already absolute ticks."""
    alternatives = payload.get("NBest")
    if not isinstance(alternatives, list) or not alternatives or not isinstance(alternatives[0], dict):
        raise TranscriptionError("Azure Speech omitted detailed word timestamps; subtitles cannot be calibrated.")
    if _empty_recognition(payload, fallback_text):
        return None, []
    best = alternatives[0]
    display = str(best.get("Display") or payload.get("DisplayText") or fallback_text or "").strip()
    raw_words = best.get("Words")
    recognized_text = display or any(str(best.get(key) or '').strip() for key in ('Lexical', 'ITN', 'MaskedITN'))
    if not isinstance(raw_words, list) or (recognized_text and not raw_words):
        raise TranscriptionError("Azure Speech recognized dialogue without word timestamps; subtitles cannot be calibrated.")
    words = []
    for item in raw_words:
        if not isinstance(item, dict):
            raise TranscriptionError("Azure Speech returned an invalid word timestamp.")
        text = str(item.get("Word") or "").strip()
        if not text:
            raise TranscriptionError("Azure Speech returned an empty word.")
        start = _finite(item.get("Offset"), "word offset") / 10_000_000
        length = _finite(item.get("Duration"), "word duration") / 10_000_000
        end = start + length
        if start < 0 or length <= 0 or end > duration + 0.05:
            raise TranscriptionError("Azure Speech word timestamps fall outside the audio; subtitles need recalibration.")
        if words and start < words[-1]["end"] - 0.001:
            raise TranscriptionError("Azure Speech returned overlapping or unsorted word timestamps.")
        word = {"text": text, "start": start, "end": end}
        confidence = _confidence(item.get("Confidence"))
        if confidence is not None:
            word["confidence"] = confidence
        words.append(word)
    if not words:
        return None, []
    # Display retains punctuation and avoids spaces between Chinese characters.
    phrase = {"text": display or _join_text([word["text"] for word in words], language),
              "start": words[0]["start"], "end": words[-1]["end"]}
    confidence = _confidence(best.get("Confidence"))
    if confidence is not None:
        phrase["confidence"] = confidence
    return phrase, words


def _get_future(future: Any, timeout: float) -> None:
    """Bound native SDK future waits, including cleanup after a network timeout."""
    finished = threading.Event()
    errors = []

    def wait():
        try:
            future.get()
        except Exception as exc:
            errors.append(exc)
        finally:
            finished.set()

    threading.Thread(target=wait, daemon=True).start()
    if not finished.wait(max(0, timeout)):
        raise TranscriptionError("Azure Speech connection timed out. Check connectivity and retry.")
    if errors:
        raise errors[0]


def transcribe_audio(audio_path: Path, settings: Any,
                     on_progress: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    """Recognize every utterance in a PCM WAV without estimating any word times."""
    try:
        with wave.open(str(audio_path), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
            valid = audio.getnchannels() == 1 and audio.getsampwidth() == 2 and audio.getcomptype() == "NONE"
        if not valid or duration <= 0:
            raise TranscriptionError("Dialogue recognition requires a nonempty 16-bit mono PCM WAV.")
    except (OSError, wave.Error, EOFError, ZeroDivisionError) as exc:
        raise TranscriptionError("Cannot read the dialogue WAV for subtitle calibration.") from exc
    language = getattr(settings, "dialogue_language", "auto")
    if language not in (*SUPPORTED_LANGUAGES, "auto"):
        raise TranscriptionError("Choose Auto, Chinese (zh-CN) or English (en-US) for dialogue recognition.")
    key = getattr(settings, "azure_speech_key", "")
    if not key:
        raise TranscriptionError("Configure the server-side Azure Speech key before transcribing.")
    sdk = _load_sdk()
    config_args = {"subscription": key}
    endpoint = getattr(settings, "azure_speech_endpoint", "").strip()
    if endpoint:
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ("https", "wss") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise TranscriptionError("Azure Speech endpoint must be an HTTPS resource URL without credentials or query parameters.")
        # Continuous language identification requires the universal v2 protocol.
        speech_path = "/stt/speech/universal/v2" if language == "auto" else "/stt/speech/recognition/conversation/cognitiveservices/v1"
        config_args["endpoint"] = f"wss://{parsed.netloc}{speech_path}"
    else:
        region = getattr(settings, "azure_speech_region", "").strip()
        if not re.fullmatch(r"[a-z0-9-]+", region):
            raise TranscriptionError("Configure the Azure Speech resource endpoint or its exact region.")
        config_args["region"] = region
    done = threading.Event()
    phrases, words, failures = [], [], []
    no_match_count = 0
    seen_results = set()
    recognizer = None
    timeout = min(900.0, max(60.0, duration * 1.5 + 45.0))
    deadline = time.monotonic() + timeout

    def recognized(event):
        nonlocal no_match_count
        if done.is_set():
            return
        if event.result.reason == sdk.ResultReason.NoMatch:
            no_match_count += 1
            return
        if event.result.reason != sdk.ResultReason.RecognizedSpeech:
            return
        try:
            payload = json.loads(event.result.json)
            if not isinstance(payload, dict):
                raise TranscriptionError("Azure Speech returned an invalid detailed result.")
            result_id = payload.get("Id")
            if result_id and result_id in seen_results:
                return
            if _empty_recognition(payload, event.result.text):
                if result_id:
                    seen_results.add(result_id)
                return
            detected = _detected_language(payload, event.result, sdk, language)
            phrase, phrase_words = _parse_result(payload, event.result.text, duration, detected)
            if phrase is None:
                return
            phrase["language"] = detected
            if words and phrase_words[0]["start"] < words[-1]["end"] - 0.001:
                raise TranscriptionError("Azure Speech utterance timestamps overlap; subtitles need recalibration.")
            if result_id:
                seen_results.add(result_id)
            phrases.append(phrase)
            words.extend(phrase_words)
            if on_progress:
                on_progress({"phase": "transcribing", "phrase_count": len(phrases),
                             "recognized_until": phrase["end"], "duration": duration})
        except Exception as exc:
            failures.append(_safe_error(exc, settings))
            done.set()

    def canceled(event):
        if done.is_set():
            return
        # Python SDK sends SpeechRecognitionCanceledEventArgs: details live on
        # result.cancellation_details, rather than necessarily on the event.
        result = getattr(event, "result", None)
        details = getattr(result, "cancellation_details", None)
        reason = getattr(details, "reason", None) or getattr(event, "reason", None)
        end_of_stream = getattr(sdk.CancellationReason, "EndOfStream", None)
        if reason is None or reason != end_of_stream:
            detail = getattr(details, "error_details", "") or getattr(event, "error_details", "") or str(reason or "Canceled")
            failures.append(_safe_error(f"Azure Speech recognition canceled. {detail}", settings))
        done.set()

    try:
        config = sdk.SpeechConfig(**config_args)
        recognizer_args = {}
        if language == "auto":
            config.set_property(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous")
            recognizer_args["auto_detect_source_language_config"] = sdk.languageconfig.AutoDetectSourceLanguageConfig(
                languages=list(SUPPORTED_LANGUAGES))
        else:
            config.speech_recognition_language = language
        config.output_format = sdk.OutputFormat.Detailed
        config.request_word_level_timestamps()
        recognizer = sdk.SpeechRecognizer(speech_config=config, audio_config=sdk.audio.AudioConfig(filename=str(audio_path)),
                                          **recognizer_args)
        recognizer.recognized.connect(recognized)
        recognizer.canceled.connect(canceled)
        recognizer.session_stopped.connect(lambda event: done.set())
        _get_future(recognizer.start_continuous_recognition_async(), min(20, deadline - time.monotonic()))
        if not done.wait(max(0, deadline - time.monotonic())):
            raise TranscriptionError("Azure Speech transcription timed out. Check connectivity or retry a shorter video.")
        if failures:
            raise TranscriptionError(failures[0])
        if no_match_count and not words:
            raise TranscriptionError("Azure Speech detected audio but could not recognize dialogue. Select the correct dialogue language and retry.")
    except Exception as exc:
        raise TranscriptionError(_safe_error(exc, settings)) from None
    finally:
        done.set()
        if recognizer is not None:
            try:
                _get_future(recognizer.stop_continuous_recognition_async(), 10)
            except Exception:
                # Cleanup must not hide the original recognition failure.
                pass
    language_durations = {}
    for phrase in phrases:
        source_language = phrase["language"]
        language_durations[source_language] = language_durations.get(source_language, 0) + phrase["end"] - phrase["start"]
    primary_language = max(language_durations, key=language_durations.get) if language_durations else language
    uncertain = [{"start": phrase["start"], "end": phrase["end"], "confidence": phrase["confidence"]}
                 for phrase in phrases if phrase.get("confidence", 1) < 0.75]
    low_words = sum(word.get("confidence", 1) < 0.75 for word in words)
    return {"text": _join_text([phrase["text"] for phrase in phrases], primary_language),
            "words": words, "phrases": phrases, "timing_source": "azure_speech_continuous", "language": primary_language,
            "quality": {"method": "continuous_word_timestamps", "timing_validated": True,
                        "word_count": len(words), "phrase_count": len(phrases), "no_match_count": no_match_count,
                        "low_confidence_word_count": low_words, "low_confidence_phrase_count": len(uncertain),
                        "review_required": bool(uncertain or low_words or no_match_count), "uncertain_spans": uncertain,
                        "requested_language": language, "detected_languages": list(language_durations)}}


def transcript_cues(transcript: dict[str, Any], max_seconds: float = 6) -> list[dict[str, Any]]:
    """Split long subtitles only at measured word boundaries, never by interpolation."""
    maximum = _finite(max_seconds, "subtitle duration")
    if maximum <= 0:
        raise TranscriptionError("Maximum subtitle duration must be positive.")
    words = transcript.get("words", [])
    cues = []

    def append(text, start, end):
        # Azure offsets are integer 100 ns ticks; do not let floating addition
        # make adjacent cues appear to overlap in the editor's strict check.
        start, end = round(start, 7), round(end, 7)
        cues.append({"id": f"cue-{len(cues) + 1:04d}", "start": start, "end": end, "text": text})

    for phrase in transcript.get("phrases", []):
        start, end = _finite(phrase.get("start"), "phrase start"), _finite(phrase.get("end"), "phrase end")
        if start < 0 or end <= start:
            raise TranscriptionError("Subtitle phrases must have positive measured durations.")
        text = str(phrase.get("text") or "").strip()
        if not text:
            continue
        phrase_words = [word for word in words if word["start"] >= start - 0.001 and word["end"] <= end + 0.001]
        if not phrase_words:
            if end - start > maximum:
                raise TranscriptionError("A long subtitle cannot be split without word timestamps.")
            append(text, start, end)
            continue
        units = _display_units(text, phrase_words)
        chunk = []

        def flush():
            if chunk:
                append(text[chunk[0]["display_start"]:chunk[-1]["display_end"]].strip(),
                       chunk[0]["start"], chunk[-1]["end"])

        for unit in units:
            # Split on sentence ends and measured pauses even in short phrases.
            # Keep normalized text such as $200 intact with its full word span.
            sentence_end = chunk and re.search(r"[.!?。！？][)\]】」』\"'”’]*$", chunk[-1]["text"])
            if chunk and (unit["end"] - chunk[0]["start"] > maximum or
                          unit["start"] - chunk[-1]["end"] >= 0.7 or sentence_end):
                flush()
                chunk = []
            chunk.append(unit)
        flush()
    return cues
