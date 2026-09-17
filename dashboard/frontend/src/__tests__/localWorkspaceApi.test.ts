import { afterEach, describe, expect, it, vi } from 'vitest';
import { calibrateTranscript, createCollection, deleteCollection, deleteVideo, generateNarration, getTranscriptCalibration, listHistoryVideos, listProjects, patchProject, renderNarration, restoreCollection, restoreVideo, setVideoReview } from '../localWorkspaceApi';

afterEach(() => vi.unstubAllGlobals());

function mockRequest() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('VisionEcho video API requests', () => {
  it('loads all untrashed active and archived history across projects without duplicate videos', async () => {
    const fetchMock = mockRequest();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [{ video_id: 'a' }, { video_id: 'b' }] }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [{ video_id: 'b', archived: true }] }) });
    const history = await listHistoryVideos();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/projects?status=all', '/api/projects?status=archived']);
    expect(history).toEqual([{ video_id: 'a' }, { video_id: 'b', archived: true }]);
  });

  it('does not pass a partial history off as the full history when one list fails', async () => {
    const fetchMock = mockRequest();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [{ video_id: 'a' }] }) });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: '归档读取失败' }) });
    await expect(listHistoryVideos()).rejects.toThrow('归档读取失败');
  });
  it('creates a named project independently and scopes its video list by collection', async () => {
    const fetchMock = mockRequest();
    await createCollection('旅行记录');
    await listProjects(true, 'collection-2');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/collections');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ title: '旅行记录' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects?status=archived&collection_id=collection-2');
  });

  it('uses independent recoverable deletion routes for projects and videos', async () => {
    const fetchMock = mockRequest();
    await deleteCollection('collection-2');
    await deleteVideo('video-1');
    await restoreCollection('collection-2');
    await restoreVideo('video-1');
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/api/collections/collection-2', 'DELETE'],
      ['/api/projects/video-1', 'DELETE'],
      ['/api/collections/collection-2/restore', 'POST'],
      ['/api/projects/video-1/restore', 'POST'],
    ]);
  });

  it('moves a work without rewriting its title or archive state', async () => {
    const fetchMock = mockRequest();
    await patchProject('video-1', { collection_id: 'collection-2' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/video-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ collection_id: 'collection-2' });
  });

  it('reviews a specific transcript revision and returns the authoritative review state', async () => {
    const fetchMock = mockRequest();
    const result = { reviewed: true, reviewed_at: '2026-09-16T00:00:00Z', transcript_revision: 3 };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => result });
    expect(await setVideoReview('job-1', true, 3)).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/videos/job-1/review');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reviewed: true, transcript_revision: 3 });
  });

  it('sends language and voice without a user-specified silence threshold', async () => {
    const fetchMock = mockRequest();
    await generateNarration('video-1', 'zh-CN', 'zh-CN-YunxiNeural');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/trigger/executions');
    expect(JSON.parse(init.body)).toEqual({ video_id: 'video-1', language: 'zh-CN', dialogue_language: 'auto', voice: 'zh-CN-YunxiNeural' });
  });

  it('changes the voice while sending only editable narration text fields', async () => {
    const fetchMock = mockRequest();
    await renderNarration('job-1', [{ segment_index: 2, dvi_text: 'A boat sails.', start_time: 1, end_time: 5, silence_duration: 4, audio_duration: 3, pass: true }], 'en-US-GuyNeural');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/videos/job-1/render');
    expect(JSON.parse(init.body)).toEqual({ segments: [{ segment_index: 2, dvi_text: 'A boat sails.' }], voice: 'en-US-GuyNeural' });
  });

  it('recognizes English dialogue while generating a Chinese narration', async () => {
    const fetchMock = mockRequest();
    await generateNarration('video-1', 'zh-CN', 'zh-CN-YunxiNeural', 'auto', 'en-US');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      video_id: 'video-1', language: 'zh-CN', dialogue_language: 'en-US', voice: 'zh-CN-YunxiNeural', narration_mode: 'auto',
    });
    await calibrateTranscript('job-1', 'auto', 0);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ language: 'auto', revision: 0 });
  });

  it('calibrates a known transcript revision and polls the returned task', async () => {
    const fetchMock = mockRequest();
    await calibrateTranscript('job-1', 'zh-CN', 4);
    await getTranscriptCalibration('cal-1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/videos/job-1/transcript/calibrate');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ language: 'zh-CN', revision: 4 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/transcript-calibrations/cal-1');
  });
});
