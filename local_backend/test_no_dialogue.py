"""Nonspeech and failed recognition paths preserve audio, with no Azure calls."""
from array import array
from copy import deepcopy
import json
import math
from pathlib import Path
import subprocess
import wave

import pytest
from local_backend import pipeline, transcription
from local_backend.config import Settings
from local_backend.test_transcription import FakeSDK


@pytest.fixture
def no_dialogue_media(tmp_path,monkeypatch):
    paths={}
    for name,audio in [('audible','sine=frequency=220:sample_rate=48000:duration=6'),
                       ('silence','anullsrc=r=48000:cl=mono')]:
        source=tmp_path/(name+'.mp4')
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=96x64:r=30:d=6',
            '-f','lavfi','-i',audio,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-t','6',str(source)],check=True)
        paths[name]=source
    paths['no-track']=tmp_path/'no-track.mp4'
    subprocess.run(['ffmpeg','-v','error','-i',str(paths['audible']),'-an','-c:v','copy',str(paths['no-track'])],check=True)
    calls={'sdk':0,'description':0,'tts':0,'windows':[]}
    def sdk():
        calls['sdk']+=1
        return FakeSDK([('no-match',{'NoMatchReason':'NotRecognized'})])
    monkeypatch.setattr(transcription,'_load_sdk',sdk)
    def describe(segment,*args):
        calls['description']+=1;calls['windows'].append(deepcopy(segment))
        return 'A blue background.', {'request_count':1,'total_tokens':20}
    def synth(text,path,*args):
        calls['tts']+=1
        samples=array('h',(round(7000*math.sin(2*math.pi*950*i/24000)) for i in range(24000)))
        with wave.open(str(path),'wb') as target:
            target.setparams((1,2,24000,0,'NONE','not compressed'));target.writeframes(samples.tobytes())
        return 0
    monkeypatch.setattr(pipeline,'_generate_description',describe)
    monkeypatch.setattr(pipeline,'_synthesize',synth)
    settings=Settings(azure_openai_endpoint='https://example.openai.azure.com/openai/v1',
        azure_openai_api_key='test-only',azure_speech_key='test-only',azure_speech_region='eastus')
    return paths,calls,settings


def samples(path):
    raw=subprocess.run(['ffmpeg','-v','error','-i',str(path),'-vn','-ac','1','-ar','24000',
        '-f','s16le','-'],check=True,capture_output=True).stdout
    result=array('h');result.frombytes(raw);return result


def energy(data,start,length,frequency):
    values=data[round(start*24000):round((start+length)*24000)]
    real=sum(value*math.cos(2*math.pi*frequency*index/24000) for index,value in enumerate(values))
    imag=sum(value*math.sin(2*math.pi*frequency*index/24000) for index,value in enumerate(values))
    return math.hypot(real,imag)/len(values)


@pytest.mark.parametrize('mode',['auto','extended'])
def test_finished_unrecognized_audio_uses_one_final_pause_and_keeps_soundtrack(no_dialogue_media,tmp_path,mode):
    paths,calls,settings=no_dialogue_media;settings.narration_mode=mode
    output=tmp_path/('unknown-'+mode)
    result=pipeline.process_video(paths['audible'],output,settings,2,lambda *args:None)
    assert calls['sdk']==1 and calls['description']==1 and calls['tts']==1
    assert result['dialogue_status']=='unrecognized' and result['dialogue_reason']=='speech_not_recognized'
    assert result['narration_mode']=='extended' and result['outcome']=='audio_description'
    assert len(result['insertions'])==1 and result['insertions'][0]['source_time']==pytest.approx(6)
    assert calls['windows'][0]['source_start']==0 and calls['windows'][0]['source_end']==pytest.approx(6)
    transcript=json.loads(Path(result['transcript_path']).read_text())
    assert transcript['words']==[] and transcript['phrases']==[] and transcript['cues']==[]
    assert transcript['quality']['review_required']
    assert result['summary']['video_duration']>7
    decoded=samples(result['output_path'])
    assert energy(decoded,1,.3,220)>1000 and energy(decoded,5,.3,220)>1000
    assert energy(decoded,6.1,.3,950)>1500
    assert energy(decoded,6.1,.3,220)<150


def test_unknown_audio_in_standard_keeps_source_duration_without_mixing_narration(no_dialogue_media,tmp_path):
    paths,calls,settings=no_dialogue_media;settings.narration_mode='standard'
    result=pipeline.process_video(paths['audible'],tmp_path/'unknown-standard',settings,2,lambda *args:None)
    assert calls['sdk']==1 and calls['description']==calls['tts']==0
    assert result['dialogue_status']=='unrecognized' and result['narration_mode']=='standard'
    assert result['segments']==[] and result['insertions']==[] and result['outcome']=='subtitles_only'
    assert pipeline.probe_media(Path(result['output_path']),settings)['duration']==pytest.approx(6,abs=.1)
    assert energy(samples(result['output_path']),2,.3,220)>1000


def test_user_declares_no_dialogue_skips_sdk_and_audio_extraction(no_dialogue_media,tmp_path,monkeypatch):
    paths,calls,settings=no_dialogue_media;settings.dialogue_language='none'
    monkeypatch.setattr(transcription,'transcribe_audio',lambda *args:pytest.fail('STT must not be called'))
    output=tmp_path/'declared-none'
    result=pipeline.process_video(paths['audible'],output,settings,2,lambda *args:None)
    assert calls['sdk']==0 and calls['description']==1 and calls['tts']==1
    assert not (output/'dialogue.wav').exists()
    assert result['dialogue_status']=='no_speech' and result['dialogue_reason']=='user_declared_no_dialogue'
    assert result['usage']['transcription_audio_seconds']==0
    assert result['narration_mode']=='standard' and result['summary']['video_duration']==pytest.approx(6)
    assert json.loads(Path(result['transcript_path']).read_text())['cues']==[]


def test_pcm_silence_with_no_match_continues_in_natural_window(no_dialogue_media,tmp_path):
    paths,calls,settings=no_dialogue_media
    result=pipeline.process_video(paths['silence'],tmp_path/'silent',settings,2,lambda *args:None)
    assert calls['sdk']==1 and calls['description']==1 and calls['tts']==1
    assert result['dialogue_status']=='no_speech' and result['dialogue_reason']=='silent_audio'
    assert result['narration_mode']=='standard' and result['insertions']==[]
    transcript=json.loads(Path(result['transcript_path']).read_text())
    assert not transcript['quality']['review_required'] and transcript['cues']==[]
    assert pipeline.probe_media(Path(result['output_path']),settings)['duration']==pytest.approx(6,abs=.1)


def test_no_audio_track_skips_sdk_without_claiming_acoustic_measurement(no_dialogue_media,tmp_path):
    paths,calls,settings=no_dialogue_media
    result=pipeline.process_video(paths['no-track'],tmp_path/'no-track-output',settings,2,lambda *args:None)
    assert calls['sdk']==0 and calls['description']==1 and calls['tts']==1
    assert result['dialogue_status']=='no_speech' and result['dialogue_reason']=='no_audio_track'
    assert result['usage']['transcription_audio_seconds']==0
    assert result['narration_mode']=='standard'
