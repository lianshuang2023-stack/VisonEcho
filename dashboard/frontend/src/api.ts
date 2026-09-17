import type { BackendHealth, ExecutionStatus } from './types';

const API_ROOT = '/api';
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

function serverMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const value = body as Record<string, unknown>;
    for (const field of ['error', 'detail']) {
      if (typeof value[field] === 'string' && value[field].trim()) return value[field];
    }
  }
  return fallback;
}

/** Same-origin JSON transport for the VisionEcho service. Mutations are never retried. */
export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(API_ROOT + path, {
    ...options,
    headers,
    cache: options.cache ?? 'no-store',
    signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('visionecho-access-expired'));
    const body: unknown = await response.json().catch(() => null);
    throw new Error(serverMessage(body, `Request failed (${response.status}). Please try again.`));
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error('The service returned an invalid response. Check that the backend is running.');
  }
}

export async function fetchBackendHealth(): Promise<BackendHealth> {
  const health = await requestJson<BackendHealth>('/health', { signal: AbortSignal.timeout(10_000) });
  if (!health || health.status !== 'ok' || health.provider !== 'azure' || typeof health.configured !== 'boolean' || !Array.isArray(health.issues)) {
    throw new Error('The backend did not return a valid configuration status.');
  }
  return health;
}

export async function fetchInputVideoUrl(videoId: string): Promise<string> {
  const result = await requestJson<{ url: string }>(`/trigger/videos/${encodeURIComponent(videoId)}/url`);
  return result.url;
}

export function fetchExecutionStatus(jobId: string): Promise<ExecutionStatus> {
  return requestJson(`/trigger/executions/${encodeURIComponent(jobId)}/status`);
}

interface UploadReservation {
  url: string;
  key: string;
  chunk_size?: number;
  chunk_url?: string;
  complete_url?: string;
}

class UploadTransferError extends Error {
  retryable: boolean;
  constructor(message: string, retryable = false) { super(message); this.retryable = retryable; }
}

function transferUpload(url: string, data: Blob, chunked: boolean, progress?: (loaded: number, total: number) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const upload = new XMLHttpRequest();
    upload.open('PUT', url);
    upload.timeout = chunked ? 120_000 : UPLOAD_TIMEOUT_MS;
    upload.setRequestHeader('Content-Type', chunked ? 'application/octet-stream' : 'video/mp4');
    upload.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) progress?.(event.loaded, event.total);
    };
    upload.onload = () => {
      if (upload.status >= 200 && upload.status < 300) { resolve(); return; }
      if (upload.status === 401) window.dispatchEvent(new Event('visionecho-access-expired'));
      let body: unknown = null;
      try { body = JSON.parse(upload.responseText); } catch { /* Retain the status for non-JSON failures. */ }
      reject(new UploadTransferError(serverMessage(body, 'Upload failed (' + upload.status + '). Please try again.'), upload.status >= 500 && upload.status < 600));
    };
    upload.onerror = () => reject(new UploadTransferError('Upload failed. Check the connection and try again.', true));
    upload.ontimeout = () => reject(new UploadTransferError('Upload timed out. Please try again.'));
    upload.onabort = () => reject(new UploadTransferError('Upload cancelled.'));
    upload.send(data);
  });
}

/** Upload bounded sequential chunks when supported, retaining the legacy transfer contract. */
export async function uploadVideo(
  file: File,
  onProgress?: (percent: number) => void,
  collectionId?: string,
): Promise<{ key: string }> {
  const reservation = await requestJson<UploadReservation>('/trigger/upload', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, size_bytes: file.size, ...(collectionId ? { collection_id: collectionId } : {}) }),
  });
  if (!reservation || typeof reservation.url !== 'string' || !/^\/api\/uploads\/[A-Za-z0-9_-]+$/.test(reservation.url) || typeof reservation.key !== 'string' || !reservation.key) {
    throw new Error('The backend did not return a valid local upload URL.');
  }
  const chunked = reservation.chunk_size !== undefined || reservation.chunk_url !== undefined || reservation.complete_url !== undefined;
  if (!chunked) {
    await transferUpload(reservation.url, file, false, (loaded, total) => onProgress?.(Math.min(100, Math.max(0, Math.round(loaded / total * 100)))));
    return { key: reservation.key };
  }
  const chunkSize = reservation.chunk_size;
  if (typeof chunkSize !== 'number' || !Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > 8 * 1024 * 1024 || reservation.chunk_url !== reservation.url + '/chunks/{index}' || reservation.complete_url !== reservation.url + '/complete') {
    throw new Error('The backend did not return valid local chunk upload URLs.');
  }
  let reported = 0;
  const report = (bytes: number, complete = false) => {
    const percent = complete ? 100 : Math.min(99, Math.floor(bytes / Math.max(1, file.size) * 100));
    reported = Math.max(reported, percent);
    onProgress?.(reported);
  };
  for (let offset = 0, index = 0; offset < file.size; offset += chunkSize, index++) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
    const url = reservation.chunk_url.replace('{index}', String(index));
    for (let attempt = 0; ; attempt++) {
      try {
        await transferUpload(url, chunk, true, (loaded, total) => report(offset + Math.min(chunk.size, chunk.size * loaded / total)));
        break;
      } catch (reason) {
        if (!(reason instanceof UploadTransferError) || !reason.retryable || attempt >= 2) throw reason;
        await new Promise<void>(resolve => window.setTimeout(resolve, (attempt + 1) * 250));
      }
    }
    report(offset + chunk.size);
  }
  const result = await requestJson<{ key: string }>(reservation.complete_url.slice(API_ROOT.length), { method: 'POST', body: '{}' });
  if (!result || result.key !== reservation.key) throw new Error('The backend returned an unexpected upload result. Reload the video list before retrying.');
  report(file.size, true);
  return result;
}
