import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectStudio from '../workspace/ProjectStudio';
import { UiPreferencesContext } from '../../uiPreferences';
import type { UiLanguage } from '../../uiPreferences';
import type { StudioIntent } from '../workspace/ProjectStudio';
import type { NarrationEditor, ProjectDetail, VideoProject } from '../../localWorkspaceApi';
import type { ExecutionStatus } from '../../types';

const mocks = vi.hoisted(() => ({ getStudioReview: vi.fn(), updateStudioReview: vi.fn(), rewriteSegment: vi.fn(), getProject: vi.fn(), getNarration: vi.fn(), getTranscript: vi.fn(), fetchInputVideoUrl: vi.fn(), fetchExecutionStatus: vi.fn(), generateNarration: vi.fn(), renderNarration: vi.fn(), calibrateTranscript: vi.fn(), getSegmentEvidence: vi.fn(), saveEvidenceFeedback: vi.fn(), getCharacters: vi.fn(), saveCharacters: vi.fn() }));
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
  mocks.getStudioReview.mockResolvedValue({ revision: 0, transcript_revision: 0, segments: [{ segment_index: 0, state: 'draft', text: 'A wave reaches the shore.', available_seconds: 5, speech_seconds: 3, timing_source: 'measured', margin_seconds: 2, risks: [], high_risk: false }], counts: { total: 1, pending: 1, approved: 0, conflicts: 0, uncertain: 0 }, can_export: false, blockers: ['not_approved'] });
  mocks.updateStudioReview.mockResolvedValue({ revision: 1, transcript_revision: 0, segments: [{ segment_index: 0, state: 'approved', text: 'A wave reaches the shore.', available_seconds: 5, speech_seconds: 3, timing_source: 'measured', margin_seconds: 2, risks: [], high_risk: false }], counts: { total: 1, pending: 0, approved: 1, conflicts: 0, uncertain: 0 }, can_export: true, blockers: [] });
  mocks.getSegmentEvidence.mockResolvedValue({ segment_index: 0, source_start: 5, source_end: 10, provenance: 'model', frames: [], observations: [], feedback: { revision: 0, issues: [], note: '' } });
  mocks.getCharacters.mockResolvedValue({ revision: 0, characters: [] });

  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  mocks.getProject.mockResolvedValue(detail);
  mocks.getNarration.mockResolvedValue(narration);
  mocks.getTranscript.mockResolvedValue({ revision: 0, cues: [{ id: 'cue-1', start: 1, end: 3, text: 'Hello, ocean.' }] });
  mocks.fetchInputVideoUrl.mockResolvedValue('/input.mp4');
  mocks.fetchExecutionStatus.mockResolvedValue({ ...job, status: 'RUNNING' });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function chooseProjectOption(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: '项目选项' }));
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}

describe('studio card intent navigation', () => {
  it('keeps the title header to metadata and a single export action', async () => {
    renderStudio(); await screen.findByRole('textbox', { name: '口述稿 1' });
    const header = screen.getByRole('heading', { name: '海边的一天' }).closest('header')!;
    expect(within(header).getAllByRole('button')).toHaveLength(1);
    expect(within(header).getByRole('button', { name: '导出' })).toBeVisible();
    expect(within(header).queryByText('coast.mp4')).not.toBeInTheDocument();
    expect(within(header).queryByText('已保存')).not.toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: '项目资源' })).not.toBeInTheDocument();
    expect(within(header).queryByRole('combobox', { name: '快捷导出格式' })).not.toBeInTheDocument();
  });
  it('starts Chinese-named uploads with Chinese narration and no empty editor panel', async () => {
    mocks.getProject.mockResolvedValue({ project: { ...project, status: 'draft', latest_result_id: null }, latest_result_id: null, executions: [] });
    renderStudio();
    const language = await screen.findByRole('combobox', { name: '解说语言' });
    expect(language).toHaveValue('zh-CN');
    expect(screen.getByRole('combobox', { name: '新版本解说音色' })).toHaveValue('zh-CN-XiaoxiaoNeural');
    expect(screen.queryByRole('combobox', { name: '口述风格' })).not.toBeInTheDocument();
    expect(screen.queryByText('暂无文本')).not.toBeVisible();
    expect(screen.getByRole('button', { name: '生成口述解说' })).toBeVisible();
  });
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
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, media: '', onchange: null, dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() } as MediaQueryList);
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
    expect(screen.getByRole('region', { name: '制作进度' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '调整设置后重试' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '解说语言' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: '关闭生成设置' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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

  it.each([
    { error: 'RuntimeError', cause: 'Visual description is too long for its narration window.' },
    { error: 'DescriptionWindowTooShort', cause: 'The description could not fit.' },
  ])('offers extended timing for a narration overflow without submitting a cloud task', async failure => {
    mocks.getProject.mockResolvedValue({ project: { ...project, status: 'failed', latest_result_id: null }, latest_result_id: null, executions: [{ ...job, ...failure, status: 'FAILED', dialogue_language: 'en-US' }] });
    renderStudio('error');
    const retry = await screen.findByRole('button', { name: '使用扩展口述重试' });
    expect(screen.getByRole('region', { name: '制作进度' })).toHaveTextContent('口述稿长于当前对白空隙');
    fireEvent.click(retry);
    expect(await screen.findByRole('combobox', { name: '口述方式' })).toHaveValue('extended');
    expect(screen.getByRole('combobox', { name: '原片对白语言' })).toHaveValue('en-US');
    expect(screen.queryByRole('dialog', { name: '开始生成口述解说' })).not.toBeInTheDocument();
    expect(mocks.generateNarration).not.toHaveBeenCalled();
  });

  it('lets the user declare no dialogue after a legacy speech failure without starting a paid task', async () => {
    mocks.getProject.mockResolvedValue({ project: { ...project, status: 'failed', latest_result_id: null }, latest_result_id: null, executions: [{ ...job, status: 'FAILED', error: 'TranscriptionError', cause: 'Azure Speech detected audio but could not recognize dialogue. Select the correct dialogue language and retry.', dialogue_language: 'en-US' }] });
    renderStudio('error');
    fireEvent.click(await screen.findByRole('button', { name: '确认无对白并重试' }));
    expect(screen.getByRole('combobox', { name: '原片对白语言' })).toHaveValue('none');
    expect(mocks.generateNarration).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成口述解说' }));
    mocks.generateNarration.mockResolvedValue({ execution_arn: 'new-job', start_date: job.start_date });
    fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
    await waitFor(() => expect(mocks.generateNarration).toHaveBeenCalledWith('video-1', 'zh-CN', 'zh-CN-XiaoxiaoNeural', 'auto', 'none', true));
  });

  it('shows the production workflow while retaining editing and export', async () => {
    renderStudio();
    const field = await screen.findByRole('textbox', { name: '口述稿 1' });
    expect(screen.getByRole('navigation', { name: '制作流程' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '标记已校对' })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'A blue wave reaches the shore.' } });
    fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
    fireEvent.click(screen.getByRole('tab', { name: /口述解说/ }));
    expect(screen.getByRole('textbox', { name: '口述稿 1' })).toHaveValue('A blue wave reaches the shore.');
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    expect(await screen.findByRole('menuitem', { name: /MP4 · 视频/ })).toHaveAttribute('href', '/api/media/output/job-1?download=true');
    expect(screen.getByText('下载已保存版本；当前未保存的修改不会包含在文件中。')).toBeVisible();
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
  await chooseProjectOption('生成新版本');
  fireEvent.change(screen.getByRole('combobox', { name: '解说语言' }), { target: { value: 'zh-CN' } });
  rendered.rerender(view('en'));
  expect(screen.getByRole('textbox', { name: 'Narration 1', hidden: true })).toHaveValue('A user-edited narration.');
  expect(screen.getByRole('combobox', { name: 'Narration language' })).toHaveValue('zh-CN');
  expect(screen.getByRole('button', { name: 'Generate new version' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'New version narration voice' })).toHaveTextContent('Xiaoxiao');
  expect(screen.getByRole('heading', { name: '海边的一天', hidden: true })).toBeInTheDocument();
  expect(mocks.getNarration).toHaveBeenCalledTimes(1);
  rendered.rerender(view('zh-CN'));
  fireEvent.click(screen.getByRole('button', { name: '关闭生成设置' }));
  expect(screen.getByRole('textbox', { name: '口述稿 1' })).toHaveValue('A user-edited narration.');
  expectNoCloudTask();
});

it('submits source dialogue and narration language independently', async () => {
  mocks.generateNarration.mockResolvedValue({ execution_arn: 'new-job', start_date: job.start_date });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  await chooseProjectOption('生成新版本');
  const dialogue = screen.getByRole('combobox', { name: '原片对白语言' });
  expect(screen.getByRole('checkbox', { name: /自动识别人物/ })).toBeChecked();
  expect(dialogue).toHaveValue('auto');
  fireEvent.change(dialogue, { target: { value: 'en-US' } });
  fireEvent.change(screen.getByRole('combobox', { name: '解说语言' }), { target: { value: 'zh-CN' } });
  expect(dialogue).toHaveValue('en-US');
  fireEvent.click(screen.getByRole('button', { name: '生成一个新版本' }));
  fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
  await waitFor(() => expect(mocks.generateNarration).toHaveBeenCalledWith('video-1', 'zh-CN', 'zh-CN-XiaoxiaoNeural', 'auto', 'en-US', true));
});

it('restores the per-version automatic detection preference and permits opting in', async () => {
  mocks.getProject.mockResolvedValue({ ...detail, executions: [{ ...job, detect_characters: false }] });
  mocks.generateNarration.mockResolvedValue({ execution_arn: 'new-job', start_date: job.start_date });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  await chooseProjectOption('生成新版本');
  const option = screen.getByRole('checkbox', { name: /自动识别人物/ });
  expect(option).not.toBeChecked();
  fireEvent.click(option);
  fireEvent.click(screen.getByRole('button', { name: '生成一个新版本' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('其余人物按外观区分，不推断真实身份');
  fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
  await waitFor(() => expect(mocks.generateNarration).toHaveBeenCalledWith('video-1', 'en-US', 'en-US-JennyNeural', 'auto', 'auto', true));
});

it.each([true, false])('restores generation detection preference %s without inheriting revoice opt-out', async (detectCharacters) => {
  mocks.getProject.mockResolvedValue({ ...detail, executions: [
    { ...job, execution_arn: 'render-job', kind: 'render', detect_characters: false },
    { ...job, kind: 'generate', detect_characters: detectCharacters },
  ] });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  await chooseProjectOption('生成新版本');
  const option = screen.getByRole('checkbox', { name: /自动识别人物/ });
  if (detectCharacters) expect(option).toBeChecked();
  else expect(option).not.toBeChecked();
});

it('calibrates using dialogue language even after narration language changes', async () => {
  mocks.calibrateTranscript.mockResolvedValue({ calibration_id: 'cal-1', status: 'RUNNING' });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  await chooseProjectOption('生成新版本');
  fireEvent.change(screen.getByRole('combobox', { name: '原片对白语言' }), { target: { value: 'en-US' } });
  fireEvent.change(screen.getByRole('combobox', { name: '解说语言' }), { target: { value: 'zh-CN' } });
  fireEvent.click(screen.getByRole('button', { name: '关闭生成设置' }));
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

it('shows overlapping speakers together and permits safe speaker correction without changing timing', async () => {
  const cues = [{ id: 'a', start: 1, end: 4, text: '你好', speaker: 'speaker_1' }, { id: 'b', start: 2, end: 3, text: '欢迎', speaker: 'speaker_2', low_confidence: true }];
  mocks.getTranscript.mockResolvedValue({ revision: 0, cues });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  const player = screen.getByLabelText('口述解说视频播放器') as HTMLVideoElement;
  player.currentTime = 2.5; fireEvent.timeUpdate(player);
  const overlay = player.parentElement!.querySelector('.ws-subtitle-overlay')!;
  expect(overlay).toHaveTextContent('说话人 1: 你好');
  expect(overlay).toHaveTextContent('说话人 2: 欢迎');
  expect(overlay.children).toHaveLength(2);
  fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
  expect(screen.getByText('识别待核对')).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: '对白字幕 2' }), { target: { value: '欢迎你' } });
  expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeEnabled();
  fireEvent.change(screen.getByRole('combobox', { name: '字幕 2 说话人' }), { target: { value: 'speaker_1' } });
  expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox', { name: '字幕 2 说话人' }), { target: { value: 'speaker_3' } });
  expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeEnabled();
  expect(screen.getByRole('spinbutton', { name: '字幕 2 开始秒数' })).toHaveValue(2);
  expect(screen.getByRole('spinbutton', { name: '字幕 2 结束秒数' })).toHaveValue(3);
});

it('adds a missing overlapping subtitle draft without inventing its speaker', async () => {
  mocks.getTranscript.mockResolvedValue({ revision: 0, quality: { diarization_available: true }, cues: [{ id: 'a', start: 1, end: 4, text: 'Hello', speaker: 'speaker_1' }] });
  renderStudio(); await screen.findByRole('textbox', { name: '口述稿 1' });
  const player = screen.getByLabelText('口述解说视频播放器') as HTMLVideoElement;
  player.currentTime = 2; fireEvent.timeUpdate(player);
  fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
  expect(screen.getByText('说话人由音频区分，可手动调整；同时抢话可能漏识别，请核对原声。')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '添加字幕' }));
  const added = screen.getByRole('textbox', { name: '对白字幕 2' });
  expect(added).toHaveFocus();
  expect(screen.getByRole('combobox', { name: '字幕 2 说话人' })).toHaveValue('');
  expect(screen.getByRole('spinbutton', { name: '字幕 2 开始秒数' })).toHaveValue(2);
  expect(screen.getByRole('spinbutton', { name: '字幕 2 结束秒数' })).toHaveValue(4);
  fireEvent.change(added, { target: { value: 'Welcome' } });
  expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox', { name: '字幕 2 说话人' }), { target: { value: 'speaker_2' } });
  expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeEnabled();
  expect(mocks.generateNarration).not.toHaveBeenCalled();
  expect(mocks.calibrateTranscript).not.toHaveBeenCalled();
});

it('removes only the new subtitle draft and keeps the saved transcript unchanged', async () => {
  renderStudio(); await screen.findByRole('textbox', { name: '口述稿 1' });
  const player = screen.getByLabelText('口述解说视频播放器') as HTMLVideoElement;
  player.currentTime = 30; fireEvent.timeUpdate(player);
  fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
  fireEvent.click(screen.getByRole('button', { name: '添加字幕' }));
  expect(screen.getByRole('spinbutton', { name: '字幕 2 结束秒数' })).toHaveValue(30);
  fireEvent.click(screen.getByRole('button', { name: '删除字幕 2' }));
  expect(screen.queryByRole('textbox', { name: '对白字幕 2' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '对白字幕 1' })).toHaveValue('Hello, ocean.');
  expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeDisabled();
});

it('explains why a silent video has no subtitles while retaining visual narration', async () => {
  mocks.getNarration.mockResolvedValue({ ...narration, dialogue_status: 'no_speech', dialogue_reason: 'silent_audio' });
  mocks.getTranscript.mockResolvedValue({ revision: 0, cues: [] });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  expect(screen.getByRole('note')).toHaveTextContent('未检测到可转写对白，已跳过字幕。画面解说已生成。');
  expect(screen.getByRole('note')).toHaveTextContent('原因：音轨为静音');
  fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
  expect(screen.getByRole('heading', { name: '没有可转写对白' })).toBeVisible();
  expectNoCloudTask();
});

it('distinguishes unrecognized audio from confirmed absence of dialogue', async () => {
  mocks.getNarration.mockResolvedValue({ ...narration, narration_mode: 'extended', dialogue_status: 'unrecognized', dialogue_reason: 'speech_not_recognized' });
  mocks.getTranscript.mockResolvedValue({ revision: 0, cues: [] });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  expect(screen.getByRole('note')).toHaveTextContent('音轨存在，但未识别到可靠对白。');
  expect(screen.getByRole('note')).toHaveTextContent('原片结束后补充解说');
  fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
  expect(screen.getByRole('heading', { name: '对白未可靠识别' })).toBeVisible();
  expect(screen.queryByText('未识别到对白')).not.toBeInTheDocument();
  expect(screen.queryByText('没有可转写对白')).not.toBeInTheDocument();
  expectNoCloudTask();
});

it('does not claim subtitles or narration were generated for an unrecognized standard output', async () => {
  mocks.getNarration.mockResolvedValue({ ...narration, segments: [], outcome: 'subtitles_only', narration_mode: 'standard', dialogue_status: 'unrecognized', dialogue_reason: 'speech_not_recognized' });
  mocks.getTranscript.mockResolvedValue({ revision: 0, cues: [] });
  renderStudio();
  await screen.findByText('本版本保留了原片，未生成字幕或口述配音。请核对对白语言或选择扩展口述后重试。');
  expect(screen.queryByText(/本版本只生成了字幕/)).not.toBeInTheDocument();
  expect(screen.queryByText(/原片结束后补充解说/)).not.toBeInTheDocument();
});

it('explains that no-dialogue calibration clears subtitles without calling speech recognition', async () => {
  renderStudio(); await screen.findByRole('textbox', { name: '口述稿 1' });
  await chooseProjectOption('生成新版本');
  fireEvent.change(screen.getByRole('combobox', { name: '原片对白语言' }), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: '关闭生成设置' }));
  fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
  fireEvent.click(screen.getByRole('button', { name: '重新校准字幕' }));
  const dialog = screen.getByRole('dialog', { name: '重新校准对白字幕' });
  expect(dialog).toHaveTextContent('将清除此版本已保存的对白字幕，不调用语音识别');
  expect(dialog).not.toHaveTextContent('将把原片音频发送至 Azure Speech');
  expect(dialog).not.toHaveTextContent('按用量计费');
  expect(mocks.calibrateTranscript).not.toHaveBeenCalled();
});

it('seeks an evidence frame in the original source timeline after switching from extended output', async () => {
  mocks.getNarration.mockResolvedValue({ ...narration, narration_mode: 'extended', insertions: [{ source_time: 5, output_start: 5, output_end: 13, duration: 8 }], summary: { video_duration: 38 } });
  mocks.getSegmentEvidence.mockResolvedValue({ segment_index: 0, source_start: 8, source_end: 14, provenance: 'model', frames: [{ id: 'f0', timestamp: 12, url: '/frame.jpg' }], observations: [], feedback: { revision: 0, issues: [], note: '' } });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  expect(screen.getByLabelText('口述解说视频播放器')).toBeVisible();
  fireEvent.click(await screen.findByRole('button', { name: '查看原片 00:12.000' }));
  const original = screen.getByLabelText('原始视频播放器') as HTMLVideoElement;
  fireEvent.loadedMetadata(original);
  expect(original.currentTime).toBe(12);
  expect(mocks.generateNarration).not.toHaveBeenCalled();
});

it('previews a narration at output time after switching away from the original player', async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  mocks.getNarration.mockResolvedValue({ ...narration, segments: [{ ...narration.segments[0], start_time: 16, end_time: 20 }], narration_mode: 'extended', insertions: [{ source_time: 5, output_start: 5, output_end: 13, duration: 8 }], summary: { video_duration: 38 } });
  renderStudio();
  await screen.findByRole('textbox', { name: '口述稿 1' });
  fireEvent.click(screen.getByRole('button', { name: '原始视频' }));
  fireEvent.loadedMetadata(screen.getByLabelText('原始视频播放器'));
  fireEvent.click(screen.getByRole('button', { name: '定位试听' }));
  const output = screen.getByLabelText('口述解说视频播放器') as HTMLVideoElement;
  fireEvent.loadedMetadata(output);
  expect(output.currentTime).toBe(16);
  expect(play).toHaveBeenCalledOnce();
  expect(mocks.generateNarration).not.toHaveBeenCalled();
  play.mockRestore();
});

it('guards navigation while visual correction changes are unsaved', async () => {
  const onBack = vi.fn();
  mocks.getSegmentEvidence.mockResolvedValue({ segment_index: 0, source_start: 1, source_end: 5, provenance: 'review', frames: [], observations: [], feedback: { revision: 0, issues: [], note: '' } });
  render(<ProjectStudio projectId="video-1" processingReady onBack={onBack} onSetup={vi.fn()} />);
  await screen.findByRole('textbox', { name: '口述稿 1' });
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
  await screen.findByRole('region', { name: '制作进度' });
  await waitFor(() => expect(mocks.getProject).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(screen.queryByRole('textbox', { name: '口述稿 1' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '返回视频列表' })).toBeDisabled();
  await act(async () => resolveDetail({ ...detail, latest_result_id: 'new-job', executions: [{ ...job, execution_arn: 'new-job' }, job] }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '口述稿 1' })).toBeEnabled());
});
