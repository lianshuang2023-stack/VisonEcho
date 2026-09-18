"""Final ConversationTranscriber attribution, measured overlap, and cue quality."""
import json
from types import SimpleNamespace
import wave
from unittest.mock import patch

import pytest
from local_backend.transcription import transcribe_audio, transcript_cues, TranscriptionError, CUE_FORMAT_VERSION
from local_backend.test_transcription import FakeSDK, Signal, hypothesis


class ConversationSDK(FakeSDK):
    def __init__(self, events, finish=True):
        super().__init__(events,finish)
        self.transcription=SimpleNamespace(ConversationTranscriber=self.ConversationTranscriber)
    def ConversationTranscriber(self,**kwargs):
        self.arguments=kwargs
        self.recognizer=SimpleNamespace(transcribed=Signal(),transcribing=Signal(),canceled=Signal(),session_stopped=Signal())
        def start():
            for kind,value in self.events:
                if kind=='canceled':
                    self.recognizer.canceled.emit(value);continue
                text=value.get('NBest',[{}])[0].get('Display','')
                event=SimpleNamespace(result=SimpleNamespace(reason='recognized' if kind=='final' else kind,
                    json=json.dumps(value),text=text,speaker_id=value.get('_speaker'),no_match_details=None))
                (self.recognizer.transcribing if kind=='partial' else self.recognizer.transcribed).emit(event)
            if self.finish:self.recognizer.session_stopped.emit(None)
        self.recognizer.start_transcribing_async=lambda:SimpleNamespace(get=start)
        self.recognizer.stop_transcribing_async=lambda:SimpleNamespace(get=lambda:setattr(self,'stopped',True))
        return self.recognizer


def utterance(text,words,speaker,identifier):
    data=hypothesis(text,words);data.update(_speaker=speaker,Id=identifier,PrimaryLanguage={'Language':'en-US'})
    return data


@pytest.fixture
def audio(tmp_path):
    path=tmp_path/'audio.wav'
    with wave.open(str(path),'wb') as target:
        target.setparams((1,2,16000,0,'NONE','not compressed'));target.writeframes(bytes(16000*2*12))
    return path


def recognize(audio,events,language='auto',sdk=None):
    sdk=sdk or ConversationSDK(events)
    settings=SimpleNamespace(azure_speech_key='test-key',azure_openai_api_key='test-key',dialogue_language=language,
        azure_speech_endpoint='https://example.services.ai.azure.com')
    with patch('local_backend.transcription._load_sdk',return_value=sdk):
        return transcribe_audio(audio,settings),sdk


def test_final_speakers_number_by_source_time_not_callback_arrival(audio):
    later=utterance('Later voice.',[('later',5,5.5),('voice',5.5,6)],'Guest-Z','z')
    earlier=utterance('First voice.',[('first',1,1.5),('voice',1.5,2)],'Guest-A','a')
    again=utterance('First returns.',[('first',8,8.5),('returns',8.5,9)],'Guest-A','a2')
    result,sdk=recognize(audio,[('partial',utterance('Ignored.',[('ignored',0,.5)],'Guest-P','p')),('final',later),('final',earlier),('final',again),('final',again)])
    assert [p['speaker'] for p in result['phrases']]==['speaker_1','speaker_2','speaker_1']
    assert [p['start'] for p in result['phrases']]==[1,5,8]
    assert result['quality']['speaker_count']==2 and result['quality']['diarization_available']
    assert result['timing_source']=='azure_speech_conversation'
    assert sdk.config.endpoint.endswith('/stt/speech/universal/v2')
    assert sdk.arguments['auto_detect_source_language_config'].languages==['zh-CN','en-US']
    assert 'Guest-' not in json.dumps(result) and sdk.stopped
    assert CUE_FORMAT_VERSION==3
    cues=transcript_cues(result)
    assert [cue['speaker'] for cue in cues]==['speaker_1','speaker_2','speaker_1']
    assert [cue['text'] for cue in cues]==['First voice','Later voice','First returns']
    assert not any(cue['low_confidence'] for cue in cues)


def test_distinct_speakers_may_overlap_without_mixing_words_between_cues(audio):
    first=utterance('One, two three four.',[('one',0,1),('two',1,2),('three',2,3),('four',3,4)],'A','a')
    second=utterance('Another speaks.',[('another',1.2,1.7),('speaks',1.7,2.7)],'B','b')
    result,_=recognize(audio,[('final',second),('final',first)])
    cues=transcript_cues(result,max_seconds=2)
    assert result['quality']['overlapping_utterance_count']==1 and result['quality']['review_required']
    assert [(cue['text'],cue['speaker']) for cue in cues]==[
        ('One two','speaker_1'),('Another speaks','speaker_2'),('three four','speaker_1')]
    assert all(cue['low_confidence'] for cue in cues)
    assert [(cue['start'],cue['end']) for cue in cues]==[(0,2),(1.2,2.7),(2,4)]


@pytest.mark.parametrize('speakers',[('A','A'),('A','Unknown'),(None,'B')])
def test_same_or_unknown_speaker_overlap_is_not_accepted(audio,speakers):
    with pytest.raises(TranscriptionError,match='without distinct speakers'):
        recognize(audio,[('final',utterance('First.',[('first',0,2)],speakers[0],'1')),
                         ('final',utterance('Second.',[('second',1,3)],speakers[1],'2'))])


def test_unknown_provider_label_stays_null_and_explicit_language_is_preserved(audio):
    result,sdk=recognize(audio,[('final',utterance('Unknown speaker.',[('unknown',1,2),('speaker',2,3)],'Unknown','u'))],language='en-US')
    assert result['phrases'][0]['speaker'] is None
    assert all(word['speaker'] is None for word in result['words'])
    assert result['quality']['speaker_count']==0
    assert sdk.config.speech_recognition_language=='en-US'
    assert 'auto_detect_source_language_config' not in sdk.arguments


def test_word_confidence_and_raw_punctuation_are_preserved(audio):
    data=utterance("Don't wait, please.",[('don\'t',1,2),('wait',2,3),('please',3,4)],'A','a')
    data['NBest'][0]['Words'][1]['Confidence']=.4
    result,_=recognize(audio,[('final',data)])
    assert result['phrases'][0]['text']=="Don't wait, please."
    assert result['words'][1]['confidence']==.4
    cues=transcript_cues(result)
    assert cues[0]['text']=="Don't wait please" and cues[0]['low_confidence']
    assert cues[0]['speaker']=='speaker_1'


def test_conversation_provider_error_is_not_retried_with_legacy_recognizer(audio):
    sdk=ConversationSDK([('canceled',SimpleNamespace(reason='error',error_details='test-key authentication failed'))])
    sdk.SpeechRecognizer=lambda **kwargs:pytest.fail('Provider errors must not fall back and upload twice')
    with pytest.raises(TranscriptionError,match='REDACTED'):
        recognize(audio,[],sdk=sdk)
    assert sdk.stopped


def test_legacy_capability_fallback_has_no_fabricated_speaker(audio):
    sdk=FakeSDK([('recognized',hypothesis('Hello.',[('hello',1,2)]))])
    result,_=recognize(audio,[],language='en-US',sdk=sdk)
    assert result['timing_source']=='azure_speech_continuous'
    assert not result['quality']['diarization_available']
    assert result['phrases'][0]['speaker'] is None


def test_conversation_end_of_stream_details_on_event_complete_successfully(audio):
    sdk=ConversationSDK([('canceled',SimpleNamespace(
        cancellation_details=SimpleNamespace(reason='eof'),result=SimpleNamespace(cancellation_details=None)))],finish=False)
    result,_=recognize(audio,[],sdk=sdk)
    assert result['dialogue_status']=='no_speech' and result['words']==[]
    assert sdk.stopped
