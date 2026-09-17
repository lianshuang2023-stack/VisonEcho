"""Check configured Azure data endpoints without sending local files."""
import argparse
import json
import httpx
from .config import Settings

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', action='store_true', help='Also send a minimal billable text request.')
    args = parser.parse_args()
    settings = Settings.load()
    issues = settings.issues()
    if issues:
        raise SystemExit(chr(10).join(issues))
    root = settings.azure_speech_endpoint
    voice_url = (root.rstrip('/') + '/tts/cognitiveservices/voices/list' if root
                 else f'https://{settings.azure_speech_region}.tts.speech.microsoft.com/cognitiveservices/voices/list')
    checks = []
    try:
        with httpx.Client(timeout=45, follow_redirects=False) as client:
            response = client.get(voice_url, headers={'Ocp-Apim-Subscription-Key': settings.azure_speech_key})
            result = {'service': 'speech_voices', 'http_status': response.status_code, 'ok': False}
            if response.is_success:
                result['voice_available'] = any(v.get('ShortName') == settings.azure_speech_voice for v in response.json())
                result['ok'] = result['voice_available']
            checks.append(result)
            if args.model:
                response = client.post(settings.azure_openai_endpoint + '/chat/completions',
                    headers={'api-key': settings.azure_openai_api_key}, json={
                        'model': settings.azure_openai_deployment,
                        'messages': [{'role': 'user', 'content': 'Reply with OK only.'}],
                        'max_completion_tokens': 64})
                result = {'service': 'model', 'http_status': response.status_code, 'ok': response.is_success}
                if response.is_success:
                    result['model'] = response.json().get('model')
                checks.append(result)
    except httpx.HTTPError as exc:
        raise SystemExit('Azure connection failed: ' + type(exc).__name__) from None
    print(json.dumps(checks, indent=2))
    if not all(check['ok'] for check in checks):
        raise SystemExit(1)

if __name__ == '__main__':
    main()
