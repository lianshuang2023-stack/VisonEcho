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

/** Reserve an upload, then stream the file with byte-level progress. */
export async function uploadVideo(
  file: File,
  onProgress?: (percent: number) => void,
  collectionId?: string,
): Promise<{ key: string }> {
  const reservation = await requestJson<{ url: string; key: string }>('/trigger/upload', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, ...(collectionId ? { collection_id: collectionId } : {}) }),
  });
  if (!reservation || typeof reservation.url !== 'string' || !/^\/api\/uploads\/[A-Za-z0-9_-]+$/.test(reservation.url) || typeof reservation.key !== 'string') {
    throw new Error('The backend did not return a valid local upload URL.');
  }

  await new Promise<void>((resolve, reject) => {
    const upload = new XMLHttpRequest();
    upload.open('PUT', reservation.url);
    upload.timeout = UPLOAD_TIMEOUT_MS;
    upload.setRequestHeader('Content-Type', 'video/mp4');
    upload.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(100, Math.max(0, Math.round(event.loaded / event.total * 100))));
      }
    };
    upload.onload = () => {
      if (upload.status >= 200 && upload.status < 300) {
        resolve();
        return;
      }
      let body: unknown = null;
      try { body = JSON.parse(upload.responseText); } catch { /* Non-JSON server failures retain their status. */ }
      reject(new Error(serverMessage(body, `Upload failed (${upload.status}). Please try again.`)));
    };
    upload.onerror = () => reject(new Error('Upload failed. Check that the backend is running.'));
    upload.ontimeout = () => reject(new Error('Upload timed out. Please try again.'));
    upload.onabort = () => reject(new Error('Upload cancelled.'));
    upload.send(file);
  });
  return { key: reservation.key };
}
