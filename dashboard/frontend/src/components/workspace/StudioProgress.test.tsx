import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import StudioProgress from './StudioProgress';
import type { ExecutionStatus } from '../../types';
afterEach(cleanup);

it('groups only actual server steps and exposes their real completed counts', () => {
  const execution: ExecutionStatus = { execution_arn: 'j1', start_date: '', stop_date: null, status: 'RUNNING', error: null, cause: null, steps: [
    { name: 'ValidateInput', status: 'succeeded', entered_at: null, exited_at: null },
    { name: 'TranscribeVideo', status: 'succeeded', entered_at: null, exited_at: null },
    { name: 'SilenceDetection', status: 'running', entered_at: null, exited_at: null },
  ] };
  render(<StudioProgress execution={execution} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  const dialogue = screen.getByText('对白与时间').closest('li')!;
  expect(within(dialogue).getByText('处理中')).toBeVisible();
  expect(dialogue).toHaveTextContent('1/2 步骤完成');
  const script = screen.getByText('口述稿与配音').closest('li')!;
  expect(script).toHaveTextContent('等待处理');
  expect(script.textContent).not.toContain('/');
});

it('does not invent totals or elapsed estimates before steps arrive', () => {
  const { container } = render(<StudioProgress execution={null} />);
  expect(screen.getAllByText('等待处理')).toHaveLength(5);
  expect(container.textContent).not.toMatch(/%|ETA|预计|步骤完成/);
});

it('does not complete dialogue while the pre-seeded timing step is pending', () => {
  const execution: ExecutionStatus = { execution_arn: 'j1', start_date: '', stop_date: null, status: 'RUNNING', error: null, cause: null, steps: [
    { name: 'ValidateInput', status: 'succeeded', entered_at: null, exited_at: null },
    { name: 'TranscribeVideo', status: 'succeeded', entered_at: null, exited_at: null },
    { name: 'SilenceDetection', status: 'pending', entered_at: null, exited_at: null },
    { name: 'RecordSummary', status: 'pending', entered_at: null, exited_at: null },
  ] };
  render(<StudioProgress execution={execution} />);
  const dialogue = screen.getByText('对白与时间').closest('li')!;
  expect(dialogue).toHaveClass('running');
  expect(dialogue).toHaveTextContent('1/2 步骤完成');
});

it('keeps a partial historical step feed active until there is evidence the group finished', () => {
  const execution: ExecutionStatus = { execution_arn: 'j1', start_date: '', stop_date: null, status: 'RUNNING', error: null, cause: null, steps: [{ name: 'TranscribeVideo', status: 'succeeded', entered_at: null, exited_at: null }] };
  const view = render(<StudioProgress execution={execution} />);
  expect(screen.getByText('对白与时间').closest('li')).toHaveClass('running');
  view.rerender(<StudioProgress execution={{ ...execution, steps: [...execution.steps, { name: 'AnalyzeSilenceSegments', status: 'running', entered_at: null, exited_at: null }] }} />);
  expect(screen.getByText('对白与时间').closest('li')).toHaveClass('succeeded');
});

it('shows saved results for revoice-only stages and real segment counters', () => {
  const execution: ExecutionStatus = { execution_arn: 'j1', start_date: '', stop_date: null, status: 'RUNNING', error: null, cause: null, steps: [
    { name: 'ValidateInput', status: 'succeeded', entered_at: null, exited_at: null },
    { name: 'SynthesizeAudio', status: 'running', entered_at: null, exited_at: null, detail: { completed_segments: 2, num_segments: 7 } },
    { name: 'MixAudioTracks', status: 'pending', entered_at: null, exited_at: null },
    { name: 'RecordSummary', status: 'pending', entered_at: null, exited_at: null },
  ] };
  render(<StudioProgress execution={execution} />);
  expect(screen.getAllByText('沿用已有结果')).toHaveLength(2);
  expect(screen.getByText('2/7 段处理完成')).toBeVisible();
  expect(screen.getByText('口述稿与配音').closest('li')).toHaveTextContent('0/1 步骤完成');
});

it('uses validated frame counts and ignores inconsistent partial progress', () => {
  const execution: ExecutionStatus = { execution_arn: 'j1', start_date: '', stop_date: null, status: 'RUNNING', error: null, cause: null, steps: [
    { name: 'AnalyzeSilenceSegments', status: 'succeeded', entered_at: null, exited_at: null, detail: { frame_count: 18 } },
    { name: 'GenerateDVI', status: 'running', entered_at: null, exited_at: null, detail: { completed_segments: 9, num_segments: 2 } },
  ] };
  render(<StudioProgress execution={execution} />);
  expect(screen.getByText('18 帧画面')).toBeVisible();
  expect(screen.queryByText('9/2 段处理完成')).not.toBeInTheDocument();
});
