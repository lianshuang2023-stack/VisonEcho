"""Visual coverage and grounded request contracts, with synthetic media only."""
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from local_backend.pipeline import PipelineError, _extract_frames, _frame_times, _generate_description


def settings():
    return SimpleNamespace(azure_openai_endpoint='https://example.openai.azure.com/openai/v1',
                           azure_openai_api_key='test-only', azure_openai_deployment='test-deployment',
                           speech_language='en-US')


def completion(description='A white square.', indices=None):
    return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps({
        'description': description, 'observations': [{'fact': 'A white square.', 'frame_indices': [0] if indices is None else indices}]})}}],
        'usage': {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30}}


def test_scene_sampling_spans_interval_and_short_cut():
    times = _frame_times(10, 4, [11.2, 11.4])
    assert 3 <= len(times) <= 8
    assert times == sorted(set(times))
    assert all(10 < t < 14 for t in times)
    assert times[0] < 10.1 and times[-1] > 13.9
    assert any(11.2 < t < 11.4 for t in times)
    assert len(_frame_times(0, 15, list(range(1, 15)))) <= 8


def test_real_extraction_captures_short_scene_missed_by_three_fixed_frames(tmp_path):
    source = tmp_path / 'cuts.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                    'color=black:s=128x96:r=30:d=4', '-vf',
                    "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,1.2,1.4)'",
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], check=True)
    frames = _extract_frames(source, tmp_path, {'start_time': 0, 'silence_duration': 4}, 0, settings())
    light = []
    for frame in frames:
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(frame['path']), '-vf', 'scale=1:1',
                              '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
        if raw[0] > 200:
            light.append(frame['timestamp'])
    assert any(1.2 <= t <= 1.4 for t in light)


@pytest.mark.parametrize('fps', [1, 10])
def test_frame_sampling_stays_within_decodable_low_fps_tail(tmp_path, fps):
    source = tmp_path / 'low-fps.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                    f'color=black:s=96x64:r={fps}:d=4', '-c:v', 'libx264', str(source)], check=True)
    frames = _extract_frames(source, tmp_path, {'start_time': 1, 'silence_duration': 3}, 0, settings())
    assert frames and all(frame['path'].stat().st_size for frame in frames)
    assert all(1 <= frame['timestamp'] <= 4 - 1/fps for frame in frames)


def test_description_uses_high_detail_and_no_future_dialogue(tmp_path):
    frame = tmp_path / 'image.jpg'; frame.write_bytes(b'synthetic-image')
    requests = []
    def handle(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=completion())
    segment = {'start_time': 10, 'end_time': 14, 'silence_duration': 4,
               'source_start': 4, 'source_end': 9, 'insertion_time': 9}
    transcript = {'phrases': [{'start': 5, 'end': 6, 'text': 'Earlier context.'},
                              {'start': 9.1, 'end': 10, 'text': 'Future dialogue.'}]}
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        text, usage = _generate_description(segment, [{'path': frame, 'timestamp': 5}], transcript, [], settings(), client)
    assert text == 'A white square.' and usage['request_count'] == 1
    content = requests[0]['messages'][1]['content']
    context = json.loads(content[0]['text'])
    assert context['source_interval_start_seconds'] == 4 and context['source_interval_end_seconds'] == 9
    assert context['nearby_dialogue_context_only'][0]['text'] == 'Earlier context.'
    assert len(context['nearby_dialogue_context_only']) == 1
    assert content[1]['image_url']['detail'] == 'high'
    assert segment['visual_evidence'][0]['frame_timestamps'] == [5]
    assert segment['evidence_description'] == text


def test_confirmed_character_names_are_passed_as_references_and_matches_saved(tmp_path):
    frame = tmp_path / 'image.jpg'; frame.write_bytes(b'synthetic-image')
    config = settings()
    config.character_context = [{'id': 'person-a', 'preferred_name': 'Alex',
                                 'appearance': 'Blue jacket, short hair', 'aliases': ['blue-jacket person']}]
    captured = []
    def handle(request):
        captured.append(json.loads(request.content))
        response = completion('Alex holds a square.')
        payload = json.loads(response['choices'][0]['message']['content'])
        payload['character_ids'] = ['person-a']
        response['choices'][0]['message']['content'] = json.dumps(payload)
        return httpx.Response(200, json=response)
    segment = {'start_time': 0, 'end_time': 5, 'silence_duration': 5}
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        _generate_description(segment, [{'path': frame, 'timestamp': 1}], {'phrases': []}, [], config, client)
    prompt = json.loads(captured[0]['messages'][1]['content'][0]['text'])
    assert prompt['confirmed_character_cards'] == config.character_context
    assert segment['character_ids'] == ['person-a']
    assert 'Similar clothing alone does not prove identity' in captured[0]['messages'][0]['content']


def test_model_cannot_invent_character_card_ids(tmp_path):
    frame = tmp_path / 'image.jpg'; frame.write_bytes(b'synthetic-image')
    response = completion()
    payload = json.loads(response['choices'][0]['message']['content'])
    payload['character_ids'] = ['unknown']
    response['choices'][0]['message']['content'] = json.dumps(payload)
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response))) as client:
        with pytest.raises(PipelineError):
            _generate_description({'start_time': 0, 'end_time': 5, 'silence_duration': 5},
                                  [{'path': frame, 'timestamp': 1}], {'phrases': []}, [], settings(), client)


def test_overlong_description_gets_one_bounded_rewrite_and_counts_usage(tmp_path):
    frame = tmp_path / 'image.jpg'; frame.write_bytes(b'synthetic-image')
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=completion('A very large bright white square fills the whole image.' if len(calls) == 1 else 'White square.'))
    segment = {'start_time': 0, 'end_time': 2, 'silence_duration': 2}
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        text, usage = _generate_description(segment, [{'path': frame, 'timestamp': 1}], {'phrases': []}, [], settings(), client)
    assert text == 'White square.' and len(calls) == 2
    assert usage['request_count'] == 2 and usage['total_tokens'] == 60


@pytest.mark.parametrize('invalid', ['evidence', 'refusal'])
def test_unusable_evidence_or_provider_refusal_never_retried(tmp_path, invalid):
    frame = tmp_path / 'image.jpg'; frame.write_bytes(b'synthetic-image')
    calls = []
    def handle(request):
        calls.append(request)
        payload = completion(indices=[5]) if invalid == 'evidence' else {
            'choices': [{'finish_reason': 'content_filter', 'message': {'refusal': 'Declined'}}]}
        return httpx.Response(200, json=payload)
    with httpx.Client(transport=httpx.MockTransport(handle)) as client, pytest.raises(PipelineError):
        _generate_description({'start_time': 0, 'end_time': 2, 'silence_duration': 2},
                              [{'path': frame, 'timestamp': 1}], {'phrases': []}, [], settings(), client)
    assert len(calls) == 1
