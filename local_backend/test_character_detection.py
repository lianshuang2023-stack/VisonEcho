"""No-cloud regressions for visual character proposals and async persistence."""
from copy import deepcopy
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest

from local_backend import character_detection as detection
from local_backend.characters import register_character_routes
from local_backend.config import Settings
from local_backend.evidence import register_evidence_routes
from local_backend.lifecycle import video_running
from local_backend.main import Store
from local_backend.pipeline import PipelineError

_REAL_ANALYZER = detection.analyze_character_frames


def frames(tmp_path, segments=2, per_segment=3):
    result = []
    for segment in range(segments):
        for ordinal in range(per_segment):
            path = tmp_path / f'{segment}-{ordinal}.jpg'
            path.write_bytes(b'synthetic-image')
            result.append({'path': path, 'job_id': 'job', 'segment_index': segment,
                           'frame_id': f'f{ordinal}', 'timestamp': segment * 4 + ordinal / 2})
    return result


def candidate(appearance='Blue jacket and short hair.', index=0, existing_id=None):
    return {'appearance': appearance, 'existing_id': existing_id,
            'thumbnail': {'job_id': 'job', 'segment_index': index, 'frame_id': 'f0'},
            'occurrences': [{'job_id': 'job', 'segment_index': index}]}


def card(identifier='known', name='Human chosen name', **overrides):
    result = {'id': identifier, 'appearance': 'Blue jacket and short hair.', 'preferred_name': name,
              'status': 'confirmed', 'aliases': ['Previous human name'],
              'thumbnail': {'job_id': 'job', 'segment_index': 0, 'frame_id': 'f0'},
              'occurrences': [{'job_id': 'job', 'segment_index': 0}]}
    result.update(overrides)
    return result


def model_response(characters, **overrides):
    result = {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps({'characters': characters})}}],
              'usage': {'prompt_tokens': 80, 'completion_tokens': 20, 'total_tokens': 100}}
    result.update(overrides)
    return result


def recognition(**overrides):
    return {'kind': 'fictional', 'name': '蜘蛛侠', 'confidence': 'high',
            'evidence': '红蓝网纹制服，胸前蜘蛛标志和白色面罩眼片。', **overrides}


def fake_client(body, status=200):
    requests = []
    def handle(request):
        requests.append(json.loads(request.content))
        return httpx.Response(status, json=body)
    return httpx.Client(transport=httpx.MockTransport(handle)), requests


def settings(tmp_path):
    return Settings(data_dir=tmp_path, azure_openai_endpoint='https://test.openai.azure.com/openai/v1',
                    azure_openai_api_key='test-secret-key', speech_language='zh-CN')


def test_selection_covers_entire_video_with_frame_and_segment_budgets(tmp_path):
    source = frames(tmp_path, 30, 8)
    chosen = detection.select_character_frames(source)
    assert len(chosen) == 24
    assert len({frame['segment_index'] for frame in chosen}) == 12
    assert chosen[0]['segment_index'] == 0 and chosen[-1]['segment_index'] == 29
    assert chosen == detection.select_character_frames(list(reversed(source)))
    assert len(detection.select_character_frames(source + source)) == 24


def test_empty_analyzer_has_no_request_or_usage(tmp_path):
    client, requests = fake_client({})
    result = detection.analyze_character_frames([], [], settings(tmp_path), client)
    assert not result['candidates'] and result['usage']['openai_requests'] == 0
    assert result['coverage'] == {'frame_count': 0, 'segment_count': 0}
    assert requests == []


def test_one_visual_request_returns_unconfirmed_references_and_no_names(tmp_path):
    source = frames(tmp_path)
    client, requests = fake_client(model_response([
        {'appearance': '  蓝色夹克，短发  ', 'frame_indices': [0, 3], 'existing_id': None}]))
    result = detection.analyze_character_frames(source, [card()], settings(tmp_path), client)
    assert [{key: value for key, value in item.items() if key != 'detection_key'} for item in result['candidates']] == [{
        'appearance': '蓝色夹克，短发', 'existing_id': None,
        'thumbnail': {'job_id': 'job', 'segment_index': 0, 'frame_id': 'f0'},
        'occurrences': [{'job_id': 'job', 'segment_index': 0}, {'job_id': 'job', 'segment_index': 1}]}]
    assert result['usage']['openai_requests'] == 1 and result['usage']['total_tokens'] == 100
    assert result['coverage'] == {'frame_count': 6, 'segment_count': 2}
    assert len(requests) == 1
    request_text = json.dumps(requests[0])
    assert 'Human chosen name' not in request_text and 'Previous human name' not in request_text
    assert 'Never identify a real person' in requests[0]['messages'][0]['content']
    assert str(tmp_path) not in request_text
    assert 'preferred_name' not in result['candidates'][0]
    assert len(result['candidates'][0]['detection_key']) == 64


def test_existing_identity_requires_a_visible_thumbnail_anchor(tmp_path):
    source = frames(tmp_path)
    client, _ = fake_client(model_response([
        {'appearance': 'Blue coat.', 'frame_indices': [0, 3], 'existing_id': 'known'}]))
    assert detection.analyze_character_frames(source, [card()], settings(tmp_path), client)['candidates'][0]['existing_id'] == 'known'
    client, _ = fake_client(model_response([
        {'appearance': 'Blue coat.', 'frame_indices': [3], 'existing_id': 'known'}]))
    assert detection.analyze_character_frames(source, [card()], settings(tmp_path), client)['candidates'][0]['existing_id'] is None
    client, _ = fake_client(model_response([
        {'appearance': 'Blue coat.', 'frame_indices': [3], 'existing_id': 'known'}]))
    with pytest.raises(PipelineError, match='invalid character references'):
        detection.analyze_character_frames(source, [card(thumbnail=None)], settings(tmp_path), client)


@pytest.mark.parametrize('item', [
    {'appearance': '', 'frame_indices': [0], 'existing_id': None},
    {'appearance': 'Visible.', 'frame_indices': [99], 'existing_id': None},
    {'appearance': 'Visible.', 'frame_indices': [-1], 'existing_id': None},
    {'appearance': 'Visible.', 'frame_indices': [True], 'existing_id': None},
    {'appearance': 'Visible.', 'frame_indices': [], 'existing_id': None},
    {'appearance': 'Visible.', 'frame_indices': [0], 'existing_id': 'invented'},
    {'appearance': 'Visible.', 'frame_indices': [0], 'existing_id': None, 'name': 'Guessed'},
    {'appearance': 'Visible.', 'frame_indices': [0], 'existing_id': None, 'path': '/private/file'},
])
def test_invalid_model_candidates_fail_without_retry(tmp_path, item):
    client, requests = fake_client(model_response([item]))
    with pytest.raises(PipelineError):
        detection.analyze_character_frames(frames(tmp_path), [], settings(tmp_path), client)
    assert len(requests) == 1


@pytest.mark.parametrize('status', [400, 403, 429, 500])
def test_http_failures_and_quota_have_one_request_and_redacted_errors(tmp_path, status):
    client, requests = fake_client({'error': {'message': 'test-secret-key failed'}}, status)
    with pytest.raises(PipelineError) as error:
        detection.analyze_character_frames(frames(tmp_path), [], settings(tmp_path), client)
    assert 'test-secret-key' not in str(error.value)
    assert len(requests) == 1


@pytest.mark.parametrize('choice', [
    {'finish_reason': 'content_filter', 'message': {'content': ''}},
    {'finish_reason': 'stop', 'message': {'refusal': 'Cannot process', 'content': ''}},
    {'finish_reason': 'length', 'message': {'content': ''}},
])
def test_refused_or_truncated_responses_never_retry(tmp_path, choice):
    client, requests = fake_client({'choices': [choice]})
    with pytest.raises(PipelineError):
        detection.analyze_character_frames(frames(tmp_path), [], settings(tmp_path), client)
    assert len(requests) == 1


def test_merge_preserves_human_fields_and_is_idempotent():
    original = card()
    source = {'character_cards': {'revision': 3, 'characters': [deepcopy(original)]}}
    matched = candidate('Model changed appearance', 1, 'known')
    result = detection.merge_detected_characters(source, [matched, candidate()], 3)
    assert result == {'added_count': 1, 'updated_count': 1, 'revision': 4, 'candidate_count': 2, 'skipped_count': 0}
    existing, new = source['character_cards']['characters']
    for key in ('id', 'appearance', 'preferred_name', 'status', 'aliases', 'thumbnail'):
        assert existing[key] == original[key]
    assert len(existing['occurrences']) == 2
    assert new['status'] == 'unconfirmed' and new['preferred_name'] == '' and new['aliases'] == []
    before = deepcopy(source)
    assert detection.merge_detected_characters(source, [matched, candidate()], 4) == {
        'added_count': 0, 'updated_count': 0, 'revision': 4, 'candidate_count': 2, 'skipped_count': 0}
    assert source == before
    with pytest.raises(HTTPException) as conflict:
        detection.merge_detected_characters(source, [candidate(index=3)], 3)
    assert conflict.value.status_code == 409 and source == before


def test_merge_empty_cap_and_invalid_batch_do_not_partially_mutate():
    source = {'character_cards': {'revision': 1, 'characters': [card(str(index)) for index in range(40)]}}
    before = deepcopy(source)
    capped = detection.merge_detected_characters(source, [candidate()])
    assert capped['added_count'] == 0 and capped['skipped_count'] == 1
    assert source == before
    source = {}
    assert detection.merge_detected_characters(source, []) == {
        'added_count': 0, 'updated_count': 0, 'revision': 0, 'candidate_count': 0, 'skipped_count': 0}
    assert source == {}


def test_same_visual_proposal_across_versions_keeps_id_without_name_inference(tmp_path):
    source_frames = frames(tmp_path)
    payload = model_response([{'appearance': 'Blue jacket, at left.', 'frame_indices': [0, 1], 'existing_id': None}])
    client, _ = fake_client(payload)
    first = detection.analyze_character_frames(source_frames, [], settings(tmp_path), client)['candidates']
    source = {}
    detection.merge_detected_characters(source, first)
    identifier = source['character_cards']['characters'][0]['id']
    source['character_cards']['characters'][0].update(preferred_name='User label', status='confirmed')
    rerender_frames = [{**frame, 'job_id': 'rerender'} for frame in source_frames]
    client, _ = fake_client(payload)
    second = detection.analyze_character_frames(rerender_frames, [], settings(tmp_path), client)['candidates']
    assert second[0]['detection_key'] == first[0]['detection_key']
    merged = detection.merge_detected_characters(source, second)
    assert merged['added_count'] == 0 and merged['updated_count'] == 1
    saved = source['character_cards']['characters'][0]
    assert saved['id'] == identifier and saved['preferred_name'] == 'User label'
    assert {'job_id': 'rerender', 'segment_index': 0} in saved['occurrences']
    client, _ = fake_client(model_response([{'appearance': 'Blue jacket, at right.', 'frame_indices': [0, 1], 'existing_id': None}]))
    different = detection.analyze_character_frames(source_frames, [], settings(tmp_path), client)['candidates']
    assert different[0]['detection_key'] != first[0]['detection_key']
    before = deepcopy(source)
    with pytest.raises(HTTPException):
        detection.merge_detected_characters(source, [candidate(), {'appearance': 'malformed'}])
    assert source == before


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    config = settings(tmp_path)
    store = Store(config)
    store.data['collections'] = {'default': {'id': 'default'}}
    store.data['inputs']['video'] = {'filename': 'source.mp4', 'duration': 10, 'collection_id': 'default'}
    store.data['executions']['job'] = {'video_id': 'video', 'status': 'SUCCEEDED', 'result': {'segments': [
        {'segment_index': 0, 'start_time': 1, 'end_time': 3, 'frame_timestamps': [1.5, 2]}]}}
    directory = tmp_path / 'runs/job/frames'
    directory.mkdir(parents=True)
    for index in range(2):
        (directory / f'segment-000-{index}.jpg').write_bytes(b'cached-frame')
    store.save()
    calls = []
    def analyze(frames, cards, settings):
        calls.append((frames, deepcopy(cards), settings.speech_language))
        assert store.busy.locked()
        return {'candidates': [candidate()], 'usage': {'openai_requests': 1},
                'coverage': {'frame_count': len(frames), 'segment_count': 1}}
    monkeypatch.setattr(detection, 'analyze_character_frames', analyze)
    app = FastAPI()
    register_evidence_routes(app, store, config)
    register_character_routes(app, store, config)
    detection.register_character_detection_routes(app, store, config)
    with TestClient(app) as client:
        yield client, store, config, calls


def start(client, revision=0):
    return client.post('/api/videos/job/characters/detect', json={'revision': revision, 'language': 'zh-CN'})


def status(client, started):
    return client.get('/api/character-detections/' + started.json()['detection_id'])


def test_async_detection_safe_evidence_resolution_latest_and_restart(workspace):
    client, store, config, calls = workspace
    assert client.get('/api/projects/video/characters/detection/latest').json() is None
    response = start(client)
    assert response.status_code == 200 and response.json()['status'] == 'RUNNING'
    task = status(client, response).json()
    assert task['status'] == 'SUCCEEDED' and task['added_count'] == 1 and task['revision'] == 1
    assert task['coverage'] == {'frame_count': 2, 'segment_count': 1}
    assert client.get('/api/projects/video/characters/detection/latest').json() == task
    assert str(store.root) not in json.dumps(task)
    assert calls[0][0][0]['path'].name == 'segment-000-0.jpg'
    assert calls[0][2] == 'zh-CN'
    assert client.get('/api/projects/video/characters').json()['characters'][0]['status'] == 'unconfirmed'
    assert not store.busy.locked()
    saved = Store(config)
    assert saved.data['inputs']['video']['character_cards']['revision'] == 1


def test_detection_revision_change_discards_all_candidates(workspace, monkeypatch):
    client, store, _, _ = workspace
    original = detection.analyze_character_frames
    def competing(*args):
        result = original(*args)
        store.data['inputs']['video']['character_cards'] = {'revision': 1, 'characters': [card()]}
        return result
    monkeypatch.setattr(detection, 'analyze_character_frames', competing)
    response = start(client)
    task = status(client, response).json()
    assert task['status'] == 'FAILED' and task['error_code'] == 409
    assert store.data['inputs']['video']['character_cards'] == {'revision': 1, 'characters': [card()]}
    assert not store.busy.locked()


@pytest.mark.parametrize('condition,code', [('archived', 409), ('deleted', 404), ('collection_deleted', 404),
                                          ('version_deleted', 404), ('busy', 409), ('wrong_revision', 409)])
def test_start_lifecycle_and_conflict_guards_do_not_analyze(workspace, condition, code):
    client, store, _, calls = workspace
    if condition == 'collection_deleted':
        store.data['collections']['default']['deleted'] = True
    elif condition == 'version_deleted':
        store.data['executions']['job']['deleted'] = True
    elif condition == 'busy':
        store.busy.acquire()
    elif condition not in ('wrong_revision',):
        store.data['inputs']['video'][condition] = True
    assert start(client, 1 if condition == 'wrong_revision' else 0).status_code == code
    assert calls == [] and store.data['character_detections'] == {}
    if condition == 'busy':
        store.busy.release()


def test_detector_failure_is_visible_redacted_and_releases_busy(workspace, monkeypatch):
    client, store, _, _ = workspace
    def fail(*args):
        raise PipelineError('test-secret-key rejected')
    monkeypatch.setattr(detection, 'analyze_character_frames', fail)
    response = start(client)
    task = status(client, response).json()
    assert task['status'] == 'FAILED' and 'test-secret-key' not in task['error']
    assert 'character_cards' not in store.data['inputs']['video']
    assert not store.busy.locked()


def test_missing_segments_fail_actionably_without_cloud(workspace):
    client, store, _, calls = workspace
    store.data['executions']['job']['result']['segments'] = []
    response = start(client)
    task = status(client, response).json()
    assert task['status'] == 'FAILED' and task['error_code'] == 409
    assert calls == []


def test_task_visibility_and_running_guard_follow_video_lifecycle(workspace):
    client, store, _, _ = workspace
    response = start(client)
    task_id = response.json()['detection_id']
    store.data['character_detections'][task_id]['status'] = 'RUNNING'
    assert video_running(store.data, 'video')
    store.data['collections']['default']['deleted_at'] = 'now'
    assert status(client, response).status_code == 404
    assert client.get('/api/projects/video/characters/detection/latest').status_code == 404


def test_start_save_failure_has_no_task_and_releases_lock(workspace, monkeypatch):
    client, store, _, calls = workspace
    monkeypatch.setattr(store, 'save', lambda: (_ for _ in ()).throw(OSError('disk full')))
    assert start(client).status_code == 500
    assert not store.busy.locked() and store.data['character_detections'] == {}
    assert calls == []


def test_result_save_failure_rolls_back_cards_and_marks_failed(workspace, monkeypatch):
    client, store, _, _ = workspace
    original_save, count = store.save, 0
    def fail_result():
        nonlocal count
        count += 1
        if count == 2:
            raise OSError('disk full')
        original_save()
    monkeypatch.setattr(store, 'save', fail_result)
    response = start(client)
    assert status(client, response).json()['status'] == 'FAILED'
    assert 'character_cards' not in store.data['inputs']['video']
    assert not store.busy.locked()
    assert 'character_cards' not in json.loads((store.root / 'index.json').read_text())['inputs']['video']


def test_restart_recovers_interrupted_task_without_running_recognition(workspace):
    _, store, config, calls = workspace
    store.data['character_detections']['interrupted'] = {
        'detection_id': 'interrupted', 'job_id': 'job', 'video_id': 'video', 'status': 'RUNNING'}
    store.save()
    detection.register_character_detection_routes(FastAPI(), store, config)
    task = store.data['character_detections']['interrupted']
    assert task['status'] == 'FAILED' and task['error_code'] == 409
    assert calls == []


def test_cross_version_anchor_matches_across_languages_without_changing_card(workspace, monkeypatch):
    client, store, config, _ = workspace
    # The fixture stubs analysis for task tests; restore the actual pure request
    # adapter here using the saved function captured before monkeypatching.
    analyzer = _REAL_ANALYZER
    original = card(appearance='Blue jacket, at left.')
    store.data['inputs']['video']['character_cards'] = {'revision': 1, 'characters': [deepcopy(original)]}
    enriched = detection.enrich_character_references(store, [original], config, 'video')
    assert 'reference_image' not in original
    assert len(enriched[0]['reference_image']['sha256']) == 64
    path = store.root / 'runs/job/frames/segment-000-0.jpg'
    new_frames = [{'path': path, 'job_id': 'chinese-version', 'segment_index': 0, 'frame_id': 'f0', 'timestamp': 1.5}]
    http, requests = fake_client(model_response([{'appearance': '左侧蓝色夹克人物。', 'frame_indices': [0], 'existing_id': 'known'}]))
    result = analyzer(new_frames, enriched, config, http)
    assert result['candidates'][0]['existing_id'] == 'known'
    merged = detection.merge_detected_characters(store.data['inputs']['video'], result['candidates'], 1)
    assert merged['added_count'] == 0 and merged['updated_count'] == 1
    assert store.data['inputs']['video']['character_cards']['characters'][0]['appearance'] == original['appearance']
    assert 'reference_image' not in json.dumps(store.data['inputs']['video']['character_cards'])
    sent_text = requests[0]['messages'][1]['content'][0]['text']
    assert 'known' in sent_text and 'Human chosen name' not in sent_text
    assert enriched[0]['reference_image']['sha256'] not in sent_text


def test_cross_version_different_pixels_or_time_cannot_offer_existing_identity(workspace):
    _, store, config, _ = workspace
    enriched = detection.enrich_character_references(store, [card()], config, 'video')
    path = store.root / 'changed.jpg'
    path.write_bytes(b'a different frame')
    for frame in [
        {'path': path, 'job_id': 'later', 'segment_index': 0, 'frame_id': 'f0', 'timestamp': 1.5},
        {'path': store.root / 'runs/job/frames/segment-000-0.jpg', 'job_id': 'later', 'segment_index': 0, 'frame_id': 'f0', 'timestamp': 4.5},
    ]:
        http, requests = fake_client(model_response([{'appearance': 'Blue jacket.', 'frame_indices': [0], 'existing_id': 'known'}]))
        with pytest.raises(PipelineError):
            _REAL_ANALYZER([frame], enriched, config, http)
        assert json.loads(requests[0]['messages'][1]['content'][0]['text'])['existing_visual_cards'] == []


def test_enrichment_drops_untrusted_stale_or_cross_video_anchors(workspace):
    _, store, config, _ = workspace
    forged = card(reference_image={'sha256': 'a' * 64, 'timestamp': 1.5})
    assert 'reference_image' not in detection.enrich_character_references(store, [forged], config, 'other')[0]
    store.data['executions']['job']['deleted_at'] = 'now'
    assert 'reference_image' not in detection.enrich_character_references(store, [forged], config, 'video')[0]
    store.data['executions']['job'].pop('deleted_at')
    (store.root / 'runs/job/frames/segment-000-0.jpg').unlink()
    assert 'reference_image' not in detection.enrich_character_references(store, [forged], config, 'video')[0]


def test_distinctive_fictional_design_can_create_an_immediately_named_card(tmp_path):
    http, requests = fake_client(model_response([{'appearance': '红蓝制服和网纹面罩。', 'frame_indices': [0, 1],
                                                'existing_id': None, 'recognition': recognition()}]))
    result = detection.analyze_character_frames(frames(tmp_path), [], settings(tmp_path), http)
    assert result['candidates'][0]['recognition'] == recognition()
    source = {}
    detection.merge_detected_characters(source, result['candidates'])
    saved = source['character_cards']['characters'][0]
    assert saved['status'] == 'recognized' and saved['preferred_name'] == '蜘蛛侠'
    assert saved['recognition'] == recognition()
    prompt = requests[0]['messages'][0]['content']
    assert 'Spider-Man' in prompt and 'Never name actors' in prompt


@pytest.mark.parametrize('confidence', ['medium', 'low'])
def test_uncertain_fictional_label_never_becomes_an_applied_name(confidence):
    source = {}
    detected = candidate()
    detected['recognition'] = recognition(confidence=confidence)
    detection.merge_detected_characters(source, [detected])
    saved = source['character_cards']['characters'][0]
    assert saved['status'] == 'unconfirmed' and saved['preferred_name'] == ''
    assert saved.get('recognition') is None


@pytest.mark.parametrize('bad', [
    {'kind': 'real_person'}, {'name': ''}, {'evidence': ''}, {'evidence': ' '},
    {'confidence': 'certain'}, {'name': 'x' * 101}, {'extra': 'unsupported'},
])
def test_invalid_or_real_person_recognition_is_rejected_without_retry(tmp_path, bad):
    http, requests = fake_client(model_response([{'appearance': 'Costumed character.', 'frame_indices': [0],
                                                'existing_id': None, 'recognition': recognition(**bad)}]))
    with pytest.raises(PipelineError):
        detection.analyze_character_frames(frames(tmp_path), [], settings(tmp_path), http)
    assert len(requests) == 1


def test_recognition_fills_existing_blank_but_preserves_all_manual_names():
    for status, name in [('unconfirmed', ''), ('unconfirmed', 'My description'), ('confirmed', 'Hero')]:
        original = card(status=status, name=name)
        source = {'character_cards': {'revision': 1, 'characters': [deepcopy(original)]}}
        proposal = candidate(existing_id='known')
        proposal['recognition'] = recognition()
        merged = detection.merge_detected_characters(source, [proposal], 1)
        saved = source['character_cards']['characters'][0]
        if not name:
            assert saved['status'] == 'recognized' and saved['preferred_name'] == '蜘蛛侠'
            assert merged['updated_count'] == 1
        else:
            assert saved == original and merged['updated_count'] == 0


def test_same_card_can_update_automatic_fictional_label_without_changing_manual_appearance():
    original = card(status='recognized', name='Spider-Man', recognition=recognition(name='Spider-Man'))
    source = {'character_cards': {'revision': 1, 'characters': [deepcopy(original)]}}
    proposal = candidate('Model appearance changed', existing_id='known')
    proposal['recognition'] = recognition()
    assert detection.merge_detected_characters(source, [proposal], 1)['updated_count'] == 1
    saved = source['character_cards']['characters'][0]
    assert saved['preferred_name'] == '蜘蛛侠' and saved['appearance'] == original['appearance']
    assert saved['aliases'] == original['aliases'] + ['Spider-Man']


def test_automatic_role_rename_preserves_bounded_alias_history():
    for aliases, can_rename in [(['SPIDER-MAN'], True), ([f'old-{index}' for index in range(20)], False)]:
        original = card(status='recognized', name='Spider-Man', recognition=recognition(name='Spider-Man'), aliases=aliases)
        source = {'character_cards': {'revision': 1, 'characters': [deepcopy(original)]}}
        proposal = candidate(existing_id='known')
        proposal['recognition'] = recognition()
        counts = detection.merge_detected_characters(source, [proposal], 1)
        saved = source['character_cards']['characters'][0]
        assert saved['aliases'] == aliases
        if can_rename:
            assert saved['preferred_name'] == '蜘蛛侠' and counts['updated_count'] == 1
        else:
            assert saved == original and counts['updated_count'] == 0 and counts['revision'] == 1
