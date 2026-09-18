"""Punctuation-free subtitle presentation with genuine speaker boundaries."""
from copy import deepcopy
import json

from fastapi.testclient import TestClient
import pytest

from local_backend.config import Settings
from local_backend.main import create_app
from local_backend.projects import _validate_cues
from local_backend.subtitles import normalize_subtitle_text
from local_backend.timeline import cues_to_source


@pytest.mark.parametrize('text,expected', [
    ('你好，欢迎观看！现在开始。', '你好欢迎观看现在开始'),
    ('Hello,world! It is well-known.', 'Hello world It is well known'),
    ("Don't change 3.14 or 1,000.50!", "Don't change 3.14 or 1,000.50"),
    ('“Hello!” she said; then—left.', 'Hello she said then left'),
    ('她说：“你好！”', '她说你好'),
])
def test_display_punctuation_removed_without_corrupting_lexical_forms(text, expected):
    assert normalize_subtitle_text(text) == expected
    assert normalize_subtitle_text(expected) == expected


@pytest.fixture
def workspace(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    store = app.state.store
    store.data['inputs']['video'] = {'filename': 'source.mp4', 'duration': 8, 'collection_id': 'default'}
    run = tmp_path / 'runs/job'
    run.mkdir()
    payload = {'language': 'en-US', 'cues': [
        {'id': 'one', 'start': 1, 'end': 3, 'text': "Don't move!", 'speaker': 'speaker_1', 'low_confidence': True},
        {'id': 'two', 'start': 2, 'end': 4, 'text': 'Wait,please.', 'speaker': 'speaker_2', 'confidence': .8},
    ], 'quality': {'review_required': True, 'speaker_count': 2, 'diarization_available': True, 'overlapping_utterance_count': 1}}
    transcript = run / 'transcript.json'
    transcript.write_text(json.dumps(payload))
    store.data['executions']['job'] = {'video_id': 'video', 'status': 'SUCCEEDED', 'result': {
        'transcript_path': str(transcript), 'segments': [{'segment_index': 0, 'start_time': 5, 'end_time': 7,
            'silence_duration': 2, 'pass': True, 'dvi_text': 'A boat moves, slowly.'}]}}
    with TestClient(app) as client:
        yield client, store, transcript, payload


def test_existing_transcript_normalizes_view_without_rewriting_raw_or_guessing_speakers(workspace):
    client, _, path, raw = workspace
    original = path.read_bytes()
    result = client.get('/api/videos/job/transcript').json()
    assert [cue['text'] for cue in result['cues']] == ["Don't move", 'Wait please']
    assert [cue['speaker'] for cue in result['cues']] == ['speaker_1', 'speaker_2']
    assert result['quality'] == raw['quality']
    assert path.read_bytes() == original


def test_overlapping_distinct_speakers_roundtrip_and_quality_cannot_be_forged(workspace):
    client, _, _, _ = workspace
    current = client.get('/api/videos/job/transcript').json()
    current.pop('quality')
    current['cues'][0].update(text='Stop—now!', low_confidence=False, confidence=1)
    current['cues'][1].update(text='Wait, please!', confidence=1, uncertain=False)
    result = client.put('/api/videos/job/transcript', json=current)
    assert result.status_code == 200, result.text
    saved = result.json()
    assert saved['cues'][0]['text'] == 'Stop now'
    assert saved['cues'][0]['low_confidence'] is True and 'confidence' not in saved['cues'][0]
    assert saved['cues'][1]['confidence'] == .8 and 'uncertain' not in saved['cues'][1]
    assert saved['cues'][0]['end'] > saved['cues'][1]['start']
    assert client.get('/api/videos/job/transcript').json() == saved


@pytest.mark.parametrize('speaker', [None, 'speaker_1', 'unknown', 'speaker_0', '../name', 'speaker_1000000'])
def test_unknown_same_or_invalid_speaker_overlap_rejected(workspace, speaker):
    client, _, _, _ = workspace
    current = client.get('/api/videos/job/transcript').json()
    current.pop('quality')
    current['cues'][1]['speaker'] = speaker
    assert client.put('/api/videos/job/transcript', json=current).status_code == 422


def test_all_overlapping_intervals_checked_not_just_previous_row():
    cues = [{'id': 'a', 'start': 0, 'end': 6, 'text': 'Long', 'speaker': 'speaker_1'},
            {'id': 'b', 'start': 1, 'end': 2, 'text': 'Brief', 'speaker': 'speaker_2'},
            {'id': 'c', 'start': 3, 'end': 4, 'text': 'Same long speaker', 'speaker': 'speaker_1'}]
    with pytest.raises(Exception, match='different known speakers'):
        _validate_cues(cues, 8)


def test_dialogue_exports_have_speaker_metadata_but_narration_punctuation_stays(workspace):
    client, _, _, _ = workspace
    srt = client.get('/api/videos/job/export?format=srt').text
    assert "Speaker 1 Don't move" in srt and 'Speaker 2 Wait please' in srt
    assert '00:00:01,000 --> 00:00:03,000' in srt and '00:00:02,000 --> 00:00:04,000' in srt
    vtt = client.get('/api/videos/job/export?format=vtt').text
    assert "<v Speaker 1>Don't move</v>" in vtt and '<v Speaker 2>Wait please</v>' in vtt
    assert 'A boat moves, slowly.' in client.get('/api/videos/job/export?kind=description&format=txt').text


def test_source_timeline_mapping_keeps_speaker_and_readonly_confidence():
    cues = [{'id': 'a', 'start': 5, 'end': 7, 'text': 'Hello', 'speaker': 'speaker_1', 'low_confidence': True}]
    original = deepcopy(cues)
    mapped = cues_to_source(cues, [{'output_start': 2, 'output_end': 4, 'source_time': 2, 'duration': 2}])
    assert mapped[0] == {**cues[0], 'start': 3, 'end': 5}
    assert cues == original
