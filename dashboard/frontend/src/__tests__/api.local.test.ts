import { afterEach, describe, expect, it, vi } from "vitest";

const { getIdToken } = vi.hoisted(() => ({ getIdToken: vi.fn() }));
vi.mock("../auth", () => ({ getIdToken }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.resetModules();
});

describe("local backend authentication boundary", () => {
  it("calls the local API without loading a Cognito token", async () => {
    vi.stubEnv("VITE_LOCAL_BACKEND", "true");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ videos: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchInputVideos } = await import("../api");
    await expect(fetchInputVideos()).resolves.toEqual([]);
    expect(getIdToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/trigger/videos", { headers: {} });
  });

  it.each([undefined, "false", "TRUE", "1"])("requires Cognito when the local flag is %s", async (value) => {
    vi.stubEnv("VITE_LOCAL_BACKEND", value);
    getIdToken.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchInputVideos } = await import("../api");
    await expect(fetchInputVideos()).rejects.toThrow("Not authenticated");
    expect(getIdToken).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the AWS ID-token header outside local mode", async () => {
    vi.stubEnv("VITE_LOCAL_BACKEND", "false");
    getIdToken.mockResolvedValue("cognito-id-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ videos: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchInputVideos } = await import("../api");
    await fetchInputVideos();
    expect(fetchMock).toHaveBeenCalledWith("/api/trigger/videos", {
      headers: { Authorization: "cognito-id-token" },
    });
  });

  it.each([undefined, "collection-2"])("uploads an MP4 to a backend-provided relative PUT URL for collection %s", async (collectionId) => {
    vi.stubEnv("VITE_LOCAL_BACKEND", "true");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "/api/uploads/test.mp4", key: "input/test.mp4" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.fn();
    const setRequestHeader = vi.fn();
    const send = vi.fn();
    class UploadRequest {
      status = 200;
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      open = open;
      setRequestHeader = setRequestHeader;
      send(file: File) { send(file); this.onload?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    const { uploadVideo } = await import("../api");
    const file = new File(["video"], "test.mp4", { type: "video/mp4" });
    await expect(uploadVideo(file, undefined, collectionId)).resolves.toEqual({ key: "input/test.mp4" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ filename: "test.mp4", ...(collectionId ? { collection_id: collectionId } : {}) });
    expect(open).toHaveBeenCalledWith("PUT", "/api/uploads/test.mp4");
    expect(setRequestHeader).toHaveBeenCalledWith("Content-Type", "video/mp4");
    expect(send).toHaveBeenCalledWith(file);
    expect(getIdToken).not.toHaveBeenCalled();
  });
});
