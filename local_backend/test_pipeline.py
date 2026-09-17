"""Deterministic timing and PCM placement tests; no service calls or credentials."""
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree

import httpx

from local_backend.pipeline import (
    PipelineError, SAMPLE_RATE, _request, audio_speed_to_fit,
    build_narration_track, calculate_dialogue_windows, make_ssml,
    parse_transcription, speech_service_urls,
)


class TimingTests(unittest.TestCase):
    def test_word_offsets_are_absolute_not_added_to_phrase_offset(self):
        parsed = parse_transcription({"phrases": [{"offsetMilliseconds": 1100, "durationMilliseconds": 1200,
            "text": "Hello world.", "words": [
                {"text": "Hello", "offsetMilliseconds": 1100, "durationMilliseconds": 400},
                {"text": "world.", "offsetMilliseconds": 1800, "durationMilliseconds": 500}]}]})
        self.assertAlmostEqual(parsed["words"][0]["start"], 1.1)
        self.assertAlmostEqual(parsed["words"][1]["end"], 2.3)

    def test_missing_word_timings_fail_closed(self):
        with self.assertRaises(PipelineError):
            parse_transcription({"phrases": [{"text": "Speech without timing."}]})
        with self.assertRaises(PipelineError):
            parse_transcription({"combinedPhrases": [{"text": "Speech"}], "phrases": []})

    def test_empty_recognition_is_distinct_from_invalid_response(self):
        self.assertEqual(parse_transcription({"phrases": []})["words"], [])
        with self.assertRaises(PipelineError):
            parse_transcription({})

    def test_merge_speakers_and_protect_head_tail_with_padding(self):
        words = [{"start": 7, "end": 8}, {"start": 2, "end": 3}, {"start": 2.8, "end": 4}]
        windows = calculate_dialogue_windows(words, 10, 1, padding=0.2)
        self.assertEqual(len(windows), 3)
        for actual, expected in zip(windows, [(0, 1.8), (4.2, 6.8), (8.2, 10)]):
            self.assertAlmostEqual(actual["start_time"], expected[0])
            self.assertAlmostEqual(actual["end_time"], expected[1])
        for window in windows:
            for word in words:
                self.assertTrue(window["end_time"] <= word["start"] - 0.2 + 1e-9 or window["start_time"] >= word["end"] + 0.2 - 1e-9)

    def test_no_dialogue_and_split_without_losing_tail(self):
        windows = calculate_dialogue_windows([], 31, 2)
        self.assertEqual(len(windows), 3)
        self.assertAlmostEqual(sum(w["silence_duration"] for w in windows), 31)
        self.assertTrue(all(2 <= w["silence_duration"] <= 15 for w in windows))
        self.assertEqual(windows[-1]["end_time"], 31)

    def test_too_short_gap_not_used(self):
        self.assertEqual(calculate_dialogue_windows([{"start": 0, "end": 9.5}], 10, 1), [])

    def test_invalid_time_is_rejected(self):
        for value in (float("nan"), float("inf"), -1, 0):
            with self.assertRaises(PipelineError):
                calculate_dialogue_windows([], value, 1)
        with self.assertRaises(PipelineError):
            calculate_dialogue_windows([{"start": 5, "end": 2}], 10, 1)

    def test_tempo_adjustment_never_truncates_overlong_speech(self):
        self.assertEqual(audio_speed_to_fit(2, 3), 1)
        speed = audio_speed_to_fit(3.2, 3)
        self.assertGreater(speed, 1)
        self.assertLessEqual(speed, 1.35)
        self.assertLess(3.2 / speed, 2.9)
        self.assertIsNone(audio_speed_to_fit(5, 3))


class MediaAndServiceTests(unittest.TestCase):
    def test_ssml_escapes_media_text(self):
        xml = make_ssml('A sign reads "A&B < C".', 'en-US-JennyNeural', 'en-US', 10)
        root = ElementTree.fromstring(xml)
        prosody = root.find('.//{http://www.w3.org/2001/10/synthesis}prosody')
        self.assertEqual(prosody.text, 'A sign reads "A&B < C".')
        self.assertEqual(prosody.attrib['rate'], '+10%')

    def test_explicit_foundry_root_needs_no_guessed_region(self):
        settings = SimpleNamespace(azure_speech_endpoint="https://example.services.ai.azure.com/api/projects/demo")
        stt, tts = speech_service_urls(settings)
        self.assertEqual(stt, "https://example.services.ai.azure.com/speechtotext/transcriptions:transcribe")
        self.assertEqual(tts, "https://example.services.ai.azure.com/tts/cognitiveservices/v1")
        with self.assertRaises(PipelineError):
            speech_service_urls(SimpleNamespace())

    def test_http_error_redacts_known_credentials(self):
        settings = SimpleNamespace(azure_openai_api_key="test-only-secret", azure_speech_key="other-test-only-secret")
        transport = httpx.MockTransport(lambda request: httpx.Response(401, json={"error": {"message": "Invalid test-only-secret"}}))
        with httpx.Client(transport=transport) as client, self.assertRaises(PipelineError) as context:
            _request(client, "Test service", settings, "https://example.invalid/")
        self.assertNotIn(settings.azure_openai_api_key, str(context.exception))
        self.assertIn("HTTP 401", str(context.exception))

    def test_narration_pcm_is_placed_at_absolute_time(self):
        with tempfile.TemporaryDirectory() as directory:
            clip, target = Path(directory) / "clip.wav", Path(directory) / "track.wav"
            with wave.open(str(clip), "wb") as output:
                output.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
                output.writeframes(b'\x01\x00' * (SAMPLE_RATE // 2))
            segment = {"start_time": 1.0, "end_time": 2.0, "audio_path": str(clip), "pass": True}
            build_narration_track([segment], target, 3)
            with wave.open(str(target), "rb") as track:
                self.assertEqual(track.getnframes(), 3 * SAMPLE_RATE)
                self.assertEqual(track.readframes(SAMPLE_RATE), bytes(SAMPLE_RATE * 2))
                self.assertEqual(track.readframes(1), b'\x01\x00')
            segment["end_time"] = 1.2
            with self.assertRaises(PipelineError):
                build_narration_track([segment], target, 3)


if __name__ == "__main__":
    unittest.main()
