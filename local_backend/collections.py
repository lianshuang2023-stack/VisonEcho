"""Project containers and reversible trash; media files are never removed."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
from urllib.parse import quote
import uuid

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .lifecycle import collection_deleted, video_running
from .projects import _project_record


class CollectionTitle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120, strict=True)

    @field_validator("title", mode="before")
    @classmethod
    def strip_title(cls, value):
        return value.strip() if isinstance(value, str) else value


def _now():
    return datetime.now(timezone.utc).isoformat()


def _save_or_rollback(store, before):
    try:
        store.save()
    except Exception:
        store.data.clear()
        store.data.update(before)
        raise HTTPException(500, "无法保存项目，请检查本地磁盘空间后重试。") from None


def ensure_collections(store):
    """Migrate the legacy flat video list once, without resetting existing trash."""
    with store.lock:
        before = copy.deepcopy(store.data)
        collections = store.data.setdefault("collections", {})
        if "default" not in collections:
            now = _now()
            collections["default"] = {"id": "default", "title": "默认项目",
                                      "created_at": now, "updated_at": now, "deleted": False}
        for source in store.data["inputs"].values():
            if not source.get("collection_id"):
                source["collection_id"] = "default"
        if store.data != before:
            _save_or_rollback(store, before)


def video_has_running_work(data, video_ids):
    """Include transcript calibration jobs whose video is linked indirectly."""
    ids = set(video_ids)
    if any(video_running(data, video_id) for video_id in ids):
        return True
    return any(task.get("status") == "RUNNING" and task.get("video_id") in ids
               for task in data.get("calibrations", {}).values())


def _deleted(item):
    return bool(item.get("deleted") or item.get("deleted_at"))


def _collection(data, collection_id):
    item = data.get("collections", {}).get(collection_id)
    if item is None:
        raise HTTPException(404, "项目不存在。")
    return item


def collection_record(data, collection_id):
    item = _collection(data, collection_id)
    videos = [(video_id, source) for video_id, source in data["inputs"].items()
              if source.get("collection_id", "default") == collection_id and not _deleted(source)]
    record = {"id": collection_id, "title": item["title"], "video_count": len(videos),
              "created_at": item.get("created_at", ""), "updated_at": item.get("updated_at", ""),
              "deleted": _deleted(item)}
    if item.get("deleted_at"):
        record["deleted_at"] = item["deleted_at"]
    if videos and not record["deleted"]:
        video_id, _ = max(videos, key=lambda entry: entry[1].get("updated_at") or entry[1].get("created_at") or entry[1].get("last_modified", ""))
        record["thumbnail_url"] = f"/api/projects/{quote(video_id, safe='')}/thumbnail"
    return record


def _video_record(data, video_id):
    source = data["inputs"][video_id]
    collection_id = source.get("collection_id", "default")
    parent = data.get("collections", {}).get(collection_id, {})
    record = _project_record(data, video_id)
    record.update(collection_id=collection_id, collection_title=parent.get("title", ""),
                  deleted=_deleted(source), deleted_at=source.get("deleted_at"))
    if record["deleted"] or collection_deleted(data, collection_id):
        record.pop("thumbnail_url", None)
    return record


def register_collection_routes(app, store, settings):
    ensure_collections(store)

    @app.get("/api/collections")
    def collections(include_deleted: bool = False):
        with store.lock:
            records = [collection_record(store.data, collection_id)
                       for collection_id, item in store.data["collections"].items()
                       if include_deleted or not _deleted(item)]
        return {"collections": sorted(records, key=lambda item: item["updated_at"], reverse=True)}

    @app.post("/api/collections", status_code=201)
    def create_collection(payload: CollectionTitle):
        with store.lock:
            before = copy.deepcopy(store.data)
            collection_id, now = uuid.uuid4().hex, _now()
            store.data["collections"][collection_id] = {"id": collection_id, "title": payload.title,
                "created_at": now, "updated_at": now, "deleted": False}
            _save_or_rollback(store, before)
            return collection_record(store.data, collection_id)

    @app.patch("/api/collections/{collection_id}")
    def rename_collection(collection_id: str, payload: CollectionTitle):
        with store.lock:
            item = _collection(store.data, collection_id)
            if _deleted(item):
                raise HTTPException(409, "请先从回收站恢复项目，再修改名称。")
            if item["title"] == payload.title:
                return collection_record(store.data, collection_id)
            before = copy.deepcopy(store.data)
            item.update(title=payload.title, updated_at=_now())
            _save_or_rollback(store, before)
            return collection_record(store.data, collection_id)

    @app.delete("/api/collections/{collection_id}")
    def delete_collection(collection_id: str):
        with store.lock:
            item = _collection(store.data, collection_id)
            if _deleted(item):
                return collection_record(store.data, collection_id)
            if any(upload.get("collection_id", "default") == collection_id
                   for upload in getattr(store, "active_uploads", {}).values()):
                raise HTTPException(409, "项目中有视频正在上传，请完成上传后再删除。")
            video_ids = [video_id for video_id, source in store.data["inputs"].items()
                         if source.get("collection_id", "default") == collection_id]
            if video_has_running_work(store.data, video_ids):
                raise HTTPException(409, "项目中有视频正在生成或校准字幕，请完成后再删除。")
            before = copy.deepcopy(store.data)
            now = _now()
            item.update(deleted=True, deleted_at=now, updated_at=now)
            _save_or_rollback(store, before)
            return collection_record(store.data, collection_id)

    @app.post("/api/collections/{collection_id}/restore")
    def restore_collection(collection_id: str):
        with store.lock:
            item = _collection(store.data, collection_id)
            if not _deleted(item):
                return collection_record(store.data, collection_id)
            before = copy.deepcopy(store.data)
            item.update(deleted=False, updated_at=_now())
            item.pop("deleted_at", None)
            _save_or_rollback(store, before)
            return collection_record(store.data, collection_id)

    @app.get("/api/trash")
    def trash():
        with store.lock:
            collections = [collection_record(store.data, collection_id)
                           for collection_id, item in store.data["collections"].items() if _deleted(item)]
            videos = [_video_record(store.data, video_id) for video_id, source in store.data["inputs"].items()
                      if _deleted(source) and not collection_deleted(store.data, source.get("collection_id", "default"))]
        return {"collections": sorted(collections, key=lambda item: item.get("deleted_at", ""), reverse=True),
                "videos": sorted(videos, key=lambda item: item.get("deleted_at") or "", reverse=True)}

    @app.post("/api/projects/{video_id}/restore")
    def restore_video(video_id: str):
        with store.lock:
            source = store.data["inputs"].get(video_id)
            if source is None:
                raise HTTPException(404, "视频不存在。")
            parent = _collection(store.data, source.get("collection_id", "default"))
            if _deleted(parent):
                raise HTTPException(409, "请先从回收站恢复所属项目，再恢复视频。")
            if not source.get("deleted") and not source.get("deleted_at"):
                return _video_record(store.data, video_id)
            before = copy.deepcopy(store.data)
            now = _now()
            source.update(deleted=False, updated_at=now)
            source.pop("deleted_at", None)
            parent["updated_at"] = now
            _save_or_rollback(store, before)
            return _video_record(store.data, video_id)
