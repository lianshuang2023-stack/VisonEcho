"""Container migration, reversible trash, running-work guards, and rollback."""
import copy
import json
from threading import Lock
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from local_backend.collections import ensure_collections, register_collection_routes


class FakeStore:
    def __init__(self, root):
        self.root = root
        self.lock = Lock()
        self.data = {"inputs": {
            "one": {"filename": "First video.mp4", "duration": 12, "size_mb": 1.5,
                    "created_at": "2026-09-12T00:00:00+00:00"},
            "two": {"filename": "第二个.mp4", "duration": 20, "created_at": "2026-09-13T00:00:00+00:00"}},
                     "executions": {}, "outputs": {}, "calibrations": {}}
        self.saved = 0

    def save(self):
        assert self.lock.locked(), "Every metadata mutation must hold the store lock"
        self.saved += 1
        (self.root / "index.json").write_text(json.dumps(self.data), encoding="utf-8")


@pytest.fixture
def workspace(tmp_path):
    store = FakeStore(tmp_path)
    app = FastAPI()
    register_collection_routes(app, store, SimpleNamespace())
    with TestClient(app) as client:
        yield client, store


def test_migrate_legacy_videos_preserves_data_and_is_idempotent(tmp_path):
    store = FakeStore(tmp_path)
    store.data["inputs"]["one"]["archived"] = True
    original = copy.deepcopy(store.data)
    ensure_collections(store)
    assert store.data["collections"]["default"]["title"] == "默认项目"
    assert all(source["collection_id"] == "default" for source in store.data["inputs"].values())
    assert store.data["inputs"]["one"]["archived"] is True
    assert store.data["executions"] == original["executions"]
    persisted = json.loads((tmp_path / "index.json").read_text())
    assert persisted == store.data
    ensure_collections(store)
    assert store.saved == 1


def test_migration_does_not_restore_deleted_default_or_reassign_existing_video(tmp_path):
    store = FakeStore(tmp_path)
    store.data["collections"] = {"default": {"id": "default", "title": "Renamed", "deleted": True, "deleted_at": "old"}}
    store.data["inputs"]["one"]["collection_id"] = "other"
    ensure_collections(store)
    assert store.data["collections"]["default"]["deleted"] is True
    assert store.data["collections"]["default"]["title"] == "Renamed"
    assert store.data["inputs"]["one"]["collection_id"] == "other"


def test_create_rename_counts_and_title_validation(workspace):
    client, store = workspace
    initial = client.get("/api/collections").json()["collections"][0]
    assert initial["id"] == "default" and initial["video_count"] == 2
    assert initial["thumbnail_url"] == "/api/projects/two/thumbnail"
    created = client.post("/api/collections", json={"title": "  新项目  "})
    assert created.status_code == 201
    item = created.json()
    assert item["title"] == "新项目" and item["video_count"] == 0
    assert item["created_at"] == item["updated_at"] and not item["deleted"]
    renamed = client.patch(f"/api/collections/{item['id']}", json={"title": "Updated"})
    assert renamed.json()["title"] == "Updated"
    saved = store.saved
    assert client.patch(f"/api/collections/{item['id']}", json={"title": "Updated"}).status_code == 200
    assert store.saved == saved
    assert json.loads((store.root / "index.json").read_text())["collections"][item["id"]]["title"] == "Updated"


@pytest.mark.parametrize("payload", [{}, {"title": " "}, {"title": "x" * 121}, {"title": None},
                                     {"title": 123}, {"title": "Valid", "deleted": True}])
def test_invalid_titles_never_mutate(workspace, payload):
    client, store = workspace
    before = copy.deepcopy(store.data)
    assert client.post("/api/collections", json=payload).status_code == 422
    assert client.patch("/api/collections/default", json=payload).status_code == 422
    assert store.data == before


def test_delete_container_hides_children_logically_and_restore_is_idempotent(workspace):
    client, store = workspace
    original_inputs = copy.deepcopy(store.data["inputs"])
    source_file = store.root / "original.mp4"
    source_file.write_bytes(b"original media")
    response = client.delete("/api/collections/default")
    assert response.status_code == 200 and response.json()["deleted"]
    deleted_at = response.json()["deleted_at"]
    assert response.json()["video_count"] == 2
    assert client.get("/api/collections").json() == {"collections": []}
    assert client.get("/api/collections?include_deleted=true").json()["collections"][0]["deleted"]
    assert client.get("/api/trash").json()["collections"][0]["id"] == "default"
    assert client.get("/api/trash").json()["videos"] == []
    assert store.data["inputs"] == original_inputs
    assert source_file.read_bytes() == b"original media"
    saved = store.saved
    assert client.delete("/api/collections/default").json()["deleted_at"] == deleted_at
    assert store.saved == saved
    assert client.patch("/api/collections/default", json={"title": "Renamed"}).status_code == 409
    restored = client.post("/api/collections/default/restore")
    assert not restored.json()["deleted"] and "deleted_at" not in restored.json()
    assert restored.json()["video_count"] == 2
    saved = store.saved
    assert client.post("/api/collections/default/restore").status_code == 200
    assert store.saved == saved


@pytest.mark.parametrize("kind", ["execution", "calibration-linked", "calibration-direct"])
def test_running_work_blocks_container_deletion(workspace, kind):
    client, store = workspace
    if kind == "execution":
        store.data["executions"]["job"] = {"video_id": "one", "status": "RUNNING"}
    elif kind == "calibration-linked":
        store.data["executions"]["job"] = {"video_id": "one", "status": "SUCCEEDED"}
        store.data["calibrations"]["cal"] = {"job_id": "job", "status": "RUNNING"}
    else:
        store.data["calibrations"]["cal"] = {"video_id": "one", "status": "RUNNING"}
    before = copy.deepcopy(store.data)
    assert client.delete("/api/collections/default").status_code == 409
    assert store.data == before


def test_running_work_in_another_container_does_not_block_delete(workspace):
    client, store = workspace
    other = client.post("/api/collections", json={"title": "Another"}).json()["id"]
    store.data["inputs"]["one"]["collection_id"] = other
    store.data["executions"]["job"] = {"video_id": "one", "status": "RUNNING"}
    assert client.delete("/api/collections/default").status_code == 200


def test_active_upload_blocks_only_its_collection_deletion(workspace):
    client, store = workspace
    other = client.post("/api/collections", json={"title": "Another"}).json()["id"]
    store.active_uploads = {"upload-token": {"collection_id": "default"}}
    assert client.delete("/api/collections/default").status_code == 409
    assert not store.data["collections"]["default"]["deleted"]
    assert client.delete(f"/api/collections/{other}").status_code == 200
    store.active_uploads.clear()
    assert client.delete("/api/collections/default").status_code == 200


def test_individual_video_trash_parent_restore_then_video_restore(workspace):
    client, store = workspace
    store.data["inputs"]["one"].update(deleted=True, deleted_at="2026-09-14T00:00:00+00:00",
                                              internal_path="/must/not/leak.mp4")
    trash = client.get("/api/trash")
    video = trash.json()["videos"][0]
    assert video["video_id"] == "one" and video["title"] == "First video"
    assert video["collection_title"] == "默认项目" and video["collection_id"] == "default"
    assert "/must/not/leak" not in trash.text and "internal_path" not in trash.text
    assert client.get("/api/collections").json()["collections"][0]["video_count"] == 1
    assert client.delete("/api/collections/default").status_code == 200
    assert client.get("/api/trash").json()["videos"] == []
    assert client.post("/api/projects/one/restore").status_code == 409
    assert client.post("/api/collections/default/restore").status_code == 200
    assert len(client.get("/api/trash").json()["videos"]) == 1
    restored = client.post("/api/projects/one/restore")
    assert restored.status_code == 200 and restored.json()["deleted"] is False
    assert restored.json()["deleted_at"] is None
    assert "deleted_at" not in store.data["inputs"]["one"]
    assert client.get("/api/trash").json()["videos"] == []
    saved = store.saved
    assert client.post("/api/projects/one/restore").status_code == 200
    assert store.saved == saved


def test_deleted_at_without_boolean_uses_same_visibility_and_restore_rules(workspace):
    client, store = workspace
    store.data["inputs"]["one"]["deleted_at"] = "2026-09-14T00:00:00+00:00"
    assert client.get("/api/trash").json()["videos"][0]["deleted"] is True
    assert client.get("/api/collections").json()["collections"][0]["video_count"] == 1
    store.data["collections"]["default"]["deleted_at"] = "2026-09-15T00:00:00+00:00"
    assert client.get("/api/collections").json()["collections"] == []
    assert client.post("/api/projects/one/restore").status_code == 409
    assert client.post("/api/collections/default/restore").status_code == 200
    assert client.post("/api/projects/one/restore").status_code == 200


@pytest.mark.parametrize("method,path,payload", [
    ("post", "/api/collections", {"title": "New"}),
    ("patch", "/api/collections/default", {"title": "Renamed"}),
    ("delete", "/api/collections/default", None),
    ("post", "/api/collections/default/restore", None),
    ("post", "/api/projects/one/restore", None),
])
def test_failed_mutation_rolls_back_every_metadata_field(workspace, monkeypatch, method, path, payload):
    client, store = workspace
    if path == "/api/collections/default/restore":
        store.data["collections"]["default"].update(deleted=True, deleted_at="old")
    if path == "/api/projects/one/restore":
        store.data["inputs"]["one"].update(deleted=True, deleted_at="old")
    before = copy.deepcopy(store.data)
    persisted = (store.root / "index.json").read_bytes()
    def fail():
        assert store.lock.locked()
        raise OSError("Disk full with private detail")
    monkeypatch.setattr(store, "save", fail)
    response = getattr(client, method)(path, **({"json": payload} if payload is not None else {}))
    assert response.status_code == 500 and "private detail" not in response.text
    assert store.data == before
    assert (store.root / "index.json").read_bytes() == persisted


def test_migration_save_failure_restores_original_data(tmp_path, monkeypatch):
    store = FakeStore(tmp_path)
    before = copy.deepcopy(store.data)
    monkeypatch.setattr(store, "save", lambda: (_ for _ in ()).throw(OSError("Disk full")))
    with pytest.raises(HTTPException) as context:
        ensure_collections(store)
    assert context.value.status_code == 500
    assert store.data == before


def test_unknown_ids_are_404(workspace):
    client, _ = workspace
    assert client.delete("/api/collections/missing").status_code == 404
    assert client.patch("/api/collections/missing", json={"title": "Missing"}).status_code == 404
    assert client.post("/api/collections/missing/restore").status_code == 404
    assert client.post("/api/projects/missing/restore").status_code == 404
