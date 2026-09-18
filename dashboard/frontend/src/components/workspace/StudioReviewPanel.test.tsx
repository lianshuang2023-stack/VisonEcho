import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudioReviewPanel from './StudioReviewPanel';
import type { NarrationSegment, StudioReviewDocument } from '../../localWorkspaceApi';

const mocks = vi.hoisted(() => ({ rewriteSegment: vi.fn(), evidenceUnmount: vi.fn() }));
vi.mock('../../localWorkspaceApi', () => ({ rewriteSegment: mocks.rewriteSegment }));
vi.mock('./EvidencePanel', () => ({ default: function EvidenceDraft({ segmentIndex }: { segmentIndex: number }) {
  const [note, setNote] = useState('');
  useEffect(() => () => { mocks.evidenceUnmount(segmentIndex); }, [segmentIndex]);
  return <input aria-label={'Evidence draft ' + segmentIndex} value={note} onChange={event => setNote(event.target.value)} />;
} }));
const segment: NarrationSegment = { segment_index: 7, dvi_text: 'A boat crosses the lake.', start_time: 12, end_time: 17, silence_duration: 5, audio_duration: 3, pass: true };
const review: StudioReviewDocument = { revision: 2, transcript_revision: 1, segments: [{ segment_index: 7, state: 'draft', text: segment.dvi_text, available_seconds: 5, speech_seconds: 3, timing_source: 'measured', margin_seconds: 2, risks: [], high_risk: false }], counts: { total: 1, approved: 0, pending: 1, conflicts: 0, uncertain: 0 }, can_export: false, blockers: ['not_approved'] };
function props() { return { jobId: 'version-2', segments: [segment], savedSegments: [segment], language: 'en-US' as const, dirty: false, disabled: false, review, reviewLoading: false, reviewError: '', onRefresh: vi.fn(), onReview: vi.fn().mockResolvedValue(undefined), onChange: vi.fn(), onSeek: vi.fn(), onSourceSeek: vi.fn(), onCreateCharacter: vi.fn(), onEvidenceDirty: vi.fn(), onEvidenceBusy: vi.fn(), evidenceEpoch: 0, onReviewRefresh: vi.fn(), onBusyChange: vi.fn() }; }
beforeEach(() => { mocks.rewriteSegment.mockResolvedValue({ text: 'A boat crosses.' }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('persisted segment review', () => {
  it('releases the parent busy state on unmount while an approval is still pending', async () => {
    const input = props();
    let complete!: () => void;
    input.onReview.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const view = render(<StudioReviewPanel {...input} />);
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(input.onBusyChange).toHaveBeenLastCalledWith(true));
    view.unmount();
    expect(input.onBusyChange).toHaveBeenLastCalledWith(false);
    await act(async () => complete());
    expect(input.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(input.onChange).not.toHaveBeenCalled();
  });
  it('approves the persisted segment index rather than its visible list position', async () => {
    const input = props(); render(<StudioReviewPanel {...input} />);
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    await waitFor(() => expect(input.onReview).toHaveBeenCalledWith(7, 'approved'));
    expect(input.onChange).not.toHaveBeenCalled();
    expect(mocks.rewriteSegment).not.toHaveBeenCalled();
  });

  it('prevents approval of changed draft text and labels duration as estimated', () => {
    const input = props(); render(<StudioReviewPanel {...input} dirty segments={[{ ...segment, dvi_text: 'The small boat moves.' }]} />);
    expect(screen.getByRole('button', { name: '批准' })).toBeDisabled();
    expect(screen.getByText('已修改')).toBeVisible();
    expect(screen.getByText('预计播报')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    expect(input.onReview).not.toHaveBeenCalled();
  });

  it.each([['缩短到可用时间', 'shorten'], ['改为客观描述', 'objective'], ['增加氛围细节', 'atmosphere']] as const)('uses the requested %s rewrite as a local draft without approving it', async (label, action) => {
    const input = props();
    render(<StudioReviewPanel {...input} review={{ ...review, segments: [{ ...review.segments[0], high_risk: true, risks: ['duration_conflict', 'uncertain_visual_evidence'] }] }} />);
    expect(screen.getByRole('button', { name: '批准' })).toBeDisabled();
    expect(screen.getByText('时长超出窗口')).toBeVisible();
    expect(screen.getByText('画面信息不确定')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '改写' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: label }));
    await waitFor(() => expect(mocks.rewriteSegment).toHaveBeenCalledWith('version-2', 7, segment.dvi_text, action));
    expect(input.onChange).toHaveBeenCalledWith(7, 'A boat crosses.');
    expect(input.onReview).not.toHaveBeenCalled();
  });

  it('preserves evidence drafts when a filter temporarily hides their segment', () => {
    const input = props(); render(<StudioReviewPanel {...input} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Evidence draft 7' }), { target: { value: 'Check the boat colour.' } });
    const filters = screen.getByRole('tablist', { name: '审校筛选' });
    fireEvent.click(within(filters).getByRole('tab', { name: '已批准 0' }));
    expect(screen.queryByRole('textbox', { name: 'Evidence draft 7' })).not.toBeInTheDocument();
    expect(mocks.evidenceUnmount).not.toHaveBeenCalled();
    fireEvent.click(within(filters).getByRole('tab', { name: '全部 1' }));
    expect(screen.getByRole('textbox', { name: 'Evidence draft 7' })).toHaveValue('Check the boat colour.');
  });
});
