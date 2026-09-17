"""Timing, PCM placement, and soundtrack export tests without cloud calls."""
from array import array
import math
import shutil
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree

import httpx

from local_backend.pipeline import (
    PipelineError, SAMPLE_RATE, _mix_video, _request, audio_speed_to_fit,
    build_narration_track, calculate_dialogue_windows, make_ssml,
    probe_media, speech_synthesis_url,
)


class TimingTests(unittest.TestCase):
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
        self.assertEqual(speech_synthesis_url(settings), "https://example.services.ai.azure.com/tts/cognitiveservices/v1")
        self.assertEqual(speech_synthesis_url(SimpleNamespace(azure_speech_region="eastus")),
                         "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1")
        with self.assertRaises(PipelineError):
            speech_synthesis_url(SimpleNamespace())

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


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and FFprobe are required")
class StandardExportTimingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = SimpleNamespace(ffmpeg_bin="ffmpeg", ffprobe_bin="ffprobe")

    def export(self, dialogue_start, dialogue_duration, narration_start):
        source, clip, narration, output = (self.root / name for name in
                                             ("source.mp4", "clip.wav", "narration.wav", "output.mp4"))
        command = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                   "color=c=blue:s=96x64:r=30:d=5"]
        if dialogue_start is not None:
            command += ["-itsoffset", str(dialogue_start), "-f", "lavfi", "-i",
                        f"sine=frequency=400:sample_rate=48000:duration={dialogue_duration}"]
        command += ["-c:v", "libx264", "-c:a", "aac", "-t", "5", str(source)]
        subprocess.run(command, check=True, capture_output=True, timeout=30)
        pcm = array("h", (round(8000 * math.sin(2 * math.pi * 1000 * i / SAMPLE_RATE))
                           for i in range(SAMPLE_RATE // 2)))
        with wave.open(str(clip), "wb") as target:
            target.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            target.writeframes(pcm.tobytes())
        segments = [{"start_time": narration_start, "end_time": narration_start + 0.8,
                     "audio_duration": 0.5, "audio_path": str(clip), "pass": True}]
        build_narration_track(segments, narration, 5)
        media = probe_media(source, self.settings)
        _mix_video(source, narration, output, segments, media, self.settings)
        exported = probe_media(output, self.settings)
        self.assertAlmostEqual(exported["duration"], 5, delta=0.1)
        audio = next(stream for stream in exported["streams"] if stream["codec_type"] == "audio")
        self.assertAlmostEqual(float(audio["start_time"]), 0, delta=0.03)
        self.assertAlmostEqual(float(audio["duration"]), 5, delta=0.05)
        raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(output), "-vn",
                              "-af", "aresample=24000:async=1:first_pts=0,apad", "-t", "5",
                              "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1"],
                             check=True, capture_output=True, timeout=30).stdout
        samples = array("h")
        samples.frombytes(raw)
        return samples

    @staticmethod
    def tone_energy(samples, time, frequency):
        part = samples[round(time * SAMPLE_RATE):round((time + 0.1) * SAMPLE_RATE)]
        return math.hypot(
            sum(value * math.cos(2 * math.pi * frequency * i / SAMPLE_RATE) for i, value in enumerate(part)),
            sum(value * math.sin(2 * math.pi * frequency * i / SAMPLE_RATE) for i, value in enumerate(part))) / len(part)

    def test_delayed_source_audio_does_not_shift_narration_into_dialogue(self):
        windows = calculate_dialogue_windows([{"start": 3, "end": 5}], 5, 2)
        self.assertEqual(len(windows), 1)
        samples = self.export(3, 2, windows[0]["start_time"])
        self.assertGreater(self.tone_energy(samples, 0.2, 1000), 1000)
        self.assertLess(self.tone_energy(samples, 3.2, 1000), 10)
        self.assertGreater(self.tone_energy(samples, 3.2, 400), 1000)
        self.assertLess(self.tone_energy(samples, 0.2, 400), 10)

    def test_short_source_soundtrack_preserves_narration_at_the_end(self):
        samples = self.export(0, 1, 4)
        self.assertGreater(self.tone_energy(samples, 0.2, 400), 1000)
        self.assertGreater(self.tone_energy(samples, 4.2, 1000), 1000)
        self.assertLess(self.tone_energy(samples, 4.2, 400), 10)

    def test_video_without_soundtrack_keeps_narration_at_its_window(self):
        samples = self.export(None, 0, 2)
        self.assertGreater(self.tone_energy(samples, 2.2, 1000), 1000)
        self.assertLess(self.tone_energy(samples, 0.2, 1000), 10)


if __name__ == "__main__":
    unittest.main()
