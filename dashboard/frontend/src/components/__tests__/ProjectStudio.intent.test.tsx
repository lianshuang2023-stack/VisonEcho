import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectStudio from '../workspace/ProjectStudio';
import { UiPreferencesContext } from '../../uiPreferences';
import type { UiLanguage } from '../../uiPreferences';
import type { StudioIntent } from '../workspace/ProjectStudio';
import type { NarrationEditor, ProjectDetail, VideoProject } from '../../localWorkspaceApi';
import type { ExecutionStatus } from '../../types';

const mocks = vi.hoisted(() => ({ getProject: vi.fn(), getNarration: vi.fn(), getTranscript: vi.fn(), fetchInputVideoUrl: vi.fn(), fetchExecutionStatus: vi.fn(), generateNarration: vi.fn(), renderNarration: vi.fn(), calibrateTranscript: vi.fn(), getSegmentEvidence: vi.fn(), saveEvidenceFeedback: vi.fn(), getCharacters: vi.fn(), saveCharacters: vi.fn() }));
vi.mock('../../api', () => mocks);
vi.mock('../../localWorkspaceApi', async importOriginal => ({ ...await importOriginal<typeof import('../../localWorkspaceApi')>(), ...mocks }));

const project: VideoProject = { video_id: 'video-1', title: '海边的一天', filename: 'coast.mp4', duration: 30, size_mb: 1.2, status: 'ready', archived: false, execution_count: 1, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z', last_modified: '2026-09-16T00:00:00Z', latest_execution_id: 'job-1', latest_result_id: 'job-1', thumbnail_url: '/thumbnail' };
const job: ExecutionStatus = { execution_arn: 'job-1', status: 'SUCCEEDED', start_date: '2026-09-16T00:00:00Z', stop_date: '2026-09-16T00:01:00Z', error: null, cause: null, steps: [] };
const detail: ProjectDetail = { project, latest_result_id: 'job-1', executions: [job] };
const narration: NarrationEditor = { language: 'en-US', voice: 'en-US-JennyNeural', segments: [{ segment_index: 0, start_time: 5, end_time: 10, silence_duration: 5, dvi_text: 'A wave reaches the shore.', audio_duration: 3, pass: true }] };
const scrollIntoView = vi.fn();
const renderStudio = (initialIntent?: StudioIntent) => render(<ProjectStudio projectId="video-1" processingReady initialIntent={initialIntent} onBack={vi.fn()} onSetup={vi.fn()} />);
const expectNoCloudTask = () => {
  expect(mocks.generateNarration).not.toHaveBeenCalled();
  expect(mocks.renderNarration).not.toHaveBeenCalled();
  expect(mocks.calibrateTranscript).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  mocks.getProject.mockResolvedValue(detail);
  mocks.getNarration.mockResolvedValue(narration);
  mocks.getTranscript.mockResolvedValue({ revision: 0, cues: [{ id: 'cue-1', start: 1, end: 3, text: 'Hello, ocean.' }] });
  mocks.fetchInputVideoUrl.mockResolvedValue('/input.mp4');
  mocks.fetchExecutionStatus.mockResolvedValue({ ...job, status: 'RUNNING' });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('studio card intent navigation', () => {
  it('keeps the default entry unchanged without automatically moving focus', async () => {
    renderStudio();
    await screen.findByRole('textbox', { name: '口述稿 1' });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '口述稿 1' })).not.toHaveFocus();
    expectNoCloudTask();
  });

  it('takes a draft to generation settings without opening confirmation or submitting a job', async () => {
    mocks.getProject.mockResolvedValue({ project: { ...project, status: 'draft', latest_result_id: null }, latest_result_id: null, executions: [] });
    renderStudio('generate');
    const language = await screen.findByRole('combobox', { name: '解说语言' });
    await waitFor(() => expect(language).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('region', { name: '生成设置' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    fireEvent.change(language, { target: { value: 'zh-CN' } });
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expectNoCloudTask();
  });

  it('waits for narration before focusing review and does not pull focus back after a tab change', async () => {
    let resolveNarration!: (value: NarrationEditor) => void;
    mocks.getNarration.mockReturnValue(new Promise(resolve => { resolveNarration = resolve; }));
    renderStudio('review');
    await screen.findByText('正在加载文本…');
    expect(scrollIntoView).not.toHaveBeenCalled();
    await act(async () => resolveNarration(narration));
    const field = await screen.findByRole('textbox', { name: '口述稿 1' });
    await waitFor(() => expect(field).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('region', { name: '校对文本' }));
    fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
    expect(screen.getByRole('tab', { name: /对白字幕/ })).toHaveAttribute('aria-selected', 'true');
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expectNoCloudTask();
  });

  it('focuses a result player only once without autoplay and honors reduced motion', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    renderStudio('result');
    const player = await screen.findByLabelText('口述解说视频播放器') as HTMLVideoElement;
    await waitFor(() => expect(player).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    expect(player.paused).toBe(true);
    expect(player).not.toHaveAttribute('autoplay');
    fireEvent.loadedMetadata(player);
    fireEvent.timeUpdate(player);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expectNoCloudTask();
  });

  it('focuses the running task without starting another one', async () => {
    mocks.getProject.mockResolvedValue({ ...detail, project: { ...project, status: 'processing' }, executions: [{ ...job, status: 'RUNNING' }] });
    renderStudio('progress');
    const progress = await screen.findByRole('region', { name: '制作进度' });
    await waitFor(() => expect(progress).toHaveFocus());
    expect(progress).toHaveTextContent('正在制作新版本');
    expectNoCloudTask();
  });

  it.each(['FAILED', 'TIMED_OUT', 'ABORTED'] as const)('shows and focuses a saved %s task, including an error without a cause', async status => {
    mocks.getProject.mockResolvedValue({ ...detail, project: { ...project, status: 'failed' }, executions: [{ ...job, status, cause: null, error: 'Speech service unavailable' }] });
    renderStudio('error');
    const progress = await screen.findByRole('region', { name: '制作进度' });
    await waitFor(() => expect(progress).toHaveFocus());
    expect(progress).toHaveTextContent('Speech service unavailable');
    expect(screen.getByText('生成失败')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '调整设置后重试' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '解说语言' })).toHaveFocus());
    expectNoCloudTask();
  });

  it('shows a recoverable project failure when the execution record is absent', async () => {
    mocks.getProject.mockResolvedValue({ project: { ...project, status: 'failed', last_error: '视频处理记录不完整', latest_result_id: null }, latest_result_id: null, executions: [] });
    renderStudio('error');
    const progress = await screen.findByRole('region', { name: '制作进度' });
    await waitFor(() => expect(progress).toHaveFocus());
    expect(progress).toHaveTextContent('视频处理记录不完整');
    expectNoCloudTask();
  });

  it('removes the workflow strip and review button while retaining editing and export', async () => {
    renderStudio();
    const field = await screen.findByRole('textbox', { name: '口述稿 1' });
    expect(screen.queryByRole('navigation', { name: '制作流程' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '标记已校对' })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'A blue wave reaches the shore.' } });
    fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
    fireEvent.click(screen.getByRole('tab', { name: /口述解说/ }));
    expect(screen.getByRole('textbox', { name: '口述稿 1' })).toHaveValue('A blue wave reaches the shore.');
    fireEvent.click(screen.getByText('导出文件'));
    expect(screen.getByText('导出文件').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('导出已保存的版本；当前编辑尚未保存。')).toBeVisible();
    expectNoCloudTask();
  });
});


it('switches studio UI language without reloading edits or changing speech language', async () => {
  const view = (language: UiLanguage) => <UiPreferencesContext.Provider value={{ language, theme: 'light', setLanguage: vi.fn(), setTheme: vi.fn(), t: (zh, en) => language === 'en' ? en : zh }}>
    <ProjectStudio projectId="video-1" processingReady onBack={vi.fn()} onSetup={vi.fn()} />
  </UiPreferencesContext.Provider>;
  const rendered = render(view('zh-CN'));
  const script = await screen.findByRole('textbox', { name: '口述稿 1' });
  fireEvent.change(script, { target: { value: 'A user-edited narration.' } });
  fireEvent.change(screen.getByRole('combobox', { name: '解说语言' }), { target: { value: 'zh-CN' } });
  rendered.rerender(view('en'));
  expect(screen.getByRole('textbox', { name: 'Narration 1' })).toHaveValue('A user-edited narration.');
  expect(screen.getByRole('combobox', { name: 'Narration language' })).toHaveValue('zh-CN');
  expect(screen.getByRole('button', { name: 'Generate new version' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'New version narration voice' })).toHaveTextContent('Xiaoxiao');
  expect(screen.getByRole('heading', { name: '海边的一天' })).toBeVisible();
  expect(mocks.getNarration).toHaveBeenCalledTimes(1);
  rendered.rerender(view('zh-CN'));
  expect(screen.getByRole('textbox', { name: '口述稿 1' })).toHaveValue('A user-edited narration.');
  expectNoCloudTask();
});

it('submits source dialogue and narration language independently', async () => {
  mocks.generateNarration.mockResolvedValue({ execution_arn: 'new-job', start_date: job.start_date });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  const dialogue = screen.getByRole('combobox', { name: '原片对白语言' });
  expect(dialogue).toHaveValue('auto');
  fireEvent.change(dialogue, { target: { value: 'en-US' } });
  fireEvent.change(screen.getByRole('combobox', { name: '解说语言' }), { target: { value: 'zh-CN' } });
  expect(dialogue).toHaveValue('en-US');
  fireEvent.click(screen.getByRole('button', { name: '生成一个新版本' }));
  fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
  await waitFor(() => expect(mocks.generateNarration).toHaveBeenCalledWith('video-1', 'zh-CN', 'zh-CN-XiaoxiaoNeural', 'auto', 'en-US'));
});

it('calibrates using dialogue language even after narration language changes', async () => {
  mocks.calibrateTranscript.mockResolvedValue({ calibration_id: 'cal-1', status: 'RUNNING' });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  fireEvent.change(screen.getByRole('combobox', { name: '原片对白语言' }), { target: { value: 'en-US' } });
  fireEvent.change(screen.getByRole('combobox', { name: '解说语言' }), { target: { value: 'zh-CN' } });
  fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
  fireEvent.click(screen.getByRole('button', { name: '重新校准字幕' }));
  fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
  await waitFor(() => expect(mocks.calibrateTranscript).toHaveBeenCalledWith('job-1', 'en-US', 0));
  expect(mocks.generateNarration).not.toHaveBeenCalled();
});

it('shows recognition uncertainty beside subtitle calibration without changing text', async () => {
  mocks.getTranscript.mockResolvedValue({ revision: 0, language: 'en-US', quality: { review_required: true, low_confidence_phrase_count: 1 }, cues: [{ id: 'cue-1', start: 1, end: 3, text: 'Hello, ocean.' }] });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
  expect(screen.getByRole('note')).toHaveTextContent('部分对白识别置信度较低，请核对原声。');
  expect(screen.getByDisplayValue('Hello, ocean.')).toBeVisible();
  expectNoCloudTask();
});

it('seeks an evidence frame in the original source timeline after switching from extended output', async () => {
  mocks.getNarration.mockResolvedValue({ ...narration, narration_mode: 'extended', insertions: [{ source_time: 5, output_start: 5, output_end: 13, duration: 8 }], summary: { video_duration: 38 } });
  mocks.getSegmentEvidence.mockResolvedValue({ segment_index: 0, source_start: 8, source_end: 14, provenance: 'model', frames: [{ id: 'f0', timestamp: 12, url: '/frame.jpg' }], observations: [], feedback: { revision: 0, issues: [], note: '' } });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  expect(screen.getByLabelText('口述解说视频播放器')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '查看画面依据' }));
  fireEvent.click(await screen.findByRole('button', { name: '查看原片 00:12.000' }));
  const original = screen.getByLabelText('原始视频播放器') as HTMLVideoElement;
  fireEvent.loadedMetadata(original);
  expect(original.currentTime).toBe(12);
  expect(mocks.generateNarration).not.toHaveBeenCalled();
});

it('guards navigation while visual correction changes are unsaved', async () => {
  const onBack = vi.fn();
  mocks.getSegmentEvidence.mockResolvedValue({ segment_index: 0, source_start: 1, source_end: 5, provenance: 'review', frames: [], observations: [], feedback: { revision: 0, issues: [], note: '' } });
  render(<ProjectStudio projectId="video-1" processingReady onBack={onBack} onSetup={vi.fn()} />);
  await screen.findByRole('textbox', { name: '口述稿 1' });
  fireEvent.click(screen.getByRole('button', { name: '查看画面依据' }));
  fireEvent.change(await screen.findByRole('textbox', { name: '画面纠错说明' }), { target: { value: 'The action is incorrect.' } });
  fireEvent.click(screen.getByRole('button', { name: '返回视频列表' }));
  expect(onBack).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '有未保存的编辑' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByRole('textbox', { name: '画面纠错说明' })).toHaveValue('The action is incorrect.');
});

it('keeps editing locked until completed generation details have reconciled', async () => {
  const running = { ...job, execution_arn: 'new-job', status: 'RUNNING' };
  mocks.getProject.mockResolvedValueOnce({ ...detail, executions: [running, job] });
  let resolveDetail!: (value: ProjectDetail) => void;
  mocks.getProject.mockImplementationOnce(() => new Promise<ProjectDetail>(resolve => { resolveDetail = resolve; }));
  mocks.fetchExecutionStatus.mockResolvedValue({ ...running, status: 'SUCCEEDED' });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  await waitFor(() => expect(mocks.getProject).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(screen.getByRole('textbox', { name: '口述稿 1' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '返回视频列表' })).toBeDisabled();
  await act(async () => resolveDetail({ ...detail, latest_result_id: 'new-job', executions: [{ ...job, execution_arn: 'new-job' }, job] }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '口述稿 1' })).toBeEnabled());
});
