import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LocalVideoWorkspace from '../LocalVideoWorkspace';
import ProjectStudio from '../workspace/ProjectStudio';
import { AccessSessionContext } from '../../accessSession';
import type { ProjectCollection, ProjectDetail, VideoProject } from '../../localWorkspaceApi';

const mocks = vi.hoisted(() => ({ fetchBackendHealth: vi.fn(), fetchInputVideoUrl: vi.fn(), fetchExecutionStatus: vi.fn(), uploadVideo: vi.fn(), listProjects: vi.fn(), listHistoryVideos: vi.fn(), listCollections: vi.fn(), createCollection: vi.fn(), renameCollection: vi.fn(), deleteCollection: vi.fn(), deleteVideo: vi.fn(), listTrash: vi.fn(), restoreCollection: vi.fn(), restoreVideo: vi.fn(), patchProject: vi.fn(), getProject: vi.fn(), getNarration: vi.fn(), getTranscript: vi.fn(), saveTranscript: vi.fn(), generateNarration: vi.fn(), renderNarration: vi.fn(), calibrateTranscript: vi.fn(), getTranscriptCalibration: vi.fn(), setVideoReview: vi.fn() }));
vi.mock('../../api', () => mocks);
vi.mock('../../localWorkspaceApi', async importOriginal => ({ ...await importOriginal<typeof import('../../localWorkspaceApi')>(), ...mocks }));
const project: VideoProject = { video_id: 'video-1', collection_id: 'default', title: '海边的一天', filename: 'coast.mp4', duration: 30, size_mb: 1.2, status: 'ready', archived: false, execution_count: 2, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z', last_modified: '2026-09-16T00:00:00Z', latest_execution_id: 'job-2', latest_result_id: 'job-2', thumbnail_url: '/thumbnail' };
const collection: ProjectCollection = { id: 'default', title: '默认项目', video_count: 1, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z', deleted: false };
const detail: ProjectDetail = { project, latest_result_id: 'job-2', executions: ['job-2', 'job-1'].map(execution_arn => ({ execution_arn, status: 'SUCCEEDED', start_date: '2026-09-16T00:00:00Z', stop_date: '2026-09-16T00:01:00Z', error: null, cause: null, steps: [] })) };
const segment = { segment_index: 0, start_time: 5, end_time: 10, silence_duration: 5, dvi_text: 'A wave reaches the shore.', audio_duration: 3, pass: true };
const transcript = { revision: 0, cues: [{ id: 'cue-1', start: 1, end: 3, text: 'Hello, ocean.' }] };
beforeEach(() => {
  mocks.fetchBackendHealth.mockResolvedValue({ status: 'ok', provider: 'azure', configured: true, speech_region_configured: true, issues: [], model: 'test-model' });
  mocks.listCollections.mockResolvedValue([collection]);
  mocks.listTrash.mockResolvedValue({ collections: [], videos: [] });
  mocks.listProjects.mockResolvedValue([project]);
  mocks.listHistoryVideos.mockResolvedValue([project]);
  mocks.getProject.mockResolvedValue(detail);
  mocks.fetchInputVideoUrl.mockResolvedValue('/input.mp4');
  mocks.getNarration.mockResolvedValue({ segments: [segment], language: 'en-US', voice: 'en-US-JennyNeural' });
  mocks.getTranscript.mockResolvedValue(transcript);
  mocks.fetchExecutionStatus.mockResolvedValue({ ...detail.executions[0], execution_arn: 'job-new', status: 'FAILED', cause: 'Speech service unavailable' });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
const studio = () => render(<ProjectStudio projectId="video-1" processingReady onBack={vi.fn()} onSetup={vi.fn()} />);

describe('local video workspace', () => {
  it('displays the server-provided guest file limit and remaining AI operations', async () => {
    const session = { mode: 'hosted' as const, user: { id: 'trial-1', kind: 'guest' as const, username: null, expires_at: '2026-09-20T00:00:00Z' }, limits: { max_video_seconds: 60, max_upload_mb: 1024, guest_generations_remaining: 5 } };
    const view = render(<AccessSessionContext.Provider value={{ session, busy: false, openAccess: vi.fn(), refresh: async () => {} }}><LocalVideoWorkspace /></AccessSessionContext.Provider>);
    await screen.findByRole('heading', { name: '我的作品' });
    expect(screen.getByText('访客试用 · 60 秒 · 1 GB')).toBeVisible();
    expect(screen.getByText('AI 处理剩余 5 次；注册可保存试用作品。')).toBeVisible();
    view.rerender(<AccessSessionContext.Provider value={{ session: { ...session, limits: { ...session.limits, guest_generations_remaining: 0 } }, busy: false, openAccess: vi.fn(), refresh: async () => {} }}><LocalVideoWorkspace /></AccessSessionContext.Provider>);
    expect(screen.getByText('AI 处理剩余 0 次；注册可保存试用作品。')).toBeVisible();
  });
  it('shows one works list with one upload and search entry, and hides configured services', async () => {
    const other = { ...collection, id: 'trip', title: '旅行项目' };
    const archivedVideo = { ...project, video_id: 'archived-video', collection_id: 'trip', title: '山间行走', archived: true };
    mocks.listCollections.mockResolvedValue([collection, other]);
    mocks.listProjects.mockResolvedValue([project, archivedVideo]);
    render(<LocalVideoWorkspace />);
    expect(await screen.findByRole('heading', { name: '我的作品' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: '上传视频' })).toHaveLength(1);
    expect(screen.getAllByRole('textbox', { name: '搜索视频或项目' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '继续编辑：海边的一天' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /山间行走/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建项目' })).not.toBeInTheDocument();
    expect(screen.queryByText('全部历史')).not.toBeInTheDocument();
    expect(screen.queryByText('Azure 已配置')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /刷新/ })).not.toBeInTheDocument();
    expect(mocks.listProjects).toHaveBeenCalledWith(false);
    expect(mocks.listHistoryVideos).not.toHaveBeenCalled();
  });

  it('searches video and project names and combines project, workflow and sorting controls', async () => {
    const other = { ...collection, id: 'trip', title: '旅行项目' };
    const draft = { ...project, video_id: 'draft', title: '山间行走', collection_id: 'trip', status: 'draft' as const, workflow_status: 'draft' as const };
    mocks.listCollections.mockResolvedValue([collection, other]);
    mocks.listProjects.mockResolvedValue([project, draft]);
    render(<LocalVideoWorkspace />);
    await screen.findByRole('button', { name: '开始生成：山间行走' });
    fireEvent.change(screen.getByRole('textbox', { name: '搜索视频或项目' }), { target: { value: '旅行项目' } });
    expect(screen.getByRole('button', { name: '开始生成：山间行走' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '继续编辑：海边的一天' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '制作状态' }), { target: { value: 'review' } });
    expect(screen.getByText('没有找到匹配的作品')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(screen.getByRole('button', { name: '继续编辑：海边的一天' })).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: '项目筛选' }), { target: { value: 'trip' } });
    expect(screen.getByText('当前筛选下没有作品')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    fireEvent.click(screen.getByRole('button', { name: '筛选与排序' }));
    fireEvent.change(screen.getByRole('combobox', { name: '排序' }), { target: { value: 'name' } });
    expect(screen.getByRole('combobox', { name: '项目筛选' })).toHaveValue('all');
    expect(screen.getByRole('combobox', { name: '制作状态' })).toHaveValue('all');
    expect(screen.getByRole('button', { name: '开始生成：山间行走' })).toBeVisible();
  });

  it('shows archive independently from workflow, opens the only card target and returns to works', async () => {
    const archivedVideo = { ...project, archived: true, workflow_status: 'exportable' as const };
    mocks.listProjects.mockImplementation(async archived => archived ? [archivedVideo] : []);
    mocks.getProject.mockResolvedValue({ ...detail, project: archivedVideo });
    render(<LocalVideoWorkspace />);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '筛选与排序' }));
    fireEvent.change(screen.getByRole('combobox', { name: '归档筛选' }), { target: { value: 'archived' } });
    const target = await screen.findByRole('button', { name: '查看结果：海边的一天' });
    expect(target).toHaveTextContent('可导出');
    expect(target).toHaveTextContent('已归档');
    const card = target.closest('article')!;
    expect(within(card).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(target);
    expect(await screen.findByRole('textbox', { name: '口述稿 1' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回作品' }));
    expect(await screen.findByRole('heading', { name: '我的作品' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '管理视频：海边的一天' }));
    mocks.patchProject.mockResolvedValue({ ...archivedVideo, archived: false });
    mocks.listProjects.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复到我的作品' }));
    await waitFor(() => expect(mocks.patchProject).toHaveBeenCalledWith('video-1', { archived: false }));
    expect(await screen.findByText('当前筛选下没有作品')).toBeVisible();
  });

  it('loads archived works only when requested and keeps a single list', async () => {
    const archivedVideo = { ...project, video_id: 'archived', title: '旧作', archived: true };
    mocks.listHistoryVideos.mockResolvedValue([project, archivedVideo]);
    render(<LocalVideoWorkspace />);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '筛选与排序' }));
    fireEvent.change(screen.getByRole('combobox', { name: '归档筛选' }), { target: { value: 'all' } });
    expect(await screen.findByRole('heading', { name: '我的作品' })).toBeVisible();
    expect(screen.getByRole('button', { name: '继续编辑：旧作' })).toBeVisible();
    expect(mocks.listHistoryVideos).toHaveBeenCalledOnce();
  });

  it('offers retry on load failure instead of an empty state or permanent refresh', async () => {
    mocks.listProjects.mockRejectedValueOnce(new Error('作品加载失败')).mockResolvedValue([project]);
    render(<LocalVideoWorkspace />);
    expect(await screen.findByText('作品加载失败')).toBeVisible();
    expect(screen.queryByText('上传视频，开始制作口述电影')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: '继续编辑：海边的一天' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('does not resurrect deleted works when an older automatic refresh arrives later', async () => {
    mocks.deleteVideo.mockResolvedValue({ video_id: 'video-1', deleted: true });
    render(<LocalVideoWorkspace />);
    await screen.findByRole('button', { name: '继续编辑：海边的一天' });
    let resolveVideos!: (value: VideoProject[]) => void;
    mocks.listProjects.mockImplementationOnce(() => new Promise(resolve => { resolveVideos = resolve; })).mockResolvedValue([]);
    fireEvent(window, new Event('focus'));
    fireEvent.click(screen.getByRole('button', { name: '管理视频：海边的一天' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除视频' }));
    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await act(async () => resolveVideos([project]));
    expect(screen.queryByRole('button', { name: '继续编辑：海边的一天' })).not.toBeInTheDocument();
    expect(screen.getByText('上传视频，开始制作口述电影')).toBeVisible();
    expect(screen.getAllByRole('button', { name: '上传视频' })).toHaveLength(1);
  });

  it('creates a project inline while uploading and retains it for upload retry', async () => {
    const created = { ...collection, id: 'collection-2', title: '旅行记录', video_count: 0 };
    mocks.createCollection.mockResolvedValue(created);
    mocks.uploadVideo.mockRejectedValue(new Error('Upload interrupted'));
    render(<LocalVideoWorkspace />);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    fireEvent.change(screen.getByRole('combobox', { name: '所属项目' }), { target: { value: '__new' } });
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '旅行记录' } });
    const file = new File(['video'], 'coast.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('选择 MP4 视频'), { target: { files: [file] } });
    expect(await screen.findByText('Upload interrupted')).toBeVisible();
    expect(mocks.createCollection).toHaveBeenCalledWith('旅行记录');
    expect(mocks.uploadVideo).toHaveBeenCalledWith(file, expect.any(Function), 'collection-2');
    expect(screen.getByRole('combobox', { name: '所属项目' })).toHaveValue('collection-2');
    fireEvent.change(screen.getByLabelText('选择 MP4 视频'), { target: { files: [file] } });
    await waitFor(() => expect(mocks.uploadVideo).toHaveBeenCalledTimes(2));
    expect(mocks.createCollection).toHaveBeenCalledOnce();
  });

  it('uploads without classification and does not restore a deleted default project', async () => {
    const file = new File(['video'], 'coast.mp4', { type: 'video/mp4' });
    mocks.uploadVideo.mockRejectedValue(new Error('Upload interrupted'));
    render(<LocalVideoWorkspace />);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    expect(screen.getByRole('combobox', { name: '所属项目' })).toHaveValue('default');
    fireEvent.change(screen.getByLabelText('选择 MP4 视频'), { target: { files: [file] } });
    expect(await screen.findByText('Upload interrupted')).toBeVisible();
    expect(mocks.uploadVideo).toHaveBeenCalledWith(file, expect.any(Function), 'default');
    cleanup(); mocks.uploadVideo.mockClear();
    mocks.listCollections.mockResolvedValue([{ ...collection, deleted: true }]);
    render(<LocalVideoWorkspace />);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    expect(screen.queryByRole('option', { name: '暂不分类' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('选择 MP4 视频'), { target: { files: [file] } });
    expect(await screen.findByText('请选择所属项目或新建项目。')).toBeVisible();
    expect(mocks.uploadVideo).not.toHaveBeenCalled();
    expect(mocks.restoreCollection).not.toHaveBeenCalled();
  });

  it('moves a work into another project through its menu and updates the search scope', async () => {
    const other = { ...collection, id: 'trip', title: '旅行项目' };
    mocks.listCollections.mockResolvedValue([collection, other]);
    render(<LocalVideoWorkspace />);
    await screen.findByRole('button', { name: '继续编辑：海边的一天' });
    fireEvent.click(screen.getByRole('button', { name: '管理视频：海边的一天' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到项目' }));
    fireEvent.change(screen.getByRole('combobox', { name: '所属项目' }), { target: { value: 'trip' } });
    const updated = { ...project, collection_id: 'trip' };
    mocks.patchProject.mockResolvedValue(updated); mocks.listProjects.mockResolvedValue([updated]);
    fireEvent.click(screen.getByRole('button', { name: '移动作品' }));
    await waitFor(() => expect(mocks.patchProject).toHaveBeenCalledWith('video-1', { collection_id: 'trip' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: '搜索视频或项目' }), { target: { value: '旅行项目' } });
    expect(screen.getByRole('button', { name: '继续编辑：海边的一天' })).toBeVisible();
  });

  it('creates projects in the compact management dialog without starting video creation', async () => {
    const created = { ...collection, id: 'collection-2', title: '旅行记录', video_count: 0 };
    mocks.createCollection.mockResolvedValue(created);
    render(<LocalVideoWorkspace />);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '工作区菜单' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '项目管理' }));
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '旅行记录' } });
    mocks.listCollections.mockResolvedValue([collection, created]);
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(await screen.findByRole('dialog', { name: '项目管理' })).toBeVisible();
    expect(screen.getByRole('button', { name: '管理项目：旅行记录' })).toBeVisible();
    expect(mocks.createCollection).toHaveBeenCalledWith('旅行记录');
    expect(mocks.uploadVideo).not.toHaveBeenCalled();
    expect(mocks.getProject).not.toHaveBeenCalled();
  });

  it('confirms project deletion and restores it through the secondary workspace menu', async () => {
    const deleted = { ...collection, deleted: true, deleted_at: '2026-09-16T01:00:00Z' };
    mocks.deleteCollection.mockResolvedValue(deleted); mocks.restoreCollection.mockResolvedValue(collection);
    render(<LocalVideoWorkspace />);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '工作区菜单' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '项目管理' }));
    fireEvent.click(screen.getByRole('button', { name: '管理项目：未分类' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除项目' }));
    expect(screen.getByRole('dialog', { name: '删除项目' })).toHaveTextContent('其中 1 个视频');
    expect(mocks.deleteCollection).not.toHaveBeenCalled();
    mocks.listCollections.mockResolvedValue([]); mocks.listProjects.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }));
    await waitFor(() => expect(mocks.deleteCollection).toHaveBeenCalledWith('default'));
    await screen.findByRole('dialog', { name: '项目管理' });
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    mocks.listTrash.mockResolvedValue({ collections: [deleted], videos: [] });
    fireEvent.click(screen.getByRole('button', { name: '工作区菜单' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '回收站' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复项目：默认项目' }));
    await waitFor(() => expect(mocks.restoreCollection).toHaveBeenCalledWith('default'));
  });

  it('keeps the work and confirmation when deletion fails, then allows a retry', async () => {
    mocks.deleteVideo.mockRejectedValueOnce(new Error('视频正在处理中，请完成后重试。')).mockResolvedValue({ video_id: 'video-1', deleted: true });
    render(<LocalVideoWorkspace />);
    await screen.findByRole('button', { name: '继续编辑：海边的一天' });
    fireEvent.click(screen.getByRole('button', { name: '管理视频：海边的一天' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除视频' }));
    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }));
    expect(await screen.findByText('视频正在处理中，请完成后重试。')).toBeVisible();
    expect(screen.getByRole('button', { name: '继续编辑：海边的一天' })).toBeVisible();
    mocks.listProjects.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }));
    await waitFor(() => expect(mocks.deleteVideo).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: '继续编辑：海边的一天' })).not.toBeInTheDocument());
  });

  it('waits for the parent project to be restored before restoring its deleted video', async () => {
    mocks.listTrash.mockResolvedValue({ collections: [{ ...collection, deleted: true }], videos: [{ ...project, collection_title: '默认项目', deleted: true }] });
    render(<LocalVideoWorkspace />);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '工作区菜单' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '回收站' }));
    expect(await screen.findByRole('button', { name: '恢复视频：海边的一天' })).toBeDisabled();
    expect(screen.getByText('先恢复项目')).toBeVisible();
    expect(screen.getByRole('button', { name: '恢复项目：默认项目' })).toBeEnabled();
  });

  it('shows an actionable service issue and opens its real configuration status', async () => {
    mocks.fetchBackendHealth.mockResolvedValueOnce({ status: 'ok', provider: 'azure', configured: false, speech_region_configured: false, issues: ['缺少语音区域'], model: 'test-model' });
    render(<LocalVideoWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: '前往配置' }));
    const dialog = screen.getByRole('dialog', { name: '设置' });
    expect(within(dialog).getByText('本地工作区')).toBeVisible();
    expect(within(dialog).getByText('缺少语音区域')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '重新检查' }));
    expect(await within(dialog).findByText('服务已配置')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(screen.queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument();
  });

  it('updates a processing work automatically and shows the next action on success', async () => {
    mocks.listProjects.mockResolvedValueOnce([{ ...project, status: 'processing', workflow_status: 'processing' }]).mockResolvedValue([project]);
    vi.useFakeTimers();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    render(<LocalVideoWorkspace />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: '查看进度：海边的一天' })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByRole('button', { name: '继续编辑：海边的一天' })).toBeVisible();
    expect(mocks.generateNarration).not.toHaveBeenCalled();
  });

  it('requires an explicit confirmation before paid generation', async () => {
    studio();
    await screen.findByRole('textbox', { name: '口述稿 1' });
    fireEvent.click(screen.getByRole('button', { name: '生成一个新版本' }));
    expect(screen.getByRole('dialog', { name: '开始生成口述解说' })).toBeVisible();
    expect(mocks.generateNarration).not.toHaveBeenCalled();
    mocks.generateNarration.mockResolvedValue({ execution_arn: 'job-new', start_date: '2026-09-16T00:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
    await waitFor(() => expect(mocks.generateNarration).toHaveBeenCalledWith('video-1', 'en-US', 'en-US-JennyNeural', 'auto', 'auto', true));
  });

  it('switches generation language and its compatible voices without changing the old narration language', async () => {
    studio();
    await screen.findByRole('textbox', { name: '口述稿 1' });
    expect(screen.queryByText('最短无对白窗口')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '解说语言' }), { target: { value: 'zh-CN' } });
    expect(screen.getByRole('combobox', { name: '原片对白语言' })).toHaveValue('auto');
    const voice = screen.getByRole('combobox', { name: '新版本解说音色' });
    expect(voice).toHaveValue('zh-CN-XiaoxiaoNeural');
    expect(screen.getByRole('combobox', { name: '此版本配音音色' })).toHaveValue('en-US-JennyNeural');
    expect(screen.getByRole('button', { name: '重新配音并导出' })).toBeDisabled();
    fireEvent.change(voice, { target: { value: 'zh-CN-YunxiNeural' } });
    fireEvent.click(screen.getByRole('button', { name: '生成一个新版本' }));
    mocks.generateNarration.mockResolvedValue({ execution_arn: 'job-new', start_date: '2026-09-16T00:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
    await waitFor(() => expect(mocks.generateNarration).toHaveBeenCalledWith('video-1', 'zh-CN', 'zh-CN-YunxiNeural', 'auto', 'auto', true));
  });

  it('allows voice-only re-rendering and keeps the selected voice after a failed request', async () => {
    studio();
    const field = await screen.findByRole('textbox', { name: '口述稿 1' });
    fireEvent.change(screen.getByRole('combobox', { name: '此版本配音音色' }), { target: { value: 'en-US-GuyNeural' } });
    expect(screen.getByText('未保存')).toBeVisible();
    mocks.renderNarration.mockRejectedValueOnce(new Error('Speech request failed'));
    fireEvent.click(screen.getByRole('button', { name: '重新配音并导出' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
    expect(await screen.findByText('Speech request failed')).toBeVisible();
    expect(mocks.renderNarration).toHaveBeenCalledWith('job-2', [segment], 'en-US-GuyNeural');
    expect(field).toHaveValue(segment.dvi_text);
    expect(screen.getByRole('combobox', { name: '此版本配音音色' })).toHaveValue('en-US-GuyNeural');
    expect(screen.getByRole('button', { name: '重新配音并导出' })).toBeEnabled();
    fireEvent.change(screen.getByRole('combobox', { name: '选择历史版本' }), { target: { value: 'job-1' } });
    expect(screen.getByRole('dialog', { name: '有未保存的编辑' })).toBeVisible();
  });

  it('calibrates saved subtitles in the selected language without replacing the video version', async () => {
    studio();
    await screen.findByRole('textbox', { name: '口述稿 1' });
    fireEvent.change(screen.getByRole('combobox', { name: '原片对白语言' }), { target: { value: 'zh-CN' } });
    expect(screen.getByRole('combobox', { name: '解说语言' })).toHaveValue('en-US');
    fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
    mocks.calibrateTranscript.mockResolvedValue({ calibration_id: 'cal-1', status: 'RUNNING' });
    mocks.getTranscriptCalibration.mockResolvedValue({ calibration_id: 'cal-1', status: 'SUCCEEDED', result: { language: 'zh-CN', revision: 1, cues: [{ ...transcript.cues[0], text: '你好，大海。', start: 1.1, end: 2.9 }] } });
    fireEvent.click(screen.getByRole('button', { name: '重新校准字幕' }));
    expect(screen.getByRole('dialog', { name: '重新校准对白字幕' })).toBeVisible();
    expect(mocks.calibrateTranscript).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
    await waitFor(() => expect(mocks.calibrateTranscript).toHaveBeenCalledWith('job-2', 'zh-CN', 0));
    expect(screen.getByRole('combobox', { name: '选择历史版本' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('textbox', { name: '对白字幕 1' })).toHaveValue('你好，大海。'), { timeout: 3000 });
    expect(screen.getByRole('combobox', { name: '选择历史版本' })).toHaveValue('job-2');
    expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeDisabled();
    expect(mocks.renderNarration).not.toHaveBeenCalled();
  });

  it('requires saving subtitle edits before calibration and preserves them on failure', async () => {
    studio();
    await screen.findByRole('textbox', { name: '口述稿 1' });
    fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
    const field = screen.getByRole('textbox', { name: '对白字幕 1' });
    fireEvent.change(field, { target: { value: 'Corrected dialogue.' } });
    expect(screen.getByRole('button', { name: '重新校准字幕' })).toBeDisabled();
    mocks.saveTranscript.mockResolvedValue({ revision: 1, cues: [{ ...transcript.cues[0], text: 'Corrected dialogue.' }] });
    fireEvent.click(screen.getByRole('button', { name: '保存对白字幕' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重新校准字幕' })).toBeEnabled());
    mocks.calibrateTranscript.mockResolvedValue({ calibration_id: 'cal-2', status: 'RUNNING' });
    mocks.getTranscriptCalibration.mockResolvedValue({ calibration_id: 'cal-2', status: 'FAILED', error: '字幕版本已更新，请重新加载。' });
    fireEvent.click(screen.getByRole('button', { name: '重新校准字幕' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
    await waitFor(() => expect(screen.getByText('字幕版本已更新，请重新加载。')).toBeVisible(), { timeout: 3000 });
    expect(field).toHaveValue('Corrected dialogue.');
    expect(screen.getByRole('button', { name: '重新校准字幕' })).toBeEnabled();
  });

  it('protects unsaved narration when changing versions and seeks the player to a cue', async () => {
    studio();
    const field = await screen.findByRole('textbox', { name: '口述稿 1' });
    fireEvent.click(screen.getByRole('button', { name: '跳转到解说 1' }));
    expect((screen.getByLabelText('口述解说视频播放器') as HTMLVideoElement).currentTime).toBe(5);
    fireEvent.change(field, { target: { value: 'A small wave reaches the shore.' } });
    fireEvent.change(screen.getByRole('combobox', { name: '选择历史版本' }), { target: { value: 'job-1' } });
    expect(screen.getByRole('dialog', { name: '有未保存的编辑' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(field).toHaveValue('A small wave reaches the shore.');
    expect(screen.getByRole('combobox', { name: '选择历史版本' })).toHaveValue('job-2');
  });

  it('keeps a subtitle edit dirty on revision conflict, then saves the returned revision', async () => {
    studio();
    await screen.findByRole('textbox', { name: '口述稿 1' });
    fireEvent.click(screen.getByRole('tab', { name: /对白字幕/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '对白字幕 1' }), { target: { value: 'Hello, sea.' } });
    mocks.saveTranscript.mockRejectedValueOnce(new Error('字幕已被其他页面更新，请重新加载。'));
    fireEvent.click(screen.getByRole('button', { name: '保存对白字幕' }));
    expect(await screen.findByText('字幕已被其他页面更新，请重新加载。')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeEnabled();
    mocks.saveTranscript.mockResolvedValue({ revision: 1, cues: [{ ...transcript.cues[0], text: 'Hello, sea.' }] });
    fireEvent.click(screen.getByRole('button', { name: '保存对白字幕' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存对白字幕' })).toBeDisabled());
    expect(mocks.saveTranscript).toHaveBeenLastCalledWith('job-2', { revision: 0, cues: [{ ...transcript.cues[0], text: 'Hello, sea.' }] });
  });

  it('retains narration edits after a failed render so they can be retried', async () => {
    studio();
    const field = await screen.findByRole('textbox', { name: '口述稿 1' });
    fireEvent.change(field, { target: { value: 'A blue wave rolls ashore.' } });
    mocks.renderNarration.mockResolvedValue({ execution_arn: 'job-new', start_date: '2026-09-16T00:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: '重新配音并导出' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并开始' }));
    await waitFor(() => expect(screen.getByText('Speech service unavailable')).toBeVisible(), { timeout: 3000 });
    expect(field).toHaveValue('A blue wave rolls ashore.');
    expect(screen.getByRole('button', { name: '重新配音并导出' })).toBeEnabled();
    expect(screen.getByText('未保存')).toBeVisible();
  });
});
