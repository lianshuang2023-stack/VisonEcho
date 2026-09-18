from pathlib import Path
import json
import math
import subprocess
import wave
from array import array

import pytest
from local_backend.config import Settings
from local_backend import pipeline, transcription, revision

@pytest.fixture
def continuous_video(tmp_path, monkeypatch):
    source = tmp_path / 'continuous.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=96x64:r=30:d=6',
                    '-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=6',
                    '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-t','6',str(source)], check=True)
    transcript = {'text':'Continuous speech.', 'words':[{'text':'speech','start':0,'end':6}],
                  'phrases':[{'text':'Continuous speech.','start':0,'end':6}], 'language':'en-US','timing_source':'speech_words'}
    monkeypatch.setattr(transcription,'transcribe_audio',lambda *args: transcript)
    calls=[]
    def description(*args):
        calls.append('describe')
        return 'A blue background.', {'total_tokens':20}
    def synth(text,path,*args):
        calls.append('tts')
        samples=array('h',(int(5000*math.sin(2*math.pi*950*i/24000)) for i in range(24000)))
        with wave.open(str(path),'wb') as w:
            w.setparams((1,2,24000,0,'NONE','not compressed')); w.writeframes(samples.tobytes())
        return 0
    monkeypatch.setattr(pipeline,'_generate_description',description)
    monkeypatch.setattr(pipeline,'_synthesize',synth)
    monkeypatch.setattr(revision,'_synthesize',synth)
    settings=Settings(azure_openai_endpoint='https://example.openai.azure.com/openai/v1',
                      azure_openai_api_key='fake',azure_speech_key='fake',azure_speech_region='example')
    return source,settings,calls

def test_dense_speech_auto_generates_narration_without_covering_original(continuous_video,tmp_path):
    source,settings,calls=continuous_video
    result=pipeline.process_video(source,tmp_path/'auto',settings,2,lambda *args:None)
    assert calls==['describe','tts']
    assert result['narration_mode']=='extended'
    assert result['outcome']=='audio_description'
    assert result['summary']['passed_segments']==1
    assert result['summary']['video_duration']>7
    assert result['segments'][0]['start_time']==6
    assert result['insertions'][0]['source_time']==6
    assert json.loads(Path(result['transcript_path']).read_text())['cues'][0]['end']==6
    assert Path(result['output_path']).is_file()
    assert pipeline.probe_media(Path(result['output_path']),settings)['duration']>7

def test_standard_mode_reports_subtitles_only_when_dialogue_has_no_gap(continuous_video,tmp_path):
    source,settings,calls=continuous_video
    settings.narration_mode='standard'
    result=pipeline.process_video(source,tmp_path/'standard',settings,2,lambda *args:None)
    assert calls==[]
    assert result['outcome']=='subtitles_only'
    assert result['summary']['passed_segments']==0
    assert '只生成字幕' in result['summary']['message']

def test_extended_revision_uses_original_timeline_and_preserves_prior_cut(continuous_video,tmp_path):
    source,settings,calls=continuous_video
    first=pipeline.process_video(source,tmp_path/'first',settings,2,lambda *args:None)
    first_bytes=Path(first['output_path']).read_bytes()
    first['source_transcript_edits']={'cues':json.loads(Path(first['transcript_path']).read_text())['cues'],'revision':2}
    second=revision.render_revision(source,tmp_path/'second',settings,first,[{'segment_index':0,'dvi_text':'A plain blue screen.'}],lambda *args:None)
    assert second['narration_mode']=='extended'
    assert second['segments'][0]['start_time']==6
    assert second['usage']['openai_requests']==0
    assert second['usage']['tts_requests']==1
    assert Path(first['output_path']).read_bytes()==first_bytes
    assert json.loads((tmp_path/'second/transcript-edits.json').read_text())['revision']==2

def test_export_failure_keeps_generated_text_and_audio_checkpoint(continuous_video,tmp_path,monkeypatch):
    from local_backend import extended
    source,settings,calls=continuous_video
    def failed_export(*args):
        raise pipeline.PipelineError('Local export failed.')
    monkeypatch.setattr(extended,'render_extended_video',failed_export)
    output=tmp_path/'failed-export'
    with pytest.raises(pipeline.PipelineError,match='Local export failed'):
        pipeline.process_video(source,output,settings,2,lambda *args:None)
    checkpoint=json.loads((output/'generation-checkpoint.json').read_text())
    assert checkpoint['stage']=='ready_to_export'
    assert checkpoint['segments'][0]['dvi_text']=='A blue background.'
    assert Path(checkpoint['segments'][0]['audio_path']).is_file()
    assert checkpoint['usage']['tts_requests']==1
    assert (output/'source-transcript.json').is_file()
    assert not (output/'result.json').exists()

def test_empty_speech_success_continues_to_visual_narration(continuous_video,tmp_path,monkeypatch):
    from local_backend.test_transcription import FakeSDK
    source,settings,calls=continuous_video
    monkeypatch.undo()
    sdk=FakeSDK([('recognized', {'RecognitionStatus':'Success', 'DisplayText':'',
        'NBest':[{'Display':'','Lexical':'','ITN':'','MaskedITN':''}]})])
    monkeypatch.setattr(transcription,'_load_sdk',lambda:sdk)
    monkeypatch.setattr(pipeline,'_generate_description',lambda *args:('A blue background.',{}))
    def synth(text,path,*args):
        with wave.open(str(path),'wb') as w:
            w.setparams((1,2,24000,0,'NONE','not compressed'))
            w.writeframes(b'\x01\x00'*24000)
        return 0
    monkeypatch.setattr(pipeline,'_synthesize',synth)
    result=pipeline.process_video(source,tmp_path/'no-dialogue',settings,2,lambda *args:None)
    assert json.loads(Path(result['transcript_path']).read_text())['cues']==[]
    assert result['dialogue_status']=='unrecognized'
    assert result['dialogue_reason']=='speech_not_recognized'
    assert result['narration_mode']=='extended'
    assert result['insertions'][0]['source_time']==pytest.approx(6)
    assert result['outcome']=='audio_description'
    assert result['summary']['passed_segments']==1
    assert Path(result['output_path']).is_file()

@pytest.mark.parametrize('fails', [False, True])
def test_optional_character_analysis_uses_current_frames_and_does_not_block_export(continuous_video,tmp_path,monkeypatch,fails):
    from local_backend import character_detection
    source,settings,calls=continuous_video
    settings.detect_characters=True
    seen=[]
    def analyze(frames, existing, run_settings, client):
        seen.extend(frames)
        if fails:
            raise pipeline.PipelineError('Temporary detector failure')
        return {'candidates': [], 'usage': {'openai_requests':1,'total_tokens':10},
                'coverage': {'frame_count':len(frames),'segment_count':1}}
    monkeypatch.setattr(character_detection,'analyze_character_frames',analyze)
    result=pipeline.process_video(source,tmp_path/'detect',settings,2,lambda *args:None)
    assert seen and all(frame['frame_id'].startswith('f') for frame in seen)
    assert all(frame['job_id']=='detect' for frame in seen)
    assert result['character_detection']['status']==('FAILED' if fails else 'SUCCEEDED')
    assert result['outcome']=='audio_description'
    assert result['usage']['openai_requests']==(1 if fails else 2)
    assert Path(result['output_path']).is_file()
