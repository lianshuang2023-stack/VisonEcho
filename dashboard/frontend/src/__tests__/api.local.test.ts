import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBackendHealth, fetchExecutionStatus, fetchInputVideoUrl, requestJson, uploadVideo } from '../api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function reply(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mockUpload(event: 'load' | 'error' | 'timeout' | 'abort' = 'load', status = 200, responseText = '') {
  const open = vi.fn();
  const setRequestHeader = vi.fn();
  const sent = vi.fn();
  const requests: UploadRequest[] = [];
  class UploadRequest {
    timeout = 0;
    status = status;
    responseText = responseText;
    upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open = open;
    setRequestHeader = setRequestHeader;
    constructor() { requests.push(this); }
    send(file: File) {
      sent(file);
      this.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
      this.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
      this[`on${event}`]?.();
    }
  }
  vi.stubGlobal('XMLHttpRequest', UploadRequest);
  return { open, setRequestHeader, sent, requests };
}

function mockChunks(outcomes: ({ event?: 'load' | 'error' | 'timeout' | 'abort'; status?: number; body?: string })[] = [], manual = false) {
  const instances: ChunkRequest[] = [];
  class ChunkRequest {
    timeout = 0;
    status = 200;
    responseText = '';
    url = '';
    data: Blob | null = null;
    upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() { instances.push(this); }
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader() {}
    send(data: Blob) { this.data = data; if (!manual) this.finish(); }
    finish() {
      const outcome = outcomes[instances.indexOf(this)] ?? {};
      this.status = outcome.status ?? 200; this.responseText = outcome.body ?? '';
      this.upload.onprogress?.({ lengthComputable: true, loaded: this.data!.size, total: this.data!.size });
      this['on' + (outcome.event ?? 'load') as 'onload']?.();
    }
  }
  vi.stubGlobal('XMLHttpRequest', ChunkRequest);
  return instances;
}

function chunkReservation(chunkSize = 8 * 1024 * 1024) {
  return { url: '/api/uploads/token', key: 'input/demo.mp4', chunk_size: chunkSize, chunk_url: '/api/uploads/token/chunks/{index}', complete_url: '/api/uploads/token/complete' };
}

describe('VisionEcho service transport', () => {
  it('loads source media and generation status with encoded IDs and no token header', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ url: '/api/media/input/demo' }))
      .mockResolvedValueOnce(reply({ execution_arn: 'job/1', status: 'RUNNING' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchInputVideoUrl('video/1')).toBe('/api/media/input/demo');
    expect(await fetchExecutionStatus('job/1')).toEqual({ execution_arn: 'job/1', status: 'RUNNING' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/trigger/videos/video%2F1/url', '/api/trigger/executions/job%2F1/status',
    ]);
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers.get('Authorization')).toBeNull();
    expect(options.headers.get('Content-Type')).toBeNull();
    expect(options.cache).toBe('no-store');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves a caller cancellation signal and header while sending JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ saved: true }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await requestJson('/projects/demo', {
      method: 'PATCH', body: JSON.stringify({ title: 'Demo' }), signal: controller.signal,
      headers: new Headers({ 'X-Request-ID': 'request-1' }),
    });
    const options = fetchMock.mock.calls[0][1];
    expect(options.signal).toBe(controller.signal);
    expect(options.headers.get('X-Request-ID')).toBe('request-1');
    expect(options.headers.get('Content-Type')).toBe('application/json');
    expect(options.headers.get('Accept')).toBe('application/json');
  });

  it.each([{ error: 'Video was deleted.' }, { detail: 'Video was deleted.' }])('surfaces service errors without retrying a mutation', async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(reply(body, 409));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestJson('/projects/demo', { method: 'DELETE' })).rejects.toThrow('Video was deleted.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retains the HTTP status when a proxy returns non-JSON content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError(); } }));
    await expect(fetchExecutionStatus('job-1')).rejects.toThrow('Request failed (502)');
  });

  it('reports a backend mismatch instead of exposing a JSON parser failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError(); } }));
    await expect(fetchInputVideoUrl('video-1')).rejects.toThrow('invalid response');
  });

  it('validates configuration health, including an unconfigured but reachable service', async () => {
    const health = { status: 'ok', provider: 'azure', configured: false, issues: ['Set the Speech endpoint.'] };
    const fetchMock = vi.fn().mockResolvedValue(reply(health));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchBackendHealth()).toEqual(health);
    fetchMock.mockResolvedValueOnce(reply({ status: 'ok' }));
    await expect(fetchBackendHealth()).rejects.toThrow('valid configuration status');
    fetchMock.mockResolvedValueOnce(reply(null));
    await expect(fetchBackendHealth()).rejects.toThrow('valid configuration status');
  });
});

describe('VisionEcho video uploads', () => {
  it('transfers chunks sequentially below the gateway limit and finishes before reporting 100%', async () => {
    const reservation = chunkReservation();
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(reservation)).mockResolvedValueOnce(reply({ key: reservation.key }));
    vi.stubGlobal('fetch', fetchMock);
    const chunks = mockChunks([], true);
    const progress = vi.fn();
    const file = new File([new Uint8Array(9 * 1024 * 1024)], 'large.mp4');
    const result = uploadVideo(file, progress);
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    expect(chunks[0].data?.size).toBe(8 * 1024 * 1024);
    expect(fetchMock).toHaveBeenCalledOnce();
    chunks[0].finish();
    await vi.waitFor(() => expect(chunks).toHaveLength(2));
    expect(chunks[1].data?.size).toBe(1024 * 1024);
    expect(chunks.map(chunk => chunk.url)).toEqual(['/api/uploads/token/chunks/0', '/api/uploads/token/chunks/1']);
    expect(progress).not.toHaveBeenCalledWith(100);
    chunks[1].finish();
    await expect(result).resolves.toEqual({ key: reservation.key });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/uploads/token/complete');
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([...progress.mock.calls.map(([value]) => value)].sort((a, b) => a - b));
  });

  it('retries the same idempotent chunk on network and server errors without reserving another upload', async () => {
    const reservation = chunkReservation(4);
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(reservation)).mockResolvedValueOnce(reply({ key: reservation.key }));
    vi.stubGlobal('fetch', fetchMock);
    const chunks = mockChunks([{ event: 'error' }, { status: 503 }, {}]);
    await expect(uploadVideo(new File(['data'], 'demo.mp4'))).resolves.toEqual({ key: reservation.key });
    expect(chunks).toHaveLength(3);
    expect(chunks.every(chunk => chunk.url === '/api/uploads/token/chunks/0')).toBe(true);
    expect(chunks[0].data).toBe(chunks[1].data);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds chunk retries and does not complete an unfinished upload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(chunkReservation(4)));
    vi.stubGlobal('fetch', fetchMock);
    const chunks = mockChunks([{ status: 503 }, { status: 503 }, { status: 503 }]);
    await expect(uploadVideo(new File(['data'], 'demo.mp4'))).rejects.toThrow('503');
    expect(chunks).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([401, 409])('does not retry terminal status %s and notifies only expired sessions', async (status) => {
    const expired = vi.fn(); window.addEventListener('visionecho-access-expired', expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(chunkReservation(4))));
    const chunks = mockChunks([{ status, body: JSON.stringify({ detail: 'Upload cannot continue.' }) }]);
    await expect(uploadVideo(new File(['data'], 'demo.mp4'))).rejects.toThrow('Upload cannot continue.');
    expect(chunks).toHaveLength(1); expect(expired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    window.removeEventListener('visionecho-access-expired', expired);
  });

  it('keeps progress below completion if final media validation fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(chunkReservation(4))).mockResolvedValueOnce(reply({ detail: 'Video duration exceeds the limit.' }, 422));
    vi.stubGlobal('fetch', fetchMock); mockChunks();
    const progress = vi.fn();
    await expect(uploadVideo(new File(['data'], 'demo.mp4'), progress)).rejects.toThrow('Video duration exceeds the limit.');
    expect(progress).not.toHaveBeenCalledWith(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { chunk_size: 9 * 1024 * 1024 },
    { chunk_url: 'https://example.com/chunks/{index}' },
    { chunk_url: '/api/uploads/other/chunks/{index}' },
    { complete_url: '/api/uploads/other/complete' },
    { chunk_size: 0 },
  ])('rejects unsafe or invalid chunk metadata before sending video bytes', async (patch) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...chunkReservation(), ...patch })));
    const chunks = mockChunks();
    await expect(uploadVideo(new File(['data'], 'demo.mp4'))).rejects.toThrow('valid local chunk upload URLs');
    expect(chunks).toHaveLength(0);
  });

  it.each([undefined, 'collection-2'])('reserves and streams a video for collection %s', async (collectionId) => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ url: '/api/uploads/token-1', key: 'input/demo.mp4' }));
    vi.stubGlobal('fetch', fetchMock);
    const upload = mockUpload();
    const progress = vi.fn();
    const file = new File(['video'], 'demo.mp4', { type: 'video/mp4' });
    expect(await uploadVideo(file, progress, collectionId)).toEqual({ key: 'input/demo.mp4' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ filename: 'demo.mp4', size_bytes: file.size, ...(collectionId ? { collection_id: collectionId } : {}) });
    expect(upload.open).toHaveBeenCalledWith('PUT', '/api/uploads/token-1');
    expect(upload.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'video/mp4');
    expect(upload.sent).toHaveBeenCalledWith(file);
    expect(upload.requests[0].timeout).toBeGreaterThan(0);
    expect(progress).toHaveBeenCalledExactlyOnceWith(25);
  });

  it('does not upload the file when the collection reservation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ error: 'Project no longer exists.' }, 404)));
    const upload = mockUpload();
    await expect(uploadVideo(new File(['video'], 'demo.mp4'))).rejects.toThrow('Project no longer exists.');
    expect(upload.requests).toHaveLength(0);
  });

  it.each(['https://example.com/upload', '//example.com/upload', '/api/uploads/token?redirect=1', '/api/uploads/..', '/api/projects/demo'])('rejects an unexpected upload destination: %s', async (url) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ url, key: 'input/demo.mp4' })));
    const upload = mockUpload();
    await expect(uploadVideo(new File(['video'], 'demo.mp4'))).rejects.toThrow('valid local upload URL');
    expect(upload.requests).toHaveLength(0);
  });

  it.each([{ error: 'Video exceeds the upload limit.' }, { detail: 'Video exceeds the upload limit.' }])('keeps the backend validation error after transfer', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ url: '/api/uploads/token', key: 'input/demo.mp4' })));
    mockUpload('load', 413, JSON.stringify(body));
    await expect(uploadVideo(new File(['video'], 'demo.mp4'))).rejects.toThrow('Video exceeds the upload limit.');
  });

  it.each([['error', 'Upload failed'], ['timeout', 'Upload timed out'], ['abort', 'Upload cancelled']] as const)('settles a failed %s transfer instead of leaving the UI pending', async (event, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ url: '/api/uploads/token', key: 'input/demo.mp4' })));
    mockUpload(event);
    await expect(uploadVideo(new File(['video'], 'demo.mp4'))).rejects.toThrow(message);
  });
});
