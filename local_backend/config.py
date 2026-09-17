"""Server-only configuration. Secrets never enter frontend builds or API responses."""
from dataclasses import dataclass, field
from pathlib import Path
import os
import shutil

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
LANGUAGES = {
    "en-US": {"label": "English", "voice": "en-US-JennyNeural", "voices": [
        {"id": "en-US-JennyNeural", "label": "Jenny · 女声", "gender": "Female"},
        {"id": "en-US-GuyNeural", "label": "Guy · 男声", "gender": "Male"},
        {"id": "en-US-AriaNeural", "label": "Aria · 女声", "gender": "Female"},
    ]},
    "zh-CN": {"label": "中文", "voice": "zh-CN-XiaoxiaoNeural", "voices": [
        {"id": "zh-CN-XiaoxiaoNeural", "label": "晓晓 · 女声", "gender": "Female"},
        {"id": "zh-CN-YunxiNeural", "label": "云希 · 男声", "gender": "Male"},
        {"id": "zh-CN-XiaoyiNeural", "label": "晓伊 · 女声", "gender": "Female"},
    ]},
}


def validate_voice(language, voice=None):
    if language not in LANGUAGES:
        raise ValueError('请选择中文或英文。')
    selected = LANGUAGES[language]['voice'] if voice is None else voice
    if selected not in {item['id'] for item in LANGUAGES[language]['voices']}:
        raise ValueError('所选音色与解说语言不匹配，请重新选择音色。')
    return selected


@dataclass
class Settings:
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = field(default="", repr=False)
    azure_openai_deployment: str = "gpt-5.6-terra"
    azure_speech_key: str = field(default="", repr=False)
    azure_speech_region: str = ""
    azure_speech_endpoint: str = ""
    azure_speech_voice: str = "en-US-JennyNeural"
    speech_language: str = "en-US"
    # Source recognition is independent of the generated narration language.
    dialogue_language: str = "auto"
    narration_mode: str = "auto"
    # Per-job snapshot of user-confirmed names; not loaded from environment.
    character_context: list[dict] = field(default_factory=list, repr=False)
    character_library: list[dict] = field(default_factory=list, repr=False)
    detect_characters: bool = False
    detected_fictional_roles: list[dict] = field(default_factory=list, repr=False)
    max_video_seconds: float = 600
    max_upload_bytes: int = 500 * 1024 * 1024
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    data_dir: Path = ROOT / ".local-data"
    access_mode: str = "local"
    public_origin: str = ""
    hosted_data_dir: Path = ROOT / ".hosted-data"
    workspace_upload_limit: int | None = None

    @classmethod
    def load(cls):
        values = {**dotenv_values(ROOT / ".env.local"), **os.environ}
        def get(name, default=""):
            return (values.get(name) or default).strip()
        key = get("AZURE_OPENAI_API_KEY")
        return cls(
            azure_openai_endpoint=get("AZURE_OPENAI_ENDPOINT").rstrip("/"),
            azure_openai_api_key=key,
            azure_openai_deployment=get("AZURE_OPENAI_DEPLOYMENT", "gpt-5.6-terra"),
            azure_speech_key=get("AZURE_SPEECH_KEY", key),
            azure_speech_region=get("AZURE_SPEECH_REGION"),
            azure_speech_endpoint=get("AZURE_SPEECH_ENDPOINT").rstrip("/"),
            azure_speech_voice=get("AZURE_SPEECH_VOICE", "en-US-JennyNeural"),
            speech_language=get("SPEECH_LANGUAGE", "en-US"),
            dialogue_language=get("DIALOGUE_LANGUAGE", "auto"),
            max_video_seconds=float(get("MAX_VIDEO_SECONDS", "600")),
            max_upload_bytes=int(get("MAX_UPLOAD_MB", "500")) * 1024 * 1024,
            ffmpeg_bin=get("FFMPEG_BIN", "ffmpeg"),
            ffprobe_bin=get("FFPROBE_BIN", "ffprobe"),
            data_dir=Path(get("LOCAL_DATA_DIR", str(ROOT / ".local-data"))).resolve(),
            access_mode=get("ACCESS_MODE", "local"),
            public_origin=get("PUBLIC_ORIGIN"),
            hosted_data_dir=Path(get("HOSTED_DATA_DIR", str(ROOT / ".hosted-data"))).resolve(),
        )

    def issues(self):
        issues = []
        if not self.azure_openai_endpoint or not self.azure_openai_api_key:
            issues.append("Azure OpenAI endpoint and server-side API key are required.")
        if not self.azure_speech_key:
            issues.append("Azure Speech key is required.")
        if not self.azure_speech_region and not self.azure_speech_endpoint:
            issues.append("Set AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT for transcription and narration.")
        for binary in (self.ffmpeg_bin, self.ffprobe_bin):
            if not shutil.which(binary):
                issues.append(f"Required media tool is unavailable: {Path(binary).name}")
        return issues

    def redact(self, value):
        text = str(value)
        for secret in (self.azure_openai_api_key, self.azure_speech_key):
            if secret:
                text = text.replace(secret, "[REDACTED]")
        return text[:2000]
