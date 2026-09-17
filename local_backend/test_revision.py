"""Revision tests with original synthetic media and fake TTS; no cloud calls."""
from array import array
from copy import deepcopy
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

from local_backend.pipeline import PipelineError, SAMPLE_RATE, probe_media
from local_backend.revision import render_revision


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and FFprobe are required")
class RevisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.input_path = Path(cls.fixture.name) / "original.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                        "-f", "lavfi", "-i", "color=c=blue:s=96x64:r=10:d=3",
                        "-f", "lavfi", "-i", "sine=frequency=180:sample_rate=48000:duration=3",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "3",
                        str(cls.input_path)], check=True, capture_output=True, timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source_dir = self.root / "source"
        self.source_dir.mkdir()
        self.transcript = {"text": "Welcome.", "words": [{"text": "Welcome.", "start": 0.1, "end": 0.5}],
                           "phrases": [{"text": "Welcome.", "start": 0.1, "end": 0.5}],
                           "timing_source": "speech_words"}
        self.transcript_path = self.source_dir / "transcript.json"
        self.transcript_path.write_text(json.dumps(self.transcript), encoding="utf-8")
        self.source = {"segments": [{"segment_index": 0, "start_time": 0.8, "end_time": 2.4,
                                    "silence_duration": 1.6, "dvi_text": "A blue panel.",
                                    "audio_path": str(self.source_dir / "old.wav"), "audio_duration": 0.5,
                                    "raw_audio_duration": 0.6, "ssml_rate_percent": 20, "tempo_multiplier": 1.2,
                                    "word_count": 99, "char_count": 99, "wpm": 999.0, "pass": True,
                                    "skip_reason": "Stale source reason", "review": {"note": "keep"}}],
                       "summary": {"video_duration": 3.0},
                       "usage": {"openai_requests": 1, "tts_requests": 1},
                       "transcript_path": str(self.transcript_path),
                       "output_path": str(self.source_dir / "described-video.mp4"),
                       "narration_path": str(self.source_dir / "narration.wav")}
        self.settings = SimpleNamespace(azure_speech_key="test-only-key",
                                        azure_speech_endpoint="https://example.invalid",
                                        speech_language="en-US", azure_speech_voice="en-US-JennyNeural",
                                        ffmpeg_bin="ffmpeg", ffprobe_bin="ffprobe", max_video_seconds=10)
        self.steps = []
        # A regression must never silently start STT, vision, or any HTTP request.
        for target in ("local_backend.pipeline._transcribe", "local_backend.pipeline._generate_description",
                       "httpx.Client.post"):
            guard = patch(target, side_effect=AssertionError("Unexpected cloud request"))
            guard.start()
            self.addCleanup(guard.stop)

    @staticmethod
    def synthesize(text, path, window, settings, client):
        duration = 4.0 if text == "Too long" else 0.7
        frequency = 1200 if text.startswith("Changed") else 700
        pcm = array("h", (round(12000 * math.sin(2 * math.pi * frequency * index / SAMPLE_RATE))
                          for index in range(round(duration * SAMPLE_RATE))))
        with wave.open(str(path), "wb") as target:
            target.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            target.writeframes(pcm.tobytes())
        return 0

    def render(self, name, edits, source=None):
        with patch("local_backend.revision._synthesize", side_effect=self.synthesize):
            return render_revision(self.input_path, self.root / name, self.settings, source or self.source, edits,
                                   lambda step, status, detail: self.steps.append((step, status, detail)))

    @staticmethod
    def decoded_audio(path):
        output = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                                 "-i", str(path), "-map", "0:a:0", "-f", "s16le", "-ac", "1",
                                 "-ar", str(SAMPLE_RATE), "pipe:1"],
                                check=True, capture_output=True, timeout=30)
        samples = array("h")
        samples.frombytes(output.stdout)
        return samples

    def test_edit_rebuilds_the_exported_audio_and_preserves_its_source(self):
        baseline = self.render("baseline", [])
        original = deepcopy(baseline)
        old_audio = Path(baseline["narration_path"]).read_bytes()
        old_video = Path(baseline["output_path"]).read_bytes()
        result = self.render("edited", [{"segment_index": 0, "dvi_text": "Changed panel description."}], baseline)
        self.assertEqual(baseline, original)
        self.assertEqual(Path(baseline["narration_path"]).read_bytes(), old_audio)
        self.assertEqual(Path(baseline["output_path"]).read_bytes(), old_video)
        before, after = self.decoded_audio(baseline["output_path"]), self.decoded_audio(result["output_path"])
        audible = range(round(0.95 * SAMPLE_RATE), round(1.35 * SAMPLE_RATE))
        difference = math.sqrt(sum((after[i] - before[i]) ** 2 for i in audible) / len(audible))
        self.assertGreater(difference, 5000, "The exported soundtrack must contain the new synthesized audio")
        self.assertEqual(before[:SAMPLE_RATE // 2], after[:SAMPLE_RATE // 2])
        self.assertTrue(result["segments"][0]["pass"])
        self.assertNotIn("skip_reason", result["segments"][0])
        self.assertEqual(result["usage"]["openai_requests"], 0)
        self.assertEqual(result["usage"]["transcription_audio_seconds"], 0)
        self.assertEqual(result["usage"]["tts_requests"], 1)
        self.assertEqual(result["language"], "en-US")
        self.assertEqual(result["voice"], "en-US-JennyNeural")
        self.assertEqual(json.loads((self.root / "edited" / "result.json").read_text()), result)
        self.assertEqual({step[0] for step in self.steps},
                         {"ValidateInput", "SynthesizeAudio", "MixAudioTracks", "RecordSummary"})
        self.assertAlmostEqual(probe_media(Path(result["output_path"]), self.settings)["duration"], 3, places=1)

    def test_blank_text_removes_old_audio_and_stale_metadata(self):
        original = deepcopy(self.source)
        self.settings.azure_speech_key = ""
        with patch("local_backend.revision._synthesize", side_effect=AssertionError("Blank text must not use TTS")):
            result = render_revision(self.input_path, self.root / "blank", self.settings, self.source,
                                     [{"segment_index": 0, "dvi_text": "  \n\t"}], lambda *args: None)
        segment = result["segments"][0]
        self.assertFalse(segment["pass"])
        self.assertEqual(segment["dvi_text"], "")
        self.assertEqual(segment["audio_duration"], 0)
        self.assertEqual(segment["wpm"], 0)
        self.assertEqual(segment["word_count"], 0)
        self.assertIn("empty", segment["skip_reason"])
        for field in ("audio_path", "raw_audio_duration", "tempo_multiplier", "ssml_rate_percent"):
            self.assertNotIn(field, segment)
        self.assertEqual(result["usage"]["tts_requests"], 0)
        with wave.open(result["narration_path"], "rb") as track:
            self.assertEqual(track.readframes(track.getnframes()), bytes(3 * SAMPLE_RATE * 2))
        self.assertEqual(self.source, original)

    def test_overlong_description_is_skipped_without_covering_dialogue(self):
        result = self.render("too-long", [{"segment_index": 0, "dvi_text": "Too long"}])
        segment = result["segments"][0]
        self.assertFalse(segment["pass"])
        self.assertIn("cannot fit", segment["skip_reason"])
        self.assertEqual(segment["raw_audio_duration"], 4)
        self.assertEqual(segment["audio_duration"], 0)
        self.assertNotIn("audio_path", segment)
        self.assertEqual(result["summary"]["passed_segments"], 0)
        self.assertEqual(result["usage"]["tts_requests"], 1)
        with wave.open(result["narration_path"], "rb") as track:
            self.assertEqual(track.readframes(track.getnframes()), bytes(3 * SAMPLE_RATE * 2))
        exported = self.decoded_audio(result["output_path"])
        self.assertGreater(max(abs(v) for v in exported), 1000, "Original audio must survive the skipped narration")

    def test_only_text_is_editable_and_transcript_edits_are_copied_separately(self):
        self.source["source_transcript_edits"] = {"revision": 1, "cues": [{"index": 0, "text": "Corrected dialogue."}]}
        original = deepcopy(self.source)
        result = self.render("text-only", [{"segment_index": 0, "dvi_text": "Changed panel.",
                                           "start_time": 0, "end_time": 1000, "silence_duration": 1000,
                                           "audio_path": "/must-not-be-read.wav", "pass": False}])
        segment = result["segments"][0]
        self.assertEqual(segment["start_time"], 0.8)
        self.assertEqual(segment["end_time"], 2.4)
        self.assertAlmostEqual(segment["silence_duration"], 1.6)
        self.assertTrue(segment["pass"])
        self.assertTrue(Path(segment["audio_path"]).is_relative_to((self.root / "text-only").resolve()))
        self.assertNotIn("source_transcript_edits", result)
        self.assertEqual(json.loads((self.root / "text-only" / "transcript-edits.json").read_text()),
                         self.source["source_transcript_edits"])
        self.assertEqual(Path(result["transcript_path"]).read_bytes(), self.transcript_path.read_bytes())
        segment["review"]["note"] = "changed in new result"
        self.assertEqual(self.source, original)

    def test_cannot_overwrite_an_old_version_or_render_invalid_source_timing(self):
        original_transcript = self.transcript_path.read_bytes()
        with self.assertRaisesRegex(PipelineError, "new, empty output directory"):
            render_revision(self.input_path, self.source_dir, self.settings, self.source, [], lambda *args: None)
        self.assertEqual(self.transcript_path.read_bytes(), original_transcript)
        invalid = deepcopy(self.source)
        invalid["segments"][0]["end_time"] = 5
        with self.assertRaisesRegex(PipelineError, "outside the uploaded video"):
            self.render("invalid", [], invalid)
        self.assertFalse((self.root / "invalid").exists())


if __name__ == "__main__":
    unittest.main()
