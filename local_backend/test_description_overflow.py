"""Over-budget drafts recover locally without repeating speech or vision calls."""
from copy import deepcopy
from pathlib import Path
import json
import subprocess
import wave
import httpx
import pytest
from local_backend import pipeline, transcription
from local_backend.config import Settings

FIRST = 'A broad blue background fills the entire frame without a visible subject.'
SECOND = 'A broad blue background fills the whole frame.'

def settings():
    return Settings(azure_openai_endpoint='https://example.openai.azure.com/openai/v1',
                    azure_openai_api_key='test-only',azure_speech_key='test-only',azure_speech_region='eastus')

def completion(text,invalid=False):
    return {'choices':[{'finish_reason':'stop','message':{'content':json.dumps({'description':text,
        'observations':[{'fact':'A blue background.','frame_indices':[90] if invalid else [0]}],
        'character_ids':[]})}}],'usage':{'prompt_tokens':20,'completion_tokens':10,'total_tokens':30}}

@pytest.mark.parametrize('duration',[3.79,2.44])
def test_short_windows_preserve_second_validated_draft_and_two_call_usage(tmp_path,duration):
    frame=tmp_path/'frame.jpg';frame.write_bytes(b'fixture')
    segment={'segment_index':0,'start_time':1.2,'end_time':1.2+duration,'silence_duration':duration}
    requests=[]
    def response(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200,json=completion(FIRST if len(requests)==1 else SECOND))
    with httpx.Client(transport=httpx.MockTransport(response)) as client,pytest.raises(pipeline.DescriptionWindowTooShort) as error:
        pipeline._generate_description(segment,[{'path':frame,'timestamp':2}],{'phrases':[]},[],settings(),client)
    assert len(requests)==2 and error.value.description==SECOND
    assert error.value.usage=={'request_count':2,'prompt_tokens':40,'completion_tokens':20,'total_tokens':60}
    assert segment['evidence_description']==SECOND
    assert segment['visual_evidence']==[{'fact':'A blue background.','frame_timestamps':[2]}]
    assert segment['frame_timestamps']==[2]
    assert 'Shorten' in requests[1]['messages'][-1]['content']

@pytest.fixture
def natural_gap_video(tmp_path,monkeypatch):
    source=tmp_path/'source.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=96x64:r=30:d=6',
        '-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=6',
        '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-t','6',str(source)],check=True)
    calls={'speech':0,'model':0,'tts':0,'frames':0}
    transcript={'text':'First. Last.','words':[{'text':'first','start':0,'end':1},{'text':'last','start':4,'end':6}],
        'phrases':[{'text':'First.','start':0,'end':1},{'text':'Last.','start':4,'end':6}],
        'language':'en-US','timing_source':'azure_speech_continuous'}
    def transcribe(*args):
        calls['speech']+=1
        return deepcopy(transcript)
    def request(*args,**kwargs):
        calls['model']+=1
        return httpx.Response(200,json=completion(FIRST if calls['model']==1 else SECOND))
    def synth(text,path,budget,*args):
        calls['tts']+=1
        assert text==SECOND and budget==8
        with wave.open(str(path),'wb') as audio:
            audio.setparams((1,2,24000,0,'NONE','not compressed'))
            audio.writeframes(bytes([1,0])*24000)
        return 0
    original_extract=pipeline._extract_frames
    def extract(*args):
        calls['frames']+=1
        return original_extract(*args)
    monkeypatch.setattr(transcription,'transcribe_audio',transcribe)
    monkeypatch.setattr(pipeline,'_request',request)
    monkeypatch.setattr(pipeline,'_synthesize',synth)
    monkeypatch.setattr(pipeline,'_extract_frames',extract)
    return source,calls,transcript

def test_auto_reuses_natural_frames_and_draft_in_one_extended_render(natural_gap_video,tmp_path):
    source,calls,original=natural_gap_video
    cfg=settings();result=pipeline.process_video(source,tmp_path/'auto',cfg,2,lambda *args:None)
    assert calls=={'speech':1,'model':2,'tts':1,'frames':1}
    assert result['narration_mode']=='extended' and result['outcome']=='audio_description'
    assert result['usage']['openai_requests']==2 and result['usage']['tts_requests']==1
    segment=result['segments'][0]
    assert segment['source_start']==pytest.approx(1.2) and segment['source_end']==pytest.approx(3.8)
    assert segment['insertion_time']==pytest.approx(3.8)
    assert segment['dvi_text']==SECOND and segment['evidence_description']==SECOND
    assert segment['pass'] and not segment['description_requires_shortening']
    assert all(1.2<=stamp<=3.8 for stamp in segment['frame_timestamps'])
    pause=result['insertions'][0];assert pause['source_time']==pytest.approx(3.8)
    shifted=json.loads(Path(result['transcript_path']).read_text())
    assert shifted['cues'][0]['end']==1 and shifted['cues'][1]['start']==pytest.approx(4+pause['duration'])
    assert json.loads(Path(result['source_transcript_path']).read_text())['words']==original['words']
    assert pipeline.probe_media(Path(result['output_path']),cfg)['duration']==pytest.approx(6+pause['duration'],abs=.1)

def test_standard_keeps_overflow_draft_unvoiced_without_tts(natural_gap_video,tmp_path):
    source,calls,_=natural_gap_video
    cfg=settings();cfg.narration_mode='standard'
    result=pipeline.process_video(source,tmp_path/'standard',cfg,2,lambda *args:None)
    assert calls=={'speech':1,'model':2,'tts':0,'frames':1}
    assert result['narration_mode']=='standard' and result['outcome']=='subtitles_only'
    segment=result['segments'][0]
    assert segment['dvi_text']==SECOND and segment['evidence_description']==SECOND
    assert segment['description_requires_shortening'] and not segment['pass']
    assert 'skip_reason' in segment and result['insertions']==[]
    assert json.loads((tmp_path/'standard/generation-checkpoint.json').read_text())['segments'][0]['dvi_text']==SECOND
    assert pipeline.probe_media(Path(result['output_path']),cfg)['duration']==pytest.approx(6,abs=.1)

def draft(index=0,text=SECOND):
    return {'segment_index':index,'start_time':1+index*4,'end_time':3+index*4,'silence_duration':2,
            'dvi_text':text,'description_requires_shortening':True,'skip_reason':'too short',
            'evidence_description':text,'frame_timestamps':[2+index*4]}

@pytest.mark.parametrize('case',['more_than_four','more_than_eight_seconds','standard','already_extended'])
def test_fallback_limits_leave_all_drafts_and_timing_unchanged(case):
    segments=[draft(index) for index in range(5 if case=='more_than_four' else 1)];cfg=settings()
    if case=='more_than_eight_seconds':segments[0]['dvi_text']=' '.join(['word']*17)
    if case=='standard':cfg.narration_mode='standard'
    if case=='already_extended':segments[0]['insertion_time']=3
    before=deepcopy(segments)
    assert not pipeline._extend_overflow_windows(segments,cfg)
    assert segments==before

def test_fallback_converts_every_window_preserving_frame_evidence():
    segments=[draft(),draft(1,'Blue screen.')];segments[1]['description_requires_shortening']=False
    before=deepcopy(segments);assert pipeline._extend_overflow_windows(segments,settings())
    for old,new in zip(before,segments):
        assert new['source_start']==old['start_time'] and new['source_end']==old['end_time']
        assert new['insertion_time']==old['end_time'] and new['silence_duration']==8
        assert new['dvi_text']==old['dvi_text'] and new['frame_timestamps']==old['frame_timestamps']
        assert new['evidence_description']==old['evidence_description']
        assert not new['description_requires_shortening'] and 'skip_reason' not in new

@pytest.mark.parametrize('fault',['refusal','invalid_evidence'])
def test_unvalidated_response_is_not_length_recovery(natural_gap_video,tmp_path,monkeypatch,fault):
    source,calls,_=natural_gap_video
    def fail(*args,**kwargs):
        calls['model']+=1
        data={'choices':[{'finish_reason':'content_filter','message':{'refusal':'Declined'}}]} if fault=='refusal' else completion(SECOND,invalid=True)
        return httpx.Response(200,json=data)
    monkeypatch.setattr(pipeline,'_request',fail)
    with pytest.raises(pipeline.PipelineError) as error:
        pipeline.process_video(source,tmp_path/fault,settings(),2,lambda *args:None)
    assert not isinstance(error.value,pipeline.DescriptionWindowTooShort)
    assert calls=={'speech':1,'model':1,'tts':0,'frames':1}
    assert not (tmp_path/fault/'result.json').exists()
