"""Explicit live smoke on generated fixtures; never opens workspace videos.

Run as `python -m local_backend.check_quality_smoke`. Uses the configured Azure
resource for two short TTS/STT samples and one image description request.
"""
import json
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path

import httpx

from .config import Settings
from .pipeline import _generate_description, _synthesize
from .transcription import transcribe_audio, transcript_cues


def main():
    settings = Settings.load()
    output = Path(tempfile.mkdtemp(prefix='visionecho-quality-smoke-'))
    report = {'output_dir': str(output), 'speech': [], 'visual': {}}
    with httpx.Client(timeout=httpx.Timeout(60, connect=15)) as client:
        for language, voice, sentence, expected in [
            ('en-US', 'en-US-JennyNeural', 'Hello. The blue door is open. The ticket costs two hundred dollars.', 'blue'),
            ('zh-CN', 'zh-CN-XiaoxiaoNeural', '你好，蓝色的门打开了。我们现在开始演示。', '蓝')]:
            config = replace(settings, speech_language=language, azure_speech_voice=voice, dialogue_language='auto')
            raw, audio = output / f'{language}-tts.wav', output / f'{language}-input.wav'
            try:
                _synthesize(sentence, raw, 12, config, client)
                subprocess.run([settings.ffmpeg_bin, '-v', 'error', '-i', str(raw), '-ar', '16000', '-ac', '1', str(audio)], check=True)
                # Narration deliberately has the other language. Recognition must
                # depend only on source audio and the independent auto setting.
                transcript = transcribe_audio(audio, replace(config, speech_language='zh-CN' if language == 'en-US' else 'en-US'))
                transcript['cues'] = transcript_cues(transcript)
                (output / f'{language}-transcript.json').write_text(json.dumps(transcript, ensure_ascii=False, indent=2))
                ok = transcript['language'] == language and expected in transcript['text'].lower() and bool(transcript['words'])
                report['speech'].append({'requested_sample': language, 'passed': ok,
                    'detected': transcript['language'], 'text': transcript['text'], 'cue_count': len(transcript['cues'])})
            except Exception as exc:
                report['speech'].append({'requested_sample': language, 'passed': False, 'error': settings.redact(exc)})
        frames = []
        for index, x in enumerate([80, 200, 320]):
            frame = output / f'square-{index}.jpg'
            subprocess.run([settings.ffmpeg_bin, '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360',
                            '-vf', f'drawbox=x={x}:y=120:w=100:h=100:color=white:t=fill', '-frames:v', '1', str(frame)], check=True)
            frames.append({'timestamp': index + 0.2, 'path': frame})
        try:
            segment = {'start_time': 0, 'end_time': 5, 'silence_duration': 5}
            text, usage = _generate_description(segment, frames, {'phrases': []}, [], replace(settings, speech_language='en-US'), client)
            report['visual'] = {'description': text, 'evidence': segment.get('visual_evidence'), 'usage': usage}
        except Exception as exc:
            report['visual'] = {'error': settings.redact(exc)}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
