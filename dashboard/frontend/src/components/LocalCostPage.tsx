function LocalCostPage() {
  return (
    <section className="flex-1 p-6 text-[var(--on-surface)]" aria-label="Azure usage and costs">
      <div className="max-w-3xl rounded-[var(--radius-lg)] bg-[var(--surface-container-low)] p-6">
        <h2 className="text-lg font-semibold">Azure usage &amp; costs</h2>
        <p className="mt-2 text-sm text-[var(--on-surface-muted)]">
          Azure bills usage through your subscription. This local dashboard does not calculate an Azure invoice or a per-run dollar estimate.
        </p>
        <dl className="mt-6 space-y-5 text-sm">
          <div>
            <dt className="font-semibold">Scene understanding &amp; narration</dt>
            <dd className="mt-1 text-[var(--on-surface-muted)]">Azure OpenAI charges for the deployed model’s text and image input tokens and generated output tokens.</dd>
          </div>
          <div>
            <dt className="font-semibold">Dialogue transcription &amp; English voice</dt>
            <dd className="mt-1 text-[var(--on-surface-muted)]">Azure Speech Fast Transcription and Neural TTS are billed according to your region, tier and usage. Chinese and English narration voices are selected in each video project.</dd>
          </div>
          <div>
            <dt className="font-semibold">Video processing</dt>
            <dd className="mt-1 text-[var(--on-surface-muted)]">FFmpeg and FFprobe run on this computer for frame extraction, audio timing, mixing and MP4 export. These local operations do not incur a cloud processing charge.</dd>
          </div>
        </dl>
        <p className="mt-6 text-sm text-[var(--on-surface-muted)]">Check Azure Cost Management and your resource’s usage metrics for actual charges.</p>
      </div>
    </section>
  );
}

export default LocalCostPage;
