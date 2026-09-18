"""Manually curated character cards with explicit, video-scoped frame links."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import math
from typing import Annotated, Literal
import uuid

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .lifecycle import require_video, video_running


class CharacterOccurrence(BaseModel):
    model_config = ConfigDict(extra='forbid')
    job_id: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')
    segment_index: int = Field(ge=0, le=10000, strict=True)


class CharacterThumbnail(CharacterOccurrence):
    frame_id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    # GET documents can be sent back unchanged; these presentation values are
    # always discarded and re-resolved from the validated evidence reference.
    timestamp: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    url: str | None = Field(default=None, max_length=1000)


class CharacterRecognition(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    kind: Literal['fictional']
    name: str = Field(min_length=1, max_length=100)
    confidence: Literal['high', 'medium', 'low']
    evidence: str = Field(min_length=1, max_length=600)

    @field_validator('name', 'evidence')
    @classmethod
    def meaningful_text(cls, value):
        value = ' '.join(value.split())
        if not value:
            raise ValueError('Recognition requires a name and visible design evidence.')
        return value


class CharacterCard(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(default='', max_length=80, pattern=r'^[A-Za-z0-9_-]*$')
    appearance: str = Field(default='', max_length=600)
    preferred_name: str = Field(default='', max_length=100)
    before_name: str = Field(default='', max_length=100)
    name_available_from: float = Field(default=0, ge=0, allow_inf_nan=False, strict=True)
    status: Literal['unconfirmed', 'confirmed', 'recognized'] = 'unconfirmed'
    recognition: CharacterRecognition | None = None
    aliases: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(default_factory=list, max_length=20)
    thumbnail: CharacterThumbnail | None = None
    occurrences: list[CharacterOccurrence] = Field(default_factory=list, max_length=200)


class CharacterDocument(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=0, strict=True)
    characters: list[CharacterCard] = Field(max_length=40)


def get_evidence_document(store, job_id, segment_index, settings):
    # Lazy import keeps core persistence usable without importing media workers.
    from .evidence import get_evidence_document as read_evidence
    return read_evidence(store, job_id, segment_index, settings)


def _document(source):
    raw = source.get('character_cards', {'revision': 0, 'characters': []})
    try:
        document = CharacterDocument.model_validate(raw).model_dump()
    except (ValidationError, TypeError, ValueError):
        raise HTTPException(409, '人物卡数据无法读取，请恢复本地项目数据后重试。') from None
    ids = [card['id'] for card in document['characters']]
    if any(not identifier for identifier in ids) or len(ids) != len(set(ids)):
        raise HTTPException(409, '人物卡标识无效，请恢复本地项目数据后重试。')
    for card in document['characters']:
        recognition = card.get('recognition')
        if card['status'] == 'recognized' and (not recognition or recognition['confidence'] != 'high'
                or recognition['name'] != card['preferred_name'] or not card['appearance'].strip()):
            raise HTTPException(409, '角色识别依据无效，请恢复本地人物卡数据后重试。')
    return document


def _require_editable(store, video_id):
    source = require_video(store.data, video_id)
    if source.get('archived'):
        raise HTTPException(409, '请先恢复归档视频，再编辑人物卡。')
    if store.busy.locked() or video_running(store.data, video_id):
        raise HTTPException(409, '视频正在处理，请完成后再编辑人物卡。')
    return source


def _same_video(store, video_id, job_id):
    job = store.data.get('executions', {}).get(job_id)
    if (not job or job.get('video_id') != video_id or job.get('deleted') or job.get('deleted_at')
            or job.get('status') != 'SUCCEEDED'):
        raise HTTPException(422, '人物卡只能引用当前视频的画面和段落。')
    return job


def _validate_segment(store, video_id, reference):
    job = _same_video(store, video_id, reference['job_id'])
    segments = job.get('result', {}).get('segments', [])
    if sum(isinstance(segment, dict) and segment.get('segment_index') == reference['segment_index']
           for segment in segments) != 1:
        raise HTTPException(422, '人物卡引用的段落不存在，请重新选择。')


def _resolve(store, video_id, document, settings):
    """Resolve explicit references without holding the evidence helper's lock."""
    output = copy.deepcopy(document)
    evidence = {}
    references = [entry for card in output['characters'] for entry in card['occurrences']]
    references.extend(card['thumbnail'] for card in output['characters'] if card['thumbnail'])
    thumbnails = {(card['thumbnail']['job_id'], card['thumbnail']['segment_index'])
                  for card in output['characters'] if card['thumbnail']}
    with store.lock:
        require_video(store.data, video_id)
        for reference in references:
            _validate_segment(store, video_id, reference)
    # Occurrences only attach existing narration segments. Resolve image assets
    # for the thumbnail references, never for every attached occurrence.
    for job_id, segment_index in sorted(thumbnails):
        try:
            evidence[job_id, segment_index] = get_evidence_document(store, job_id, segment_index, settings)
        except HTTPException as exc:
            if exc.status_code in (404, 422):
                raise HTTPException(422, '人物卡引用的画面或段落不存在，请重新选择。') from None
            raise
    for card in output['characters']:
        thumb = card['thumbnail']
        if not thumb:
            continue
        doc = evidence[thumb['job_id'], thumb['segment_index']]
        frame = next((frame for frame in doc.get('frames', [])
                      if frame.get('frame_id', frame.get('id')) == thumb['frame_id']), None)
        if not frame:
            raise HTTPException(422, '人物卡引用的画面不存在，请重新选择。')
        timestamp, url = frame.get('timestamp'), frame.get('url')
        if (not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp) or timestamp < 0
                or not isinstance(url, str) or not url.startswith('/api/') or '\\' in url or '..' in url):
            raise HTTPException(409, '人物卡画面引用暂不可用，请重新选择。')
        card['thumbnail'] = {key: thumb[key] for key in ('job_id', 'segment_index', 'frame_id')}
        card['thumbnail'].update(timestamp=timestamp, url=url)
    with store.lock:
        require_video(store.data, video_id)
        for reference in references:
            _validate_segment(store, video_id, reference)
    return output


def _normalize(payload, current):
    existing = {card['id']: card for card in current['characters']}
    result, seen = [], set()
    for item in payload.characters:
        card = item.model_dump()
        identifier = card['id']
        if identifier and identifier not in existing:
            raise HTTPException(422, '人物卡标识不存在。新增人物卡请使用空标识。')
        identifier = identifier or uuid.uuid4().hex
        if identifier in seen:
            raise HTTPException(422, '人物卡标识不能重复。')
        seen.add(identifier)
        card['id'] = identifier
        for key in ('appearance', 'preferred_name', 'before_name'):
            card[key] = ' '.join(card[key].split())
        previous_card = existing.get(identifier, {})
        previous_recognition = previous_card.get('recognition')
        if card.get('recognition') is not None and card['recognition'] != previous_recognition:
            raise HTTPException(422, '自动识别依据只能由识别任务生成，不能手动新增或修改。')
        if card['status'] == 'recognized':
            if previous_card.get('status') != 'recognized' or not previous_recognition:
                raise HTTPException(422, '新人物请使用待确认或已确认状态。')
            if any(card.get(key) != previous_card.get(key) for key in ('appearance', 'preferred_name', 'recognition')):
                card['recognition'] = None
                card['status'] = 'confirmed' if card['appearance'] and card['preferred_name'] else 'unconfirmed'
        else:
            # A user-confirmed correction becomes user naming guidance; the
            # original model observation no longer claims to validate it.
            card['recognition'] = None
        if card['status'] == 'confirmed' and (not card['appearance'] or not card['preferred_name']):
            raise HTTPException(422, '确认人物前，请填写外观特征和称呼。')
        aliases = []
        for alias in card['aliases']:
            alias = ' '.join(alias.split())
            if not alias or len(alias) > 100:
                raise HTTPException(422, '历史称呼须为 1 至 100 个字符。')
            if alias.casefold() not in {value.casefold() for value in aliases}:
                aliases.append(alias)
        previous = existing.get(identifier, {}).get('preferred_name', '')
        if previous and previous != card['preferred_name'] and previous.casefold() not in {value.casefold() for value in aliases}:
            aliases.append(previous)
        if len(aliases) > 20:
            raise HTTPException(422, '历史称呼最多保留 20 项，请整理后重试。')
        card['aliases'] = aliases
        occurrences, attachments = [], set()
        for entry in card['occurrences']:
            key = entry['job_id'], entry['segment_index']
            if key not in attachments:
                occurrences.append(entry)
                attachments.add(key)
        card['occurrences'] = occurrences
        if card['thumbnail']:
            card['thumbnail'] = {key: card['thumbnail'][key] for key in ('job_id', 'segment_index', 'frame_id')}
        result.append(card)
    return {'revision': current['revision'] + 1, 'characters': result}


def confirmed_character_context(store, video_id):
    """Copy human names and visually recognized fictional-character guidance."""
    with store.lock:
        source = require_video(store.data, video_id)
        document = _document(source)
        return [{**{key: card[key] for key in ('id', 'appearance', 'preferred_name', 'aliases')},
                 **({key: card[key] for key in ('before_name', 'name_available_from')} if card['before_name'] or card['name_available_from'] else {}),
                 **({'recognition': card['recognition']} if card['status'] == 'recognized' else {})}
                for card in document['characters'] if card['status'] in ('confirmed', 'recognized')
                and card['appearance'].strip() and card['preferred_name'].strip()]


def register_character_routes(app, store, settings):
    @app.get('/api/projects/{video_id}/characters')
    def get_characters(video_id: str):
        with store.lock:
            document = _document(require_video(store.data, video_id))
        return _resolve(store, video_id, document, settings)

    @app.put('/api/projects/{video_id}/characters')
    def save_characters(video_id: str, payload: CharacterDocument):
        with store.lock:
            current = _document(_require_editable(store, video_id))
            if payload.revision != current['revision']:
                raise HTTPException(409, '人物卡已在其他窗口修改，请重新加载后保存。')
            saved = _normalize(payload, current)
            duration = store.data['inputs'][video_id].get('duration')
            if duration is not None and any(card['name_available_from'] > duration for card in saved['characters']):
                raise HTTPException(422, '人物称呼的启用时间不能超过原片时长。')
        resolved = _resolve(store, video_id, saved, settings)
        with store.lock:
            source = _require_editable(store, video_id)
            if _document(source)['revision'] != payload.revision:
                raise HTTPException(409, '人物卡已在其他窗口修改，请重新加载后保存。')
            for card in saved['characters']:
                for reference in card['occurrences'] + ([card['thumbnail']] if card['thumbnail'] else []):
                    _validate_segment(store, video_id, reference)
            previous = copy.deepcopy(source)
            # Keep each video's complete document and timestamp in the Store's
            # single atomic index replacement, avoiding a two-file transaction.
            source['character_cards'] = saved
            source['updated_at'] = datetime.now(timezone.utc).isoformat()
            try:
                store.save()
            except Exception:
                source.clear()
                source.update(previous)
                raise HTTPException(500, '无法保存人物卡，请检查本地磁盘空间后重试。') from None
        return resolved
