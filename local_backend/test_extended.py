"""Extended-description tests with synthetic local media; no provider requests."""
from array import array
from copy import deepcopy
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

from local_backend.extended import plan_extended_windows, render_extended_video, shift_transcript
from local_backend.pipeline import PipelineError, SAMPLE_RATE, _run, probe_media


class ExtendedPlanningTests(unittest.TestCase):
    def test_dense_dialogue_uses_phrase_boundaries_without_splitting_words(self):
        transcript = {"words": [{"start": i, "end": i + 0.96} for i in range(30)],
                      "phrases": [{"start": 0, "end": 9.96}, {"start": 10, "end": 19.96}, {"start": 20, "end": 29.96}]}
        windows = plan_extended_windows(transcript, 30)
        self.assertGreaterEqual(len(windows), 1)
        self.assertLessEqual(len(windows), 4)
        for window in windows:
            self.assertEqual(window["silence_duration"], 8)
            self.assertLess(window["source_start"], window["source_end"])
            self.assertEqual(window["source_end"], window["insertion_time"])
            self.assertFalse(any(word["start"] < window["insertion_time"] < word["end"] for word in transcript["words"]))
        self.assertEqual(plan_extended_windows({"words": [{"start": 0, "end": 30}], "phrases": [{"start": 0, "end": 30}]}, 30)[0]["insertion_time"], 30)
        self.assertLessEqual(len(plan_extended_windows({"words": [], "phrases": []}, 600)), 4)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and FFprobe are required")
class ExtendedRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.input_path = Path(cls.fixture.name) / "source.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                        "-f", "lavfi", "-i", "color=c=blue:s=96x64:r=30:d=2",
                        "-f", "lavfi", "-i", "sine=frequency=240:sample_rate=48000:duration=1",
                        "-f", "lavfi", "-i", "sine=frequency=480:sample_rate=48000:duration=1",
                        "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a]", "-map", "0:v", "-map", "[a]",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "2", str(cls.input_path)],
                       check=True, capture_output=True, timeout=30)
        cls.silent_path = Path(cls.fixture.name) / "silent.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(cls.input_path),
                        "-map", "0:v", "-c:v", "copy", "-an", str(cls.silent_path)], check=True, capture_output=True, timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = SimpleNamespace(ffmpeg_bin="ffmpeg", ffprobe_bin="ffprobe")
        self.audio_path = self.root / "speech.wav"
        samples = array("h", (round(11000 * math.sin(2 * math.pi * 960 * index / SAMPLE_RATE)) for index in range(SAMPLE_RATE // 2)))
        with wave.open(str(self.audio_path), "wb") as audio:
            audio.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            audio.writeframes(samples.tobytes())
        self.segments = [{"segment_index": 0, "source_start": 0, "source_end": 1, "insertion_time": 1,
                          "start_time": 0, "end_time": 1, "silence_duration": 8, "dvi_text": "A blue screen.",
                          "audio_path": str(self.audio_path), "audio_duration": 0.5, "pass": True}]
        self.transcript = {"text": "First. Second.", "words": [{"text": "First.", "start": 0.1, "end": 1}, {"text": "Second.", "start": 1, "end": 1.9}],
                           "phrases": [{"text": "First.", "start": 0.1, "end": 1}, {"text": "Second.", "start": 1, "end": 1.9}],
                           "cues": [{"id": "one", "text": "First.", "start": 0.1, "end": 1}, {"id": "two", "text": "Second.", "start": 1, "end": 1.9}]}
        guard = patch("httpx.Client.request", side_effect=AssertionError("Unexpected cloud request"))
        guard.start()
        self.addCleanup(guard.stop)

    @staticmethod
    def decoded_audio(path):
        output = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
                                 "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "pipe:1"],
                                check=True, capture_output=True, timeout=30)
        samples = array("h")
        samples.frombytes(output.stdout)
        return samples

    @staticmethod
    def energy(samples, start, duration, frequency):
        data = samples[round(start * SAMPLE_RATE):round((start + duration) * SAMPLE_RATE)]
        real = sum(value * math.cos(2 * math.pi * frequency * index / SAMPLE_RATE) for index, value in enumerate(data))
        imag = sum(value * math.sin(2 * math.pi * frequency * index / SAMPLE_RATE) for index, value in enumerate(data))
        return math.hypot(real, imag) / len(data)

    def render(self, name, source=None, segments=None):
        return render_extended_video(source or self.input_path, self.root / name, self.segments if segments is None else segments,
                                     self.transcript, self.settings, lambda *args: None)

    def test_insert_preserves_both_original_tones_and_moves_all_transcript_times(self):
        original_segments, original_transcript = deepcopy(self.segments), deepcopy(self.transcript)
        result = self.render("extended")
        self.assertEqual(self.segments, original_segments)
        self.assertEqual(self.transcript, original_transcript)
        insertion = result["insertions"][0]
        self.assertAlmostEqual(insertion["duration"], 20 / 30)
        self.assertEqual(insertion["source_time"], 1)
        self.assertAlmostEqual(result["video_duration"], 2 + 20 / 30)
        self.assertAlmostEqual(probe_media(Path(result["output_path"]), self.settings)["duration"], result["video_duration"], delta=0.05)
        for field in ("words", "phrases", "cues"):
            self.assertEqual(result["transcript"][field][0]["end"], 1)
            self.assertAlmostEqual(result["transcript"][field][1]["start"], 1 + 20 / 30)
            self.assertAlmostEqual(result["transcript"][field][1]["end"], 1.9 + 20 / 30)
        output = self.decoded_audio(result["output_path"])
        for start, frequency in [(0.2, 240), (1.1, 960), (1 + 20 / 30 + 0.2, 480)]:
            self.assertGreater(self.energy(output, start, 0.2, frequency), 1000)
        self.assertLess(self.energy(output, 1.1, 0.2, 480), 150, "Original dialogue must pause during narration")
        with wave.open(result["narration_path"], "rb") as narration:
            self.assertAlmostEqual(narration.getnframes() / narration.getframerate(), result["video_duration"], places=4)

    def test_source_without_audio_gets_silence_outside_narration(self):
        result = self.render("silent", source=self.silent_path)
        samples = self.decoded_audio(result["output_path"])
        self.assertLess(max(abs(sample) for sample in samples[:SAMPLE_RATE // 2]), 10)
        self.assertGreater(self.energy(samples, 1.1, 0.2, 960), 1000)
        self.assertTrue(probe_media(Path(result["output_path"]), self.settings)["has_audio"])

    def test_multiple_insertions_accumulate_once_and_allow_the_end_of_the_movie(self):
        second = {**self.segments[0], "segment_index": 1, "source_start": 1, "source_end": 2, "insertion_time": 2}
        result = self.render("two-pauses", segments=[self.segments[0], second])
        self.assertEqual(len(result["insertions"]), 2)
        self.assertAlmostEqual(result["insertions"][1]["output_start"], 2 + 20 / 30)
        self.assertAlmostEqual(result["video_duration"], 2 + 40 / 30)
        self.assertEqual(result["transcript"], shift_transcript(self.transcript, result["insertions"]))
        samples = self.decoded_audio(result["output_path"])
        self.assertGreater(self.energy(samples, 2 + 20 / 30 + 0.1, 0.2, 960), 1000)
        self.assertGreater(self.energy(samples, 1 + 20 / 30 + 0.2, 0.2, 480), 1000)

    def test_skipped_narration_does_not_insert_a_pause_or_shift_subtitles(self):
        result = self.render("skipped", segments=[{**self.segments[0], "pass": False, "audio_duration": 0}])
        self.assertEqual(result["insertions"], [])
        self.assertAlmostEqual(result["video_duration"], 2)
        self.assertEqual(result["transcript"]["cues"], self.transcript["cues"])
        samples = self.decoded_audio(result["output_path"])
        self.assertGreater(self.energy(samples, 1.2, 0.2, 480), 1000)

    def test_four_hd_pauses_hold_the_previous_scene_and_preserve_each_source_audio_section(self):
        source = self.root / "four-scenes.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                        "-f", "lavfi", "-i", "color=c=red:s=1920x1080:r=30:d=4,"
                        "drawbox=c=green:t=fill:enable='gte(t,1)',"
                        "drawbox=c=blue:t=fill:enable='gte(t,2)',"
                        "drawbox=c=white:t=fill:enable='gte(t,3)'",
                        "-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*(240+240*floor(t))*t):s=48000:d=4",
                        "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-t", "4", str(source)], check=True, capture_output=True, timeout=30)
        segments = [{**self.segments[0], "segment_index": i, "source_start": i,
                     "source_end": i + 1, "insertion_time": i + 1} for i in range(4)]
        transcript = {"words": [{"start": i + 0.1, "end": i + 1} for i in range(4)]}
        commands = []

        def record_run(command, description, timeout=180):
            commands.append(command)
            return _run(command, description, timeout)

        with patch("local_backend.extended._run", side_effect=record_run):
            result = render_extended_video(source, self.root / "four-pauses", segments, transcript,
                                           self.settings, lambda *args: None)
        self.assertEqual(len(result["insertions"]), 4)
        media = probe_media(Path(result["output_path"]), self.settings)
        stream = next(stream for stream in media["streams"] if stream["codec_type"] == "video")
        self.assertEqual((stream["width"], stream["height"]), (1920, 1080))
        self.assertAlmostEqual(media["duration"], 4 + 80 / 30, delta=0.05)
        # Regression guard: no unbounded image loops or source branches buffered
        # behind concat, which exhausted the export budget on the 5K user clip.
        self.assertFalse(any("-loop" in command or "-filter_complex" in command for command in commands))
        samples = self.decoded_audio(result["output_path"])
        for i in range(4):
            self.assertGreater(self.energy(samples, i * (1 + 20 / 30) + 0.2, 0.2, 240 * (i + 1)), 1000)
            self.assertAlmostEqual(result["transcript"]["words"][i]["start"], i * (1 + 20 / 30) + 0.1)
        expected_colors = [(255, 0, 0), (0, 128, 0), (0, 0, 255), (255, 255, 255)]
        for insertion, color in zip(result["insertions"], expected_colors):
            sample = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                                     "-ss", str(insertion["output_start"] + 0.3), "-i", result["output_path"],
                                     "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                                    check=True, capture_output=True, timeout=30).stdout
            self.assertEqual(len(sample), 3)
            for actual, expected in zip(sample, color):
                self.assertAlmostEqual(actual, expected, delta=8)

    def test_failed_export_keeps_previous_result_and_removes_partial_files(self):
        output_dir = self.root / "failed"
        output_dir.mkdir()
        existing = output_dir / "described-video.mp4"
        existing.write_bytes(b"previous result")

        def fail_export(command, description, timeout=180):
            if description == "Extended narrated video export":
                Path(command[-1]).write_bytes(b"partial video")
                raise PipelineError("Simulated export failure")
            return _run(command, description, timeout)

        with patch("local_backend.extended._run", side_effect=fail_export):
            with self.assertRaisesRegex(PipelineError, "Simulated export failure"):
                self.render("failed")
        self.assertEqual(existing.read_bytes(), b"previous result")
        self.assertEqual(list(output_dir.iterdir()), [existing])

    def test_rejects_word_splitting_and_unbounded_insertions_before_rendering(self):
        with self.assertRaisesRegex(PipelineError, "split a spoken word"):
            self.render("split", segments=[{**self.segments[0], "insertion_time": 0.5}])
        with self.assertRaisesRegex(PipelineError, "at most four"):
            self.render("too-many", segments=[{**self.segments[0], "segment_index": i} for i in range(5)])


if __name__ == "__main__":
    unittest.main()
