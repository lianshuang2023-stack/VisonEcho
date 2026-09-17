import { getIdToken } from "./auth";
import { IS_LOCAL_BACKEND } from "./config";
import type {
  VideoEntry,
  DviSegment,
  ProcessingSummary,
  InputVideo,
  ExecutionStatus,
  ExecutionListItem,
  CostReport,
  BackendHealth,
} from "./types";

const API_BASE = "/api";

async function authHeaders(): Promise<Record<string, string>> {
  if (IS_LOCAL_BACKEND) return {};
  const token = await getIdToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  return {
    Authorization: token,
  };
}

export async function fetchBackendHealth(): Promise<BackendHealth> {
  if (!IS_LOCAL_BACKEND) throw new Error("Local backend mode is not enabled");
  const res = await fetch(`${API_BASE}/health`, {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("The local backend is not responding. Start the backend on port 8000, then recheck.");
  const data = await res.json();
  if (data.status !== "ok" || data.provider !== "azure") {
    throw new Error("The local backend did not return a valid Azure configuration status.");
  }
  return data;
}

export async function fetchVideos(): Promise<VideoEntry[]> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/videos`, { headers });
  if (!res.ok) throw new Error("Failed to fetch videos");
  const data = await res.json();
  return data.videos;
}

export async function fetchVideoUrl(key: string): Promise<string> {
  const headers = await authHeaders();
  const encodedKey = encodeURIComponent(key);
  const res = await fetch(`${API_BASE}/videos/${encodedKey}/url`, { headers });
  if (!res.ok) throw new Error("Failed to fetch video URL");
  const data = await res.json();
  return data.url;
}

export async function fetchSegments(videoId: string): Promise<DviSegment[]> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/videos/${videoId}/segments`, { headers });
  if (!res.ok) throw new Error("Failed to fetch segments");
  const data = await res.json();
  return data.segments;
}

export async function fetchSummary(
  videoId: string,
): Promise<ProcessingSummary | null> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/videos/${videoId}/summary`, { headers });
  if (!res.ok) throw new Error("Failed to fetch summary");
  const data = await res.json();
  return data.summary === null ? null : data;
}

export async function fetchInputVideos(): Promise<InputVideo[]> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/trigger/videos`, { headers });
  if (!res.ok) throw new Error("Failed to fetch input videos");
  const data = await res.json();
  return data.videos;
}

export async function fetchInputVideoUrl(videoId: string): Promise<string> {
  const headers = await authHeaders();
  const res = await fetch(
    `${API_BASE}/trigger/videos/${encodeURIComponent(videoId)}/url`,
    { headers },
  );
  if (!res.ok) throw new Error("Failed to fetch input video URL");
  const data = await res.json();
  return data.url;
}

export async function uploadVideo(
  file: File,
  onProgress?: (percent: number) => void,
  collectionId?: string,
): Promise<{ key: string }> {
  const headers = await authHeaders();
  // Get an upload URL from the selected backend.
  const res = await fetch(`${API_BASE}/trigger/upload`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, ...(IS_LOCAL_BACKEND && collectionId ? { collection_id: collectionId } : {}) }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to get upload URL");
  }
  const { url, key } = await res.json();

  // Accept either an S3 presigned URL or a same-origin /api/ local upload URL.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "video/mp4");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let message = `Upload failed with status ${xhr.status}`;
        if (IS_LOCAL_BACKEND) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (typeof data.error === "string") message = data.error;
          } catch { /* Preserve the status for non-JSON server failures. */ }
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });

  return { key };
}

export async function startExecution(
  videoId: string,
  minSilenceDuration?: number,
): Promise<{ execution_arn: string; start_date: string }> {
  const headers = await authHeaders();
  const body: Record<string, unknown> = { video_id: videoId };
  if (minSilenceDuration !== undefined) {
    body.min_silence_duration = minSilenceDuration;
  }
  const res = await fetch(`${API_BASE}/trigger/executions`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to start execution");
  }
  return res.json();
}

export async function fetchExecutionStatus(
  arn: string,
): Promise<ExecutionStatus> {
  const headers = await authHeaders();
  const res = await fetch(
    `${API_BASE}/trigger/executions/${encodeURIComponent(arn)}/status`,
    { headers },
  );
  if (!res.ok) throw new Error("Failed to fetch execution status");
  return res.json();
}

export async function fetchExecutions(
  videoId: string,
): Promise<ExecutionListItem[]> {
  const headers = await authHeaders();
  const res = await fetch(
    `${API_BASE}/cost/executions?video_id=${encodeURIComponent(videoId)}`,
    { headers },
  );
  if (!res.ok) throw new Error("Failed to fetch executions");
  const data = await res.json();
  return data.executions;
}

export async function fetchCostReport(
  executionArn: string,
): Promise<CostReport> {
  const headers = await authHeaders();
  const res = await fetch(
    `${API_BASE}/cost/executions/${encodeURIComponent(executionArn)}/cost`,
    { headers },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to fetch cost report");
  }
  return res.json();
}
