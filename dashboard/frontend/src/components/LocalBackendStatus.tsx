import { useCallback, useEffect, useState } from "react";
import { fetchBackendHealth } from "../api";
import type { BackendHealth } from "../types";
import { Button } from "./ui/button";

interface LocalBackendStatusProps {
  onReadyChange: (ready: boolean) => void;
}

function LocalBackendStatus({ onReadyChange }: LocalBackendStatusProps) {
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkCount, setCheckCount] = useState(0);

  useEffect(() => {
    let active = true;
    fetchBackendHealth()
      .then((data) => {
        if (!active) return;
        setHealth(data);
        onReadyChange(data.configured && data.speech_region_configured);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unable to reach the local backend.");
        onReadyChange(false);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [checkCount, onReadyChange]);

  const recheck = useCallback(() => {
    setLoading(true);
    setError(null);
    setHealth(null);
    onReadyChange(false);
    setCheckCount((value) => value + 1);
  }, [onReadyChange]);

  const ready = !error && health?.configured && health.speech_region_configured;
  const issues = health?.issues ?? [];

  return (
    <section
      aria-label="Local backend configuration"
      aria-live="polite"
      className="mx-4 my-3 rounded-[var(--radius-md)] border border-[var(--ghost-border)] bg-[var(--surface-container-low)] px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`font-semibold ${ready ? "text-[var(--success)]" : "text-[var(--on-surface)]"}`}>
          {loading ? "Checking local backend…" : ready ? "Azure configuration ready" : "Processing unavailable — setup required"}
        </p>
        <Button size="sm" variant="outline" disabled={loading} onClick={recheck}>
          Recheck configuration
        </Button>
      </div>
      {health && (
        <p className="mt-1 text-[var(--on-surface-muted)]">
          Model: {health.model || "Not configured"} · Speech endpoint: {health.speech_region_configured ? "Configured" : "Missing"} · FFmpeg runs locally
        </p>
      )}
      {error && <p className="mt-2 text-[var(--error)]">{error}</p>}
      {health?.max_upload_mb !== undefined && health.max_video_seconds !== undefined && (
        <p className="mt-1 text-xs text-[var(--on-surface-muted)]">
          Upload limit: {health.max_upload_mb} MB · Maximum video length: {health.max_video_seconds / 60} minutes · MP4
        </p>
      )}
      {issues.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--error)]">
          {issues.map((issue, index) => <li key={index}>{issue}</li>)}
        </ul>
      )}
      {!loading && !ready && !error && issues.length === 0 && (
        <p className="mt-2 text-[var(--error)]">
          Configure the Azure OpenAI deployment, Azure Speech credentials and region or endpoint in the backend environment, then recheck.
        </p>
      )}
      <p className="mt-2 text-xs text-[var(--on-surface-muted)]">
        {ready ? "Configuration presence checked; service access is verified when processing. " : "Uploads and existing results remain available while setup is incomplete. "}
        Credentials stay on the local backend.
      </p>
    </section>
  );
}

export default LocalBackendStatus;
