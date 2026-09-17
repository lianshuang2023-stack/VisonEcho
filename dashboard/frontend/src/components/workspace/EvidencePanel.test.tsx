import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EvidencePanel from './EvidencePanel';
import type { SegmentEvidence } from '../../localWorkspaceApi';
const mocks = vi.hoisted(() => ({ getSegmentEvidence: vi.fn(), saveEvidenceFeedback: vi.fn() }));
vi.mock('../../localWorkspaceApi', () => mocks);
const evidence: SegmentEvidence = { segment_index: 0, source_start: 4, source_end: 8, provenance: 'model', frames: [{ id: 'f0', timestamp: 5.5, url: '/frame.jpg' }], observations: [{ fact: '红衣女子走向门口。', frame_ids: ['f0'] }], feedback: { revision: 2, issues: [], note: '' } };
beforeEach(() => { mocks.getSegmentEvidence.mockResolvedValue(evidence); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup() { const props = { jobId: 'job-1', segmentIndex: 0, onSeek: vi.fn(), onCreateCharacter: vi.fn(), onDirtyChange: vi.fn(), onBusyChange: vi.fn() }; render(<EvidencePanel {...props} descriptionChanged />); return props; }

describe('visual evidence review', () => {
  it('loads only on expansion and passes original frame seconds and references without remapping', async () => {
    const props = setup();
    expect(mocks.getSegmentEvidence).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看画面依据' }));
    await screen.findByText('红衣女子走向门口。');
    expect(screen.getByText('当前文字已修改，请对照原片核对。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看原片 00:05.500' }));
    expect(props.onSeek).toHaveBeenCalledWith(5.5);
    fireEvent.click(screen.getByRole('button', { name: '添加人物' }));
    expect(props.onCreateCharacter).toHaveBeenCalledWith({ job_id: 'job-1', segment_index: 0, frame_id: 'f0', timestamp: 5.5, url: '/frame.jpg' });
  });
  it('retains correction text after a revision conflict and resets dirty only on success', async () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: '查看画面依据' }));
    await screen.findByRole('checkbox', { name: '动作有误' });
    fireEvent.click(screen.getByRole('checkbox', { name: '动作有误' }));
    fireEvent.change(screen.getByRole('textbox', { name: '画面纠错说明' }), { target: { value: '她正在关门。' } });
    mocks.saveEvidenceFeedback.mockRejectedValueOnce(new Error('Revision conflict'));
    fireEvent.click(screen.getByRole('button', { name: '保存纠错' }));
    await screen.findByText('Revision conflict');
    expect(screen.getByRole('textbox', { name: '画面纠错说明' })).toHaveValue('她正在关门。');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(0, true);
    mocks.saveEvidenceFeedback.mockResolvedValueOnce({ revision: 3, issues: ['wrong_action'], note: '她正在关门。' });
    fireEvent.click(screen.getByRole('button', { name: '保存纠错' }));
    await screen.findByText('纠错记录已保存。');
    expect(mocks.saveEvidenceFeedback).toHaveBeenLastCalledWith('job-1', 0, { revision: 2, issues: ['wrong_action'], note: '她正在关门。' });
    await waitFor(() => expect(props.onDirtyChange).toHaveBeenLastCalledWith(0, false));
  });
  it('keeps failed evidence loading local and provides retry', async () => {
    mocks.getSegmentEvidence.mockRejectedValueOnce(new Error('Evidence unavailable'));
    setup(); fireEvent.click(screen.getByRole('button', { name: '查看画面依据' }));
    await screen.findByText('Evidence unavailable'); fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('红衣女子走向门口。');
  });
});
