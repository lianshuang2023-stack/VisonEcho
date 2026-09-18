"""Rewrite and time-aware narration contracts use mock models and temp assets."""
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path

import httpx
import pytest
from fastapi import BackgroundTasks
from fastapi.testclient import TestClient
from local_backend import main, rewrite
from local_backend.config import Settings
from local_backend.hosted import PAID_ROUTE
from local_backend.pipeline import PipelineError, _generate_description, timed_character_context


def config(tmp_path):
    return Settings(data_dir=tmp_path, azure_openai_endpoint='https://example.openai.azure.com/openai/v1',
                    azure_openai_api_key='test-secret', azure_speech_key='test-secret', azure_speech_region='eastus')


def role():
    return {'id':'person', 'preferred_name':'Alex', 'appearance':'Blue jacket', 'aliases':['Mr Smith'],
            'before_name':'the visitor', 'name_available_from':10}


def complete(text='The visitor sits.', indices=None):
    return {'choices':[{'finish_reason':'stop','message':{'content':json.dumps({'text':text,
        'observations':[{'fact':'Blue jacket at a chair.', 'frame_indices':[0] if indices is None else indices}]})}}]}


def test_timed_names_use_source_start_and_do_not_leak_aliases():
    cards, hidden = timed_character_context([role()], 9.99)
    assert cards[0]['preferred_name'] == 'the visitor' and cards[0]['aliases'] == []
    assert hidden == ['Alex', 'Mr Smith']
    assert 'Alex' not in json.dumps(cards) and 'Smith' not in json.dumps(cards)
    cards, hidden = timed_character_context([role()], 10)
    assert cards[0]['preferred_name'] == 'Alex' and not hidden
    cards, hidden = timed_character_context([{k:v for k,v in role().items() if k not in ('name_available_from','before_name')}], 0)
    assert cards[0]['preferred_name'] == 'Alex' and not hidden


@pytest.mark.parametrize('style', ['concise','cinematic'])
def test_generation_style_and_timed_name_validation(tmp_path, style):
    frame=tmp_path/'frame.jpg'; frame.write_bytes(b'fixture')
    settings=replace(config(tmp_path), narration_style=style, character_context=[role()])
    messages=[]
    def reply(request):
        messages.append(json.loads(request.content)['messages'])
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({
            'description':'Alex sits.', 'observations':[{'fact':'A seated figure.', 'frame_indices':[0]}]})}}]})
    with httpx.Client(transport=httpx.MockTransport(reply)) as client, pytest.raises(PipelineError,match='before its allowed time'):
        _generate_description({'segment_index':0,'start_time':20,'end_time':25,'silence_duration':5,'source_start':4,'source_end':9},
            [{'path':frame,'timestamp':5}],{'phrases':[{'start':4,'end':5,'text':'Alex is here.'}]},['Mr Smith arrives.'],settings,client)
    assert len(messages)==1
    body=json.loads(messages[0][1]['content'][0]['text'])
    assert body['narration_style']==style
    assert body['confirmed_character_cards'][0]['preferred_name']=='the visitor'
    assert 'Alex' not in json.dumps(body) and 'Mr Smith' not in json.dumps(body)
    assert ('factual descriptions of visible light' in messages[0][0]['content']) == (style=='cinematic')


@pytest.fixture
def workspace(tmp_path):
    settings=config(tmp_path/'data'); app=main.create_app(settings); store=app.state.store
    directory=store.root/'runs'/'job'; (directory/'frames').mkdir(parents=True)
    (directory/'frames'/'segment-000-0.jpg').write_bytes(b'fixture')
    transcript=directory/'transcript.json'
    transcript.write_text(json.dumps({'phrases':[{'start':2,'end':3,'text':'Already heard.'},
                                                {'start':5,'end':6,'text':'Future dialogue.'}]}))
    store.data['inputs']['video']={'filename':'video.mp4','duration':20}
    store.data['executions']['job']={'execution_arn':'job','video_id':'video','status':'SUCCEEDED',
        'result':{'language':'en-US','transcript_path':str(transcript),'segments':[{
            'segment_index':0,'start_time':4,'end_time':9,'silence_duration':5,'dvi_text':'The visitor walks toward the chair and sits.',
            'frame_timestamps':[5]}]}}
    store.save()
    with TestClient(app) as client:
        yield client,store,settings


def test_rewrite_uses_saved_frames_and_only_prior_dialogue_without_saving(workspace,monkeypatch):
    client,store,settings=workspace
    original=deepcopy(store.data); disk=(store.root/'index.json').read_bytes()
    calls=[]
    def respond(active,service,settings,url,**kwargs):
        calls.append(kwargs)
        assert store.busy.locked()
        return httpx.Response(200,json=complete())
    monkeypatch.setattr(rewrite,'_request',respond)
    response=client.post('/api/videos/job/segments/0/rewrite',json={'action':'shorten','text':'The visitor walks toward the chair and sits.'})
    assert response.status_code==200,response.text
    assert response.json()=={'text':'The visitor sits.'}
    assert len(calls)==1 and calls[0]['timeout'].read==60
    content=calls[0]['json']['messages'][1]['content']
    assert content[1]['image_url']['url'].startswith('data:image/jpeg;base64,')
    body=json.loads(content[0]['text'])
    assert [p['text'] for p in body['earlier_dialogue_context_only']]==['Already heard.']
    assert body['available_seconds']==5
    assert store.data==original and (store.root/'index.json').read_bytes()==disk
    assert not store.busy.locked()


@pytest.mark.parametrize('fault', ['missing_evidence','overbudget','early_name','refusal'])
def test_invalid_model_rewrites_fail_without_retry_and_keep_draft(workspace,monkeypatch,fault):
    client,store,_=workspace
    store.data['inputs']['video']['character_cards']={'revision':1,'characters':[
        {**role(),'status':'confirmed','thumbnail':None,'occurrences':[]}]}
    calls=[]
    def respond(*args,**kwargs):
        calls.append(1)
        if fault=='refusal':
            return httpx.Response(200,json={'choices':[{'finish_reason':'content_filter','message':{'refusal':'No'}}]})
        return httpx.Response(200,json=complete('Alex sits.' if fault=='early_name' else
            'A visitor walks across the entire room toward a far chair and sits.' if fault=='overbudget' else
            'The visitor sits.', [9] if fault=='missing_evidence' else None))
    monkeypatch.setattr(rewrite,'_request',respond)
    before=deepcopy(store.data)
    response=client.post('/api/videos/job/segments/0/rewrite',json={'action':'objective','text':'The visitor sits.'})
    assert response.status_code==502 and len(calls)==1
    assert store.data==before and not store.busy.locked()


@pytest.mark.parametrize('change,code', [('archived',409),('deleted',404),('busy',409),('wrong_revision',409),('bad_action',422)])
def test_rewrite_lifecycle_revision_and_action_fail_before_cloud(workspace,monkeypatch,change,code):
    client,store,_=workspace
    monkeypatch.setattr(rewrite,'rewrite_suggestion',lambda *args:pytest.fail('Unexpected model call'))
    payload={'action':'objective','text':'The visitor sits.'}
    if change=='busy': store.busy.acquire()
    elif change=='wrong_revision': payload['revision']=3
    elif change=='bad_action': payload['action']='invent-story'
    else: store.data['inputs']['video'][change]=True
    try:
        assert client.post('/api/videos/job/segments/0/rewrite',json=payload).status_code==code
    finally:
        if change=='busy': store.busy.release()


def test_style_is_snapshotted_and_revoice_inherits_it(tmp_path):
    store=main.Store(config(tmp_path)); store.data['inputs']['video']={'filename':'video.mp4'}
    created=main.enqueue_job(store,BackgroundTasks(),'video',narration_style='cinematic')
    assert store.data['executions'][created['execution_arn']]['narration_style']=='cinematic'
    store.busy.release()
    created=main.enqueue_job(store,BackgroundTasks(),'video',source_result={'narration_style':'cinematic'})
    assert store.data['executions'][created['execution_arn']]['narration_style']=='cinematic'
    store.busy.release()
    assert PAID_ROUTE.fullmatch('/api/videos/job/segments/0/rewrite')
    assert PAID_ROUTE.fullmatch('/api/videos/job/segments/0/rewrite/')


def test_hosted_rewrite_attempt_consumes_trial_but_preflight_errors_do_not(tmp_path, monkeypatch):
    from local_backend.hosted import create_hosted_app
    settings = replace(config(tmp_path/'private'), public_origin='https://testserver', hosted_data_dir=tmp_path/'hosted')
    app = create_hosted_app(settings)
    with TestClient(app, base_url='https://testserver', headers={'Origin':'https://testserver'}) as client:
        client.post('/api/access/guest',json={})
        principal = app.state.workspaces.auth.resolve(client.cookies.get('visionecho_session'))
        store = app.state.workspaces.application(principal).state.store
        store.data['inputs']['video']={'filename':'video.mp4','duration':20}
        store.data['executions']['job']={'video_id':'video','status':'SUCCEEDED','result':{'segments':[
            {'segment_index':0,'start_time':4,'end_time':9,'silence_duration':5}]}}
        monkeypatch.setattr(rewrite, '_resolve_evidence', lambda *args: ({'source_start':4,'source_end':9}, {}))
        def declined(*args):
            raise rewrite.RewriteModelError('Model declined the rewrite.')
        monkeypatch.setattr(rewrite,'rewrite_suggestion',declined)
        assert client.post('/api/videos/job/segments/0/rewrite',json={'action':'objective','text':''}).status_code==422
        assert client.get('/api/access/session').json()['limits']['guest_generations_remaining']==5
        for index in range(5):
            response=client.post('/api/videos/job/segments/+0/rewrite',json={'action':'objective','text':'Original text.'})
            assert response.status_code==502
            assert 'x-visionecho-paid-operation' not in response.headers
            assert client.get('/api/access/session').json()['limits']['guest_generations_remaining']==4-index
        assert client.post('/api/videos/job/segments/0/rewrite',json={'action':'objective','text':'Original text.'}).status_code==403


@pytest.mark.parametrize('value', ['10', True, -1, 21])
def test_character_reveal_time_is_strict_and_within_source_duration(workspace, value):
    client,store,_=workspace
    card={**role(),'id':'','status':'confirmed','thumbnail':None,'occurrences':[], 'name_available_from':value}
    assert client.put('/api/projects/video/characters',json={'revision':0,'characters':[card]}).status_code==422
    assert 'character_cards' not in store.data['inputs']['video']


def test_character_reveal_fields_roundtrip(workspace):
    client,_,_=workspace
    response=client.put('/api/projects/video/characters',json={'revision':0,'characters':[
        {**role(),'id':'','status':'confirmed','thumbnail':None,'occurrences':[]} ]})
    assert response.status_code==200,response.text
    assert response.json()['characters'][0]['before_name']=='the visitor'
    assert response.json()['characters'][0]['name_available_from']==10
    assert client.put('/api/projects/video/characters',json=response.json()).status_code==200


def test_recognized_role_evidence_and_appearance_cannot_leak_later_name(tmp_path):
    frame=tmp_path/'image.jpg'; frame.write_bytes(b'fixture')
    settings=replace(config(tmp_path),character_context=[role()])
    settings.detected_fictional_roles=[
        {'name':'Visitor','visual_evidence':'Alex wears a blue jacket.','appearance':'Blue jacket','segment_indices':[0]},
        {'name':'Visitor','visual_evidence':'A distinctive emblem.','appearance':'Mr Smith in blue','segment_indices':[0]},
    ]
    captured=[]
    def respond(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({
            'description':'The visitor sits.','observations':[{'fact':'A seated visitor.','frame_indices':[0]}]})}}]})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        _generate_description({'segment_index':0,'start_time':4,'end_time':9,'silence_duration':5},
            [{'path':frame,'timestamp':5}],{'phrases':[]},[],settings,client)
    assert 'Alex' not in json.dumps(captured) and 'Mr Smith' not in json.dumps(captured)
    assert json.loads(captured[0]['messages'][1]['content'][0]['text'])['current_interval_fictional_roles']==[]


@pytest.mark.parametrize('action', ['objective','atmosphere'])
def test_rewrite_actions_use_visual_claims_and_validate_actual_schema(tmp_path,action):
    frame=tmp_path/'frame.jpg';frame.write_bytes(b'fixture')
    captures=[]
    def respond(request):
        captures.append(json.loads(request.content))
        return httpx.Response(200,json=complete('The visitor sits.'))
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        result=rewrite.rewrite_suggestion(rewrite.RewriteRequest(action=action,text='Alex feels sad by the window.'),
            {'start_time':4,'end_time':9,'silence_duration':5},
            {'source_start':4,'source_end':9,'frames':[{'id':'f0','timestamp':5}]},
            {'f0':frame},[{'text':'Mr Smith is here.','start':2,'end':3}], [role()],config(tmp_path),client)
    assert result=={'text':'The visitor sits.'} and len(captures)==1
    message=json.dumps(captures[0]['messages'])
    assert 'Alex' not in message and 'Mr Smith' not in message
    assert ('visible light' in message)==(action=='atmosphere')


def test_extended_rewrite_does_not_compare_output_transcript_with_source_time(workspace):
    _,store,_=workspace
    store.data['executions']['job']['result']['narration_mode']='extended'
    assert rewrite._dialogue(store,'job',4)==[]
    result=store.data['executions']['job']['result']
    result['source_transcript_path']=result['transcript_path']
    assert rewrite._dialogue(store,'job',4)==[{'text':'Already heard.','start':2,'end':3}]


def test_matched_role_cannot_bypass_reveal_time_with_a_translated_name(tmp_path):
    from local_backend.pipeline import _fictional_role_context
    frame=tmp_path/'image.jpg';frame.write_bytes(b'fixture')
    cfg=replace(config(tmp_path),character_context=[role()])
    cfg.detected_fictional_roles=_fictional_role_context([{
        'existing_id':'person','appearance':'Blue jacket','occurrences':[{'segment_index':0}],
        'recognition':{'kind':'fictional','confidence':'high','name':'另一个译名','evidence':'Blue uniform emblem.'}}])
    captured=[]
    def respond(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({
            'description':'The visitor sits.','observations':[{'fact':'Seated visitor.','frame_indices':[0]}]})}}]})
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        _generate_description({'segment_index':0,'start_time':4,'end_time':9,'silence_duration':5},
            [{'path':frame,'timestamp':5}],{'phrases':[]},[],cfg,client)
    assert json.loads(captured[0]['messages'][1]['content'][0]['text'])['current_interval_fictional_roles']==[]
