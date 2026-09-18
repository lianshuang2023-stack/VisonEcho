"""Review decisions cannot outlive the text, timing or evidence they approved."""
from copy import deepcopy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from local_backend.config import Settings
from local_backend.main import create_app, Store


@pytest.fixture
def workspace(tmp_path):
    settings = Settings(data_dir=tmp_path)
    app = create_app(settings)
    store = app.state.store
    store.data['inputs']['video'] = {'filename': 'source.mp4', 'duration': 12, 'collection_id': 'default'}
    directory = tmp_path / 'runs/version'
    directory.mkdir(parents=True)
    (directory / 'transcript.json').write_text(json.dumps({'cues': [{'id': 'dialogue', 'start': 0, 'end': 2, 'text': 'Hello.'}]}))
    (directory / 'output.mp4').write_bytes(b'reviewable output')
    store.data['executions']['version'] = {'execution_arn': 'version', 'video_id': 'video', 'status': 'SUCCEEDED',
        'result': {'output_path': str(directory / 'output.mp4'), 'transcript_path': str(directory / 'transcript.json'),
                   'segments': [{'segment_index': 0, 'start_time': 3, 'end_time': 6, 'silence_duration': 3,
                                 'dvi_text': 'A boat crosses the lake.', 'pass': True, 'audio_duration': 2,
                                 'frame_timestamps': [3.1, 4.5], 'visual_evidence': [{'fact': 'A boat.', 'frame_timestamps': [3.1]}]}]}}
    store.data['outputs']['version'] = {'filename': 'described.mp4'}
    store.save()
    with TestClient(app) as client:
        yield client, store, settings


def state(client):
    response = client.get('/api/videos/version/review-state')
    assert response.status_code == 200, response.text
    return response.json()


def approve(client, snapshot=None, choice='approved'):
    snapshot = snapshot or state(client)
    return client.put('/api/videos/version/review-state', json={
        'revision': snapshot['revision'], 'transcript_revision': snapshot['transcript_revision'],
        'changes': [{'segment_index': 0, 'state': choice}]})


def test_measured_review_is_advisory_and_does_not_block_exports(workspace):
    client, store, settings = workspace
    document = state(client)
    assert document['segments'][0] == {'segment_index': 0, 'state': 'draft', 'text': 'A boat crosses the lake.',
        'available_seconds': 3, 'speech_seconds': 2, 'timing_source': 'measured', 'margin_seconds': 1, 'risks': [], 'high_risk': False}
    assert document['counts'] == {'total': 1, 'pending': 1, 'approved': 0, 'conflicts': 0, 'uncertain': 0}
    assert not document['review_complete']
    assert document['can_export']
    assert client.get('/api/media/output/version').status_code == 200
    assert client.get('/api/media/output/version?download=true').status_code == 200
    assert client.get('/api/videos/version/export').status_code == 200
    response = approve(client)
    assert response.status_code == 200 and response.json()['review_complete']
    assert client.get('/api/media/output/version?download=true').headers['content-disposition'].startswith('attachment')
    assert client.get('/api/videos/version/export').status_code == 200
    assert Store(settings).data['executions']['version']['segment_review']['states']['0'] == 'approved'
    assert approve(client, document).status_code == 409


@pytest.mark.parametrize('mutation,expected', [
    ('text', 'modified'), ('transcript', 'draft'), ('feedback', 'draft'), ('characters', 'draft'), ('duration', 'draft')])
def test_approval_invalidates_on_changed_dependencies(workspace, mutation, expected):
    client, store, _ = workspace
    approved = approve(client).json()
    segment = store.data['executions']['version']['result']['segments'][0]
    if mutation == 'text':
        segment['evidence_description'] = segment['dvi_text']
        segment['dvi_text'] = 'A second boat.'
    elif mutation == 'transcript':
        (store.root / 'runs/version/transcript-edits.json').write_text(json.dumps({'revision': 1, 'cues': []}))
    elif mutation == 'feedback':
        store.data['executions']['version']['evidence_feedback'] = {'0': {'revision': 1, 'issues': ['wrong_person'], 'note': ''}}
    elif mutation == 'characters':
        store.data['inputs']['video']['character_cards'] = {'revision': 1, 'characters': []}
    else:
        segment['audio_duration'] = 2.2
    refreshed = state(client)
    assert refreshed['revision'] != approved['revision']
    assert refreshed['segments'][0]['state'] == expected and not refreshed['review_complete']
    assert approve(client, approved).status_code == 409
    assert client.get('/api/media/output/version?download=true').status_code == 200


@pytest.mark.parametrize('changes,code', [
    ({'audio_duration': 4}, 'duration_conflict'), ({'start_time': 1}, 'dialogue_overlap'),
    ({'audio_duration': 0, 'pass': False}, 'unrendered_audio'), ({'dvi_text': ''}, 'empty_text')])
def test_material_risks_cannot_be_approved(workspace, changes, code):
    client, store, _ = workspace
    store.data['executions']['version']['result']['segments'][0].update(changes)
    document = state(client)
    assert code in document['segments'][0]['risks'] and document['segments'][0]['high_risk']
    assert approve(client).status_code == 409
    assert approve(client, choice='needs_rewrite').status_code == 200
    assert not state(client)['review_complete']
    assert state(client)['can_export']
    assert client.get('/api/media/output/version?download=true').status_code == 200
    assert client.get('/api/videos/version/export?kind=description&format=txt').status_code == 200


def test_uncertainty_uses_real_evidence_signal_without_fake_confidence(workspace):
    client, store, _ = workspace
    segment = store.data['executions']['version']['result']['segments'][0]
    segment.pop('visual_evidence')
    document = state(client)
    assert document['counts']['uncertain'] == 1
    assert 'unverified_visual_evidence' in document['segments'][0]['risks']
    assert 'confidence' not in document['segments'][0]
    assert approve(client).json()['review_complete'], 'A person may inspect source frames and approve unverified visual text.'


def test_missing_transcript_and_subtitles_only_remain_review_incomplete(workspace):
    client, store, _ = workspace
    (store.root / 'runs/version/transcript.json').unlink()
    assert 'unverified_transcript' in state(client)['blockers']
    assert approve(client).status_code == 409
    store.data['executions']['version']['result']['segments'] = []
    assert 'no_narration' in state(client)['blockers']
    assert state(client)['can_export']
    assert client.get('/api/media/output/version?download=true').status_code == 200
    assert client.get('/api/videos/version/export?kind=description&format=txt').status_code == 200


def test_empty_or_skipped_windows_remain_in_advisory_checklist(workspace):
    client, store, _ = workspace
    store.data['executions']['version']['result']['segments'].append({
        'segment_index': 1, 'start_time': 8, 'end_time': 11, 'silence_duration': 3,
        'dvi_text': '', 'audio_duration': 0, 'pass': False})
    reviewed = approve(client).json()
    assert reviewed['counts']['total'] == 2 and reviewed['counts']['pending'] == 1
    assert reviewed['counts']['conflicts'] == 0
    assert not reviewed['review_complete'] and 'high_risk_segments' in reviewed['blockers']


def test_extended_output_uses_shifted_dialogue_time_not_source_window(workspace):
    client, store, _ = workspace
    result = store.data['executions']['version']['result']
    result.update(narration_mode='extended', insertions=[{'source_time': 5, 'output_start': 5, 'output_end': 8, 'duration': 3}])
    result['segments'][0].update(start_time=5, end_time=8, source_start=0, source_end=5, silence_duration=3, audio_duration=2)
    (store.root / 'runs/version/transcript.json').write_text(json.dumps({'cues': [
        {'id': 'before', 'start': 0, 'end': 5, 'text': 'Before.'}, {'id': 'after', 'start': 8, 'end': 10, 'text': 'After.'}]}))
    assert 'dialogue_overlap' not in state(client)['segments'][0]['risks']
    assert approve(client).json()['review_complete']


def test_early_character_name_blocks_approval_without_substring_false_match(workspace):
    client, store, _ = workspace
    store.data['inputs']['video']['character_cards'] = {'revision': 1, 'characters': [
        {'preferred_name': 'Ann', 'name_available_from': 8}]}
    segment = store.data['executions']['version']['result']['segments'][0]
    segment['dvi_text'] = 'Ann crosses the lake.'
    assert 'name_spoiler' in state(client)['segments'][0]['risks']
    assert approve(client).status_code == 409
    segment['dvi_text'] = 'An announcement appears.'
    assert 'name_spoiler' not in state(client)['segments'][0]['risks']


def test_legacy_review_true_cannot_bulk_approve_advisory_review(workspace):
    client, store, _ = workspace
    job = store.data['executions']['version']
    job.update(reviewed=True, reviewed_transcript_revision=0)
    assert not state(client)['review_complete']
    assert client.post('/api/videos/version/review', json={'reviewed': True, 'transcript_revision': 0}).status_code == 409
    approve(client)
    assert client.post('/api/videos/version/review', json={'reviewed': True, 'transcript_revision': 0}).status_code == 200


def test_failed_review_save_rolls_back_and_deleted_source_hides_state(workspace, monkeypatch):
    client, store, _ = workspace
    before = deepcopy(store.data)
    monkeypatch.setattr(store, 'save', lambda: (_ for _ in ()).throw(OSError('disk full')))
    assert approve(client).status_code == 500
    assert store.data == before
    store.data['inputs']['video']['deleted'] = True
    assert client.get('/api/videos/version/review-state').status_code == 404


def test_each_unsaved_dependency_edit_invalidates_previous_review_snapshot(workspace):
    client, store, _ = workspace
    old = state(client)
    segment = store.data['executions']['version']['result']['segments'][0]
    segment['dvi_text'] = 'First changed description.'
    changed = state(client)
    assert changed['revision'] != old['revision'] and approve(client, old).status_code == 409
    segment['dvi_text'] = 'Second changed description.'
    latest = state(client)
    assert latest['revision'] != changed['revision'] and approve(client, changed).status_code == 409
    assert latest['revision'] <= 2**53 - 1


def test_low_quality_transcript_requires_visible_human_review_signal(workspace):
    client, store, _ = workspace
    transcript = store.root / 'runs/version/transcript.json'
    payload = json.loads(transcript.read_text())
    payload['quality'] = {'review_required': True, 'low_confidence_word_count': 2}
    transcript.write_text(json.dumps(payload))
    document = state(client)
    assert 'uncertain_transcript' in document['segments'][0]['risks']
    assert document['counts']['uncertain'] == 1 and not document['review_complete']
    assert approve(client).json()['review_complete'], 'Saved human approval may acknowledge reported uncertainty.'


@pytest.mark.parametrize('reason', ['silent_audio', 'no_audio_track', 'user_declared_no_dialogue'])
def test_confirmed_no_dialogue_does_not_reflag_old_no_match_count(workspace, reason):
    client, store, _ = workspace
    path = store.root / 'runs/version/transcript.json'
    path.write_text(json.dumps({'cues': [], 'dialogue_status': 'no_speech', 'dialogue_reason': reason,
        'quality': {'review_required': False, 'no_match_count': 4}}))
    assert 'uncertain_transcript' not in state(client)['segments'][0]['risks']
    path.write_text(json.dumps({'cues': [], 'dialogue_status': 'unrecognized', 'dialogue_reason': 'speech_not_recognized',
        'quality': {'review_required': False, 'no_match_count': 4}}))
    assert 'uncertain_transcript' in state(client)['segments'][0]['risks']


def test_early_alias_is_blocked_but_configured_before_name_is_allowed(workspace):
    client, store, _ = workspace
    store.data['inputs']['video']['character_cards'] = {'revision': 1, 'characters': [
        {'preferred_name': '蜘蛛侠', 'aliases': ['Spider-Man', 'masked person'],
         'before_name': 'masked person', 'name_available_from': 8}]}
    segment = store.data['executions']['version']['result']['segments'][0]
    segment['dvi_text'] = 'Spider-Man crosses the lake.'
    assert 'name_spoiler' in state(client)['segments'][0]['risks']
    assert approve(client).status_code == 409
    segment['dvi_text'] = 'A masked person crosses the lake.'
    assert 'name_spoiler' not in state(client)['segments'][0]['risks']


def test_changed_render_file_cannot_reuse_prior_approval(workspace):
    client, store, _ = workspace
    previous = approve(client).json()
    (store.root / 'runs/version/output.mp4').write_bytes(b'a different rendered output')
    assert state(client)['revision'] != previous['revision']
    assert client.get('/api/media/output/version?download=true').status_code == 200


def test_copied_evidence_for_rewritten_text_is_explicitly_unverified(workspace):
    client, store, _ = workspace
    segment = store.data['executions']['version']['result']['segments'][0]
    segment['evidence_description'] = 'The original model description.'
    document = state(client)
    assert document['segments'][0]['state'] == 'modified'
    assert 'unverified_visual_evidence' in document['segments'][0]['risks']


def test_export_does_not_parse_corrupt_review_or_evidence_metadata(workspace):
    client, store, _ = workspace
    store.data['executions']['version']['segment_review'] = {'revision': 'invalid', 'states': ['not a map']}
    store.data['inputs']['video']['character_cards'] = {'revision': 'invalid', 'characters': 'not an array'}
    assert client.get('/api/media/output/version?download=true').status_code == 200
    assert client.get('/api/videos/version/export?kind=dialogue&format=srt').status_code == 200
    assert client.get('/api/videos/version/export?kind=description&format=txt').status_code == 200


def test_archived_saved_version_still_exports_without_being_reviewed(workspace):
    client, store, _ = workspace
    store.data['inputs']['video']['archived'] = True
    document = state(client)
    assert document['can_export'] and not document['review_complete']
    assert client.get('/api/media/output/version?download=true').status_code == 200
    assert client.get('/api/videos/version/export').status_code == 200


@pytest.mark.parametrize('problem,expected', [('missing', 404), ('external', 404), ('deleted', 404), ('failed', 409)])
def test_export_still_enforces_file_availability_version_and_containment(workspace, problem, expected):
    client, store, _ = workspace
    job = store.data['executions']['version']
    if problem == 'missing':
        (store.root / 'runs/version/output.mp4').unlink()
        assert not state(client)['can_export']
    elif problem == 'external':
        other = store.root / 'another-version-private.mp4'
        other.write_bytes(b'not this version')
        job['result']['output_path'] = str(other)
        assert not state(client)['can_export']
    elif problem == 'deleted':
        job['deleted_at'] = 'now'
    else:
        job['status'] = 'FAILED'
    response = client.get('/api/media/output/version?download=true')
    assert response.status_code == expected
    assert b'not this version' not in response.content
    if problem in ('deleted', 'failed'):
        assert client.get('/api/videos/version/export').status_code == expected
