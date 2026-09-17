"""Word alignment and continuous-recognition contracts without Azure requests."""
import json
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from local_backend.transcription import TranscriptionError, _parse_result, transcribe_audio, transcript_cues


def hypothesis(text, words, offset=0, duration=120_000_000):
    return {"Offset": offset, "Duration": duration, "NBest": [{"Display": text, "Confidence": 0.94,
        "Words": [{"Word": word, "Offset": round(start * 10_000_000),
                   "Duration": round((end - start) * 10_000_000), "Confidence": 0.95}
                  for word, start, end in words]}]}


class Signal:
    def __init__(self):
        self.callbacks = []

    def connect(self, callback):
        self.callbacks.append(callback)

    def emit(self, event):
        for callback in self.callbacks:
            callback(event)


class FakeSDK:
    ResultReason = SimpleNamespace(RecognizedSpeech="recognized", NoMatch="no-match", RecognizingSpeech="partial")
    CancellationReason = SimpleNamespace(Error="error", EndOfStream="eof")
    OutputFormat = SimpleNamespace(Detailed="detailed")
    audio = SimpleNamespace(AudioConfig=lambda **kwargs: SimpleNamespace(**kwargs))
    PropertyId = SimpleNamespace(SpeechServiceConnection_LanguageIdMode="LanguageIdMode")
    languageconfig = SimpleNamespace(AutoDetectSourceLanguageConfig=lambda **kwargs: SimpleNamespace(**kwargs))
    AutoDetectSourceLanguageResult = staticmethod(lambda result: SimpleNamespace(language=None))

    def __init__(self, events, finish=True):
        self.events, self.finish = events, finish
        self.stopped = False

    def SpeechConfig(self, **kwargs):
        self.config = SimpleNamespace(**kwargs, word_level=False, properties={})
        self.config.request_word_level_timestamps = lambda: setattr(self.config, "word_level", True)
        self.config.set_property = lambda key, value: self.config.properties.update({key: value})
        return self.config

    def SpeechRecognizer(self, **kwargs):
        self.arguments = kwargs
        self.recognizer = SimpleNamespace(recognized=Signal(), canceled=Signal(), session_stopped=Signal())

        def start():
            for kind, value in self.events:
                if kind == "canceled":
                    self.recognizer.canceled.emit(value)
                elif kind == "session-stopped":
                    self.recognizer.session_stopped.emit(value)
                else:
                    text = value.get("NBest", [{}])[0].get("Display", "")
                    self.recognizer.recognized.emit(SimpleNamespace(result=SimpleNamespace(
                        reason=kind, json=json.dumps(value), text=text)))
            if self.finish:
                self.recognizer.session_stopped.emit(None)

        def stop():
            self.stopped = True

        self.recognizer.start_continuous_recognition_async = lambda: SimpleNamespace(get=start)
        self.recognizer.stop_continuous_recognition_async = lambda: SimpleNamespace(get=stop)
        return self.recognizer


class ContinuousTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.audio = Path(self.directory.name) / "dialogue.wav"
        with wave.open(str(self.audio), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0\0" * 16000 * 12)
        self.settings = SimpleNamespace(azure_speech_key="test-speech-secret",
            azure_openai_api_key="test-openai-secret", speech_language="zh-CN", dialogue_language="zh-CN",
            azure_speech_endpoint="https://example.services.ai.azure.com/api/projects/demo")

    def recognize(self, sdk, progress=None):
        with patch("local_backend.transcription._load_sdk", return_value=sdk):
            return transcribe_audio(self.audio, self.settings, progress)

    def test_chinese_fixture_keeps_actual_word_times_and_display_text(self):
        # Times match the observed nonsecret Chinese validation result shape.
        data = hypothesis("欢迎现在开始演示。", [("欢", 1.15, 1.43), ("迎", 1.43, 1.79),
            ("现", 1.91, 2.15), ("在", 2.15, 2.27), ("开", 2.27, 2.47),
            ("始", 2.47, 2.59), ("演", 2.59, 2.83), ("示", 2.83, 3.15)], offset=11_500_000)
        sdk = FakeSDK([("recognized", data)])
        progress = []
        result = self.recognize(sdk, progress.append)
        self.assertEqual(result["text"], "欢迎现在开始演示。")
        self.assertAlmostEqual(result["words"][0]["start"], 1.15)
        self.assertAlmostEqual(result["phrases"][0]["end"], 3.15)
        self.assertEqual(result["timing_source"], "azure_speech_continuous")
        self.assertEqual(result["language"], "zh-CN")
        self.assertTrue(sdk.config.word_level)
        self.assertEqual(sdk.config.output_format, "detailed")
        self.assertEqual(sdk.config.speech_recognition_language, "zh-CN")
        self.assertEqual(sdk.config.endpoint, "wss://example.services.ai.azure.com/stt/speech/recognition/conversation/cognitiveservices/v1")
        self.assertEqual(progress[0]["phrase_count"], 1)
        self.assertTrue(sdk.stopped)

    def test_multiple_utterances_use_full_stream_offsets_and_only_final_results(self):
        self.settings.speech_language = "en-US"
        self.settings.dialogue_language = "en-US"
        first = hypothesis("Welcome.", [("welcome", 1, 1.6)], offset=10_000_000)
        second = hypothesis("Begin now.", [("begin", 8, 8.5), ("now", 8.7, 9.1)], offset=80_000_000)
        result = self.recognize(FakeSDK([("partial", hypothesis("Wrong partial", [("wrong", 0, 1)])),
                                        ("recognized", first), ("no-match", {}), ("recognized", second)]))
        self.assertEqual(result["text"], "Welcome. Begin now.")
        self.assertEqual(result["words"][1]["start"], 8)
        self.assertAlmostEqual(result["phrases"][1]["end"], 9.1)
        self.assertEqual(result["quality"]["no_match_count"], 1)

    def test_missing_words_fail_instead_of_assigning_even_timestamps(self):
        sdk = FakeSDK([("recognized", hypothesis("Some dialogue", []))])
        with self.assertRaisesRegex(TranscriptionError, "without word timestamps"):
            self.recognize(sdk)
        self.assertTrue(sdk.stopped)

    def test_empty_success_without_words_is_not_a_timing_failure(self):
        # Observed on the 4.32-second no-dialogue clip: Success with an empty
        # final hypothesis, no Words property, and whole-stream Duration.
        self.settings.dialogue_language = 'auto'
        data = {'RecognitionStatus': 'Success', 'Offset': 0, 'Duration': 43200000,
                'DisplayText': '', 'NBest': [{'Confidence': 0, 'Lexical': '',
                'ITN': '', 'MaskedITN': '', 'Display': ''}]}
        result = self.recognize(FakeSDK([('recognized', data)]))
        self.assertEqual(result['words'], [])
        self.assertEqual(result['phrases'], [])
        self.assertEqual(result['text'], '')
        self.assertFalse(result['quality']['review_required'])

    def test_empty_success_does_not_erase_adjacent_timed_speech(self):
        empty = {'Id': 'empty', 'NBest': [{'Display': '  ', 'Lexical': '', 'Words': []}]}
        speech = hypothesis('Hello.', [('hello', 1, 2)])
        for events in [[empty, speech], [speech, empty]]:
            with self.subTest(empty_first=events[0] is empty):
                result = self.recognize(FakeSDK([('recognized', event) for event in events]))
                self.assertEqual(result['text'], 'Hello.')
                self.assertEqual(len(result['words']), 1)

    def test_missing_timings_for_any_text_representation_still_fails(self):
        for key in ('Display', 'Lexical', 'ITN', 'MaskedITN', 'DisplayText', 'fallback'):
            for words in (None, []):
                with self.subTest(field=key, words=words):
                    data = {'NBest': [{'Display': '', 'Lexical': '', 'Words': words}]}
                    fallback = 'Hello' if key == 'fallback' else ''
                    if key == 'DisplayText':
                        data[key] = 'Hello'
                    elif key != 'fallback':
                        data['NBest'][0][key] = 'Hello'
                    with self.assertRaisesRegex(TranscriptionError, 'without word timestamps'):
                        _parse_result(data, fallback, 12, 'en-US')

    def test_malformed_response_and_unmatched_speech_are_not_empty_success(self):
        for data in ({'NBest': []}, {'NBest': [{}]}, {'NBest': [{'Display': '', 'Words': {}}]}):
            with self.subTest(data=data), self.assertRaises(TranscriptionError):
                _parse_result(data, '', 12, 'en-US')
        with self.assertRaisesRegex(TranscriptionError, 'correct dialogue language'):
            self.recognize(FakeSDK([('recognized', {'NBest': [{'Display': ''}]}), ('no-match', {})]))

    def test_invalid_or_out_of_audio_times_are_rejected(self):
        for words in [[("hello", -1, 1)], [("hello", 1, 1)], [("hello", 11, 14)],
                      [("one", 1, 3), ("two", 2, 4)]]:
            with self.subTest(words=words), self.assertRaises(TranscriptionError):
                self.recognize(FakeSDK([("recognized", hypothesis("Dialogue", words))]))

    def test_cancellation_redacts_credentials_and_stops(self):
        event = SimpleNamespace(reason="error", error_details="bad test-speech-secret test-openai-secret")
        sdk = FakeSDK([("canceled", event)])
        with self.assertRaises(TranscriptionError) as context:
            self.recognize(sdk)
        self.assertNotIn("test-speech-secret", str(context.exception))
        self.assertNotIn("test-openai-secret", str(context.exception))
        self.assertIn("[REDACTED]", str(context.exception))
        self.assertTrue(sdk.stopped)

    def test_region_configuration_and_empty_audio_recognition(self):
        self.settings.azure_speech_endpoint = ""
        self.settings.azure_speech_region = "eastus"
        self.settings.speech_language = "en-US"
        self.settings.dialogue_language = "en-US"
        sdk = FakeSDK([])
        result = self.recognize(sdk)
        self.assertEqual(sdk.config.region, "eastus")
        self.assertEqual(result["words"], [])
        self.assertEqual(result["text"], "")

    def test_only_no_match_does_not_become_dialogue_free_video(self):
        sdk = FakeSDK([("no-match", {})])
        with self.assertRaisesRegex(TranscriptionError, "correct dialogue language"):
            self.recognize(sdk)
        self.assertTrue(sdk.stopped)

    def test_unfinished_session_times_out_and_stops(self):
        sdk = FakeSDK([], finish=False)
        with patch("local_backend.transcription.time.monotonic", side_effect=[0, 1, 1000]), \
                self.assertRaisesRegex(TranscriptionError, "timed out"):
            self.recognize(sdk)
        self.assertTrue(sdk.stopped)

    def test_end_of_stream_cancellation_is_success(self):
        sdk = FakeSDK([("canceled", SimpleNamespace(reason="eof"))], finish=False)
        self.assertEqual(self.recognize(sdk)["phrases"], [])

    def test_sdk_result_cancellation_details_end_of_stream_is_success(self):
        event = SimpleNamespace(result=SimpleNamespace(cancellation_details=SimpleNamespace(reason="eof")))
        sdk = FakeSDK([("recognized", hypothesis("欢迎。", [("欢迎", 1.15, 1.79)])),
                       ("canceled", event)], finish=False)
        self.assertEqual(self.recognize(sdk)["text"], "欢迎。")

    def test_cancellation_after_successful_session_stop_is_ignored(self):
        sdk = FakeSDK([("recognized", hypothesis("欢迎。", [("欢迎", 1.15, 1.79)])),
                       ("session-stopped", None), ("canceled", SimpleNamespace())], finish=False)
        self.assertEqual(self.recognize(sdk)["text"], "欢迎。")

    def test_sdk_result_cancellation_error_is_redacted(self):
        event = SimpleNamespace(result=SimpleNamespace(cancellation_details=SimpleNamespace(
            reason="error", error_details="Invalid test-speech-secret")))
        with self.assertRaises(TranscriptionError) as context:
            self.recognize(FakeSDK([("canceled", event)], finish=False))
        self.assertIn("Invalid [REDACTED]", str(context.exception))

    def test_auto_language_does_not_follow_narration_and_identifies_each_utterance(self):
        self.settings.dialogue_language = "auto"
        english = hypothesis("Welcome to the workshop.", [("welcome", 1, 1.5), ("to", 1.5, 1.6),
            ("the", 1.6, 1.8), ("workshop", 1.8, 3)])
        english["PrimaryLanguage"] = {"Language": "en-US"}
        chinese = hypothesis("欢迎。", [("欢迎", 6, 7)])
        chinese["PrimaryLanguage"] = {"Language": "zh-CN"}
        sdk = FakeSDK([("recognized", english), ("recognized", chinese)])
        result = self.recognize(sdk)
        self.assertEqual(result["language"], "en-US")
        self.assertEqual([phrase["language"] for phrase in result["phrases"]], ["en-US", "zh-CN"])
        self.assertEqual(sdk.arguments["auto_detect_source_language_config"].languages, ["zh-CN", "en-US"])
        self.assertEqual(sdk.config.properties["LanguageIdMode"], "Continuous")
        self.assertFalse(hasattr(sdk.config, "speech_recognition_language"))
        self.assertTrue(sdk.config.endpoint.endswith("/stt/speech/universal/v2"))
        self.assertEqual(result["quality"]["requested_language"], "auto")

    def test_missing_dialogue_preference_defaults_to_auto_not_narration(self):
        del self.settings.dialogue_language
        sdk = FakeSDK([])
        self.recognize(sdk)
        self.assertIn("auto_detect_source_language_config", sdk.arguments)

    def test_explicit_original_language_is_independent_of_narration(self):
        self.settings.dialogue_language = "en-US"
        sdk = FakeSDK([("recognized", hypothesis("Hello.", [("hello", 1, 2)]))])
        result = self.recognize(sdk)
        self.assertEqual(sdk.config.speech_recognition_language, "en-US")
        self.assertEqual(result["language"], "en-US")
        self.assertEqual(self.settings.speech_language, "zh-CN")

    def test_auto_language_without_detected_language_requires_selection(self):
        self.settings.dialogue_language = "auto"
        with self.assertRaisesRegex(TranscriptionError, "identify the dialogue language"):
            self.recognize(FakeSDK([("recognized", hypothesis("Hello.", [("hello", 1, 2)]))]))

    def test_low_confidence_is_flagged_without_rewriting_recognition(self):
        data = hypothesis("Uncertain name.", [("uncertain", 1, 1.5), ("name", 1.5, 2)])
        data["NBest"][0]["Confidence"] = 0.55
        data["NBest"][0]["Words"][0]["Confidence"] = 0.3
        result = self.recognize(FakeSDK([("recognized", data)]))
        self.assertEqual(result["text"], "Uncertain name.")
        self.assertTrue(result["quality"]["review_required"])
        self.assertEqual(result["quality"]["low_confidence_phrase_count"], 1)
        self.assertEqual(result["quality"]["low_confidence_word_count"], 1)
        self.assertEqual(result["quality"]["uncertain_spans"], [{"start": 1, "end": 2, "confidence": 0.55}])

    def test_chinese_utterance_with_latin_words_keeps_spaces_when_display_absent(self):
        data = hypothesis("", [("欢迎", 1, 1.5), ("to", 1.5, 2), ("Vision", 2, 2.5), ("Echo", 2.5, 3)])
        self.assertEqual(self.recognize(FakeSDK([("recognized", data)]))["text"], "欢迎to Vision Echo")


class CueTests(unittest.TestCase):
    def transcript(self, display, lexical, language="en-US"):
        words = [{"text": text, "start": start, "end": end} for text, start, end in lexical]
        return {"language": language, "phrases": [{"text": display, "start": words[0]["start"],
            "end": words[-1]["end"]}], "words": words}

    def test_short_phrase_preserves_display_punctuation(self):
        transcript = {"language": "zh-CN", "phrases": [{"text": "欢迎。", "start": 1.15, "end": 1.79}], "words": []}
        self.assertEqual(transcript_cues(transcript), [{"id": "cue-0001", "text": "欢迎。", "start": 1.15, "end": 1.79}])

    def test_long_chinese_phrase_splits_at_real_pauses_without_spaces(self):
        transcript = {"language": "zh-CN", "phrases": [{"text": "欢迎开始", "start": 1, "end": 10}],
            "words": [{"text": "欢", "start": 1, "end": 1.3}, {"text": "迎", "start": 1.3, "end": 1.7},
                      {"text": "开", "start": 9, "end": 9.4}, {"text": "始", "start": 9.4, "end": 10}]}
        cues = transcript_cues(transcript)
        self.assertEqual([cue["text"] for cue in cues], ["欢迎", "开始"])
        self.assertEqual([(cue["start"], cue["end"]) for cue in cues], [(1, 1.7), (9, 10)])

    def test_long_english_phrase_splits_at_word_boundaries(self):
        transcript = {"language": "en-US", "phrases": [{"text": "One two three four.", "start": 0, "end": 8}],
            "words": [{"text": text, "start": start, "end": start + 2}
                      for text, start in [("One", 0), ("two", 2), ("three", 4), ("four.", 6)]]}
        cues = transcript_cues(transcript, max_seconds=5)
        self.assertEqual([cue["text"] for cue in cues], ["One two", "three four."])
        self.assertEqual([(cue["start"], cue["end"]) for cue in cues], [(0, 4), (4, 8)])

    def test_long_phrase_without_words_is_not_guessed(self):
        with self.assertRaisesRegex(TranscriptionError, "without word timestamps"):
            transcript_cues({"phrases": [{"text": "No timings", "start": 0, "end": 9}]})
        with self.assertRaises(TranscriptionError):
            transcript_cues({}, max_seconds=0)

    def test_long_display_keeps_itn_currency_numbers_and_capitalization(self):
        transcript = self.transcript("Pay $200 today, then wait 365 days.", [("pay", 0, 1),
            ("two", 1, 2), ("hundred", 2, 3), ("dollars", 3, 4), ("today", 4, 5),
            ("then", 5, 6), ("wait", 6, 7), ("three", 7, 8), ("hundred", 8, 9),
            ("sixty", 9, 10), ("five", 10, 11), ("days", 11, 12)])
        cues = transcript_cues(transcript, max_seconds=5)
        self.assertEqual([cue["text"] for cue in cues], ["Pay $200 today,", "then wait", "365 days."])
        self.assertEqual([(cue["start"], cue["end"]) for cue in cues], [(0, 5), (5, 7), (7, 12)])

    def test_long_english_in_chinese_locale_keeps_original_spaces(self):
        display = "Welcome to the workshop. We start today."
        lexical = [(word, index, index + 1) for index, word in enumerate(
            ["welcome", "to", "the", "workshop", "we", "start", "today"])]
        cues = transcript_cues(self.transcript(display, lexical, "zh-CN"))
        self.assertEqual([cue["text"] for cue in cues], ["Welcome to the workshop.", "We start today."])

    def test_short_phrase_splits_measured_pause_without_losing_punctuation(self):
        cues = transcript_cues(self.transcript("Ready, everyone? Begin now.", [("ready", 0, .5),
            ("everyone", .5, 1), ("begin", 3, 3.5), ("now", 3.5, 4)]))
        self.assertEqual([cue["text"] for cue in cues], ["Ready, everyone?", "Begin now."])
        self.assertEqual([(cue["start"], cue["end"]) for cue in cues], [(0, 1), (3, 4)])

    def test_mixed_chinese_latin_display_is_preserved(self):
        cues = transcript_cues(self.transcript("欢迎来到 Vision Echo。Let's start!", [("欢", 0, .3),
            ("迎", .3, .6), ("来", .6, .9), ("到", .9, 1.2), ("vision", 1.2, 1.5),
            ("echo", 1.5, 2), ("let's", 3, 3.5), ("start", 3.5, 4)], "zh-CN"))
        self.assertEqual([cue["text"] for cue in cues], ["欢迎来到 Vision Echo。", "Let's start!"])

    def test_unalignable_normalized_span_preserves_all_display_without_fake_times(self):
        transcript = self.transcript("2026/09/17", [("september", 0, 2), ("seventeenth", 2, 4),
            ("twenty", 4, 5), ("twenty", 5, 6), ("six", 6, 7)])
        self.assertEqual(transcript_cues(transcript, max_seconds=3),
            [{"id": "cue-0001", "text": "2026/09/17", "start": 0, "end": 7}])

    def test_adjacent_cue_timing_does_not_have_floating_point_overlap(self):
        cues = transcript_cues(self.transcript("First. Second.", [("first", 4.94, 4.94 + .44),
            ("second", 5.38, 6.0)]))
        self.assertEqual(cues[0]["end"], cues[1]["start"])

    def test_closed_quotes_and_contractions_keep_original_display(self):
        transcript = self.transcript("She says “Hello!” Then we're ready.", [("she", 0, 1),
            ("says", 1, 2), ("hello", 2, 3), ("then", 4, 5), ("we're", 5, 6), ("ready", 6, 7)])
        cues = transcript_cues(transcript)
        self.assertEqual([cue["text"] for cue in cues], ["She says “Hello!”", "Then we're ready."])
        transcript["phrases"][0]["text"] = 'She says "Hello!" Then we’re ready.'
        self.assertEqual([cue["text"] for cue in transcript_cues(transcript)],
                         ['She says "Hello!"', 'Then we’re ready.'])


if __name__ == "__main__":
    unittest.main()
