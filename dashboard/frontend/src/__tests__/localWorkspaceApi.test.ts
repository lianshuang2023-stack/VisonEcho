import { afterEach, describe, expect, it, vi } from 'vitest';
import { calibrateTranscript, createCollection, deleteCollection, deleteVideo, exportUrl, generateNarration, getTranscriptCalibration, listHistoryVideos, listProjects, outputUrl, patchProject, renderNarration, restoreCollection, restoreVideo, saveTranscript } from '../localWorkspaceApi';

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

  it('saves only editable subtitle fields and the revision used for conflict detection', async () => {
    const fetchMock = mockRequest();
    const result = { cues: [{ id: 'cue-1', start: 1, end: 2, text: 'Hello' }], revision: 4 };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => result });
    expect(await saveTranscript('job/1', { ...result, revision: 3, quality: { review_required: true } })).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/videos/job%2F1/transcript');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ cues: result.cues, revision: 3 });
  });

  it('preserves a subtitle conflict instead of treating the save as successful', async () => {
    const fetchMock = mockRequest();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ detail: 'Subtitles changed. Reload this version.' }) });
    await expect(saveTranscript('job-1', { cues: [], revision: 1 })).rejects.toThrow('Subtitles changed. Reload this version.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('encodes project filters and version download paths', async () => {
    const fetchMock = mockRequest();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) });
    await listProjects(false, 'Travel & 2026');
    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('collection_id')).toBe('Travel & 2026');
    expect(url.searchParams.get('status')).toBe('all');
    expect(exportUrl('job/1', 'dialogue', 'srt')).toBe('/api/videos/job%2F1/export?kind=dialogue&format=srt');
    expect(outputUrl('job/1')).toBe('/api/media/output/job%2F1');
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
