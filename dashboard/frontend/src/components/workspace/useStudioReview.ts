import { useCallback, useEffect, useRef, useState } from 'react';
import { getStudioReview, updateStudioReview } from '../../localWorkspaceApi';
import type { SegmentReviewState, StudioReviewDocument } from '../../localWorkspaceApi';

export function useStudioReview(jobId: string, refreshKey: number | string) {
  const [review, setReview] = useState<StudioReviewDocument | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const identity = useRef(0);
  const current = useRef(jobId);
  const updating = useRef(false);
  useEffect(() => { const requests = identity; current.current = jobId; return () => { requests.current++; }; }, [jobId]);
  const refresh = useCallback(async () => {
    if (updating.current) return;
    if (!jobId) { setReview(null); setError(''); return; }
    const request = ++identity.current; setLoading(true);
    try { const next = await getStudioReview(jobId); if (request === identity.current) { setReview(next); setError(''); } }
    catch (reason) { if (request === identity.current) setError(reason instanceof Error ? reason.message : 'Review status unavailable.'); }
    finally { if (request === identity.current) setLoading(false); }
  }, [jobId]);
  useEffect(() => { setReview(null); void refresh(); }, [refresh, refreshKey]);
  async function update(index: number, state: SegmentReviewState) {
    if (!review || saving || loading || updating.current || !jobId) return;
    updating.current = true;
    const request = ++identity.current; setSaving(true); setError('');
    try { const next = await updateStudioReview(jobId, review, [{ segment_index: index, state }]); if (request === identity.current) setReview(next); }
    catch (reason) { if (request === identity.current) setError(reason instanceof Error ? reason.message : 'Could not save approval.'); throw reason; }
    finally { updating.current = false; if (current.current === jobId) setSaving(false); }
  }
  return { review, error, loading, saving, refresh, update };
}
