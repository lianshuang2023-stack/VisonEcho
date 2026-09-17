import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CharacterPanel from './CharacterPanel';
import type { CharacterPanelHandle } from './CharacterPanel';
import type { CharacterDetection, CharacterLibrary, NarrationSegment } from '../../localWorkspaceApi';
const mocks = vi.hoisted(() => ({ getCharacters: vi.fn(), saveCharacters: vi.fn(), detectCharacters: vi.fn(), getCharacterDetection: vi.fn(), getLatestCharacterDetection: vi.fn() }));
vi.mock('../../localWorkspaceApi', () => mocks);
const library: CharacterLibrary = { revision: 4, characters: [{ id: 'person-1', appearance: 'Red coat', preferred_name: 'Ann', status: 'confirmed', aliases: [], thumbnail: null, occurrences: [{ job_id: 'job-1', segment_index: 0 }] }] };
const segments: NarrationSegment[] = [{ segment_index: 0, dvi_text: 'Ann opens the door.', start_time: 1, end_time: 5, silence_duration: 4, audio_duration: 3, pass: true }];
beforeEach(() => { mocks.getLatestCharacterDetection.mockResolvedValue(null); mocks.getCharacters.mockResolvedValue(library); mocks.saveCharacters.mockImplementation(async (_id, data) => ({ ...data, revision: 5 })); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup() { const ref = createRef<CharacterPanelHandle>(); const props = { ref, projectId: 'video-1', jobId: 'job-1', segments, onDirtyChange: vi.fn(), onBusyChange: vi.fn(), onApply: vi.fn() }; render(<CharacterPanel {...props} />); return props; }

describe('character cards', () => {
  it('saves a name with the revision and waits for selected script replacements', async () => {
    const props = setup(); fireEvent.click(screen.getByRole('button', { name: '人物卡' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑人物 Ann' }));
    fireEvent.change(screen.getByRole('textbox', { name: '人物统一称呼' }), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: '保存人物卡' }));
    const dialog = await screen.findByRole('dialog', { name: '更新当前口述稿中的称呼' });
    expect(mocks.saveCharacters.mock.calls[0][1].revision).toBe(4);
    expect(mocks.saveCharacters.mock.calls[0][1].characters[0]).toMatchObject({ preferred_name: 'Alice', aliases: ['Ann'] });
    expect(props.onApply).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Ann opens the door.')).toBeVisible();
    expect(within(dialog).getByText('Alice opens the door.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '应用到当前草稿' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '应用到当前草稿' }));
    expect(props.onApply).toHaveBeenCalledWith([{ segmentIndex: 0, before: 'Ann opens the door.', after: 'Alice opens the door.', linked: true }]);
  });
  it('preserves a conflicting draft and guards cancellation with one active dialog', async () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: '人物卡' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑人物 Ann' }));
    fireEvent.change(screen.getByRole('textbox', { name: '人物统一称呼' }), { target: { value: 'Alice' } });
    mocks.saveCharacters.mockRejectedValueOnce(new Error('Character revision conflict'));
    fireEvent.click(screen.getByRole('button', { name: '保存人物卡' }));
    await screen.findByText('Character revision conflict');
    expect(screen.getByRole('textbox', { name: '人物统一称呼' })).toHaveValue('Alice');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: '人物卡尚未保存' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('textbox', { name: '人物统一称呼' })).toHaveValue('Alice');
  });
  it('creates a person from an explicit frame without inferring a name or identity', async () => {
    const props = setup();
    act(() => props.ref.current?.createFromFrame({ job_id: 'job-1', segment_index: 2, frame_id: 'f1', timestamp: 8, url: '/frame.jpg' }));
    await screen.findByRole('dialog', { name: '添加人物卡' });
    expect(screen.getByRole('textbox', { name: '人物统一称呼' })).toHaveValue('');
    expect(screen.getByRole('button', { name: '保存人物卡' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '人物外观特征' }), { target: { value: '画面右侧穿蓝色外套的人' } });
    fireEvent.click(screen.getByRole('button', { name: '保存人物卡' }));
    await waitFor(() => expect(mocks.saveCharacters).toHaveBeenCalledOnce());
    expect(mocks.saveCharacters.mock.calls[0][1].characters[1]).toMatchObject({ id: '', preferred_name: '', status: 'unconfirmed', occurrences: [{ job_id: 'job-1', segment_index: 2 }], thumbnail: { job_id: 'job-1', segment_index: 2, frame_id: 'f1' } });
  });

  it('does not start a scan on mount or expansion and confirms the cloud action', async () => {
    const props = setup();
    expect(mocks.detectCharacters).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '人物卡' }));
    const button = await screen.findByRole('button', { name: '自动识别人物' });
    expect(mocks.detectCharacters).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: '自动识别人物' })).toHaveTextContent('人物卡保持待确认');
    mocks.detectCharacters.mockResolvedValue({ detection_id: 'd1', status: 'RUNNING', job_id: 'job-1' });
    mocks.getCharacterDetection.mockResolvedValue({ detection_id: 'd1', status: 'SUCCEEDED', job_id: 'job-1', added_count: 1, coverage: { frame_count: 4, segment_count: 2 } });
    const candidate = { ...library.characters[0], id: 'detected-1', preferred_name: '', status: 'unconfirmed' };
    mocks.getCharacters.mockResolvedValueOnce({ revision: 5, characters: [...library.characters, candidate] });
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
    expect(await screen.findByText('正在分析画面中的人物外观…')).toBeVisible();
    expect(screen.getByRole('button', { name: '编辑人物 Ann' })).toBeDisabled();
    expect(mocks.detectCharacters).toHaveBeenCalledWith('job-1', 4, 'zh-CN');
    await screen.findByText('新增 1，更新 0，待整理 0 张人物卡。', {}, { timeout: 2500 });
    expect(screen.getByText('待确认')).toBeVisible();
    await waitFor(() => expect(props.onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it('restores a running scan without submitting another and distinguishes empty frame coverage', async () => {
    mocks.getLatestCharacterDetection.mockResolvedValue({ detection_id: 'old-detection', status: 'RUNNING', job_id: 'job-1' });
    mocks.getCharacterDetection.mockResolvedValue({ detection_id: 'old-detection', status: 'SUCCEEDED', job_id: 'job-1', added_count: 0, coverage: { frame_count: 0, segment_count: 0 } });
    setup(); fireEvent.click(screen.getByRole('button', { name: '人物卡' }));
    await screen.findByText('暂无可分析关键帧。', {}, { timeout: 2500 });
    expect(mocks.detectCharacters).not.toHaveBeenCalled();
  });

  it('keeps the panel stable while submitting and releases it after a delayed scan request', async () => {
    let resolveStart!: (task: CharacterDetection) => void;
    mocks.detectCharacters.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve; }));
    setup(); fireEvent.click(screen.getByRole('button', { name: '人物卡' }));
    fireEvent.click(await screen.findByRole('button', { name: '自动识别人物' }));
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
    const heading = screen.getByRole('button', { name: '人物卡1' });
    expect(heading).toBeDisabled();
    fireEvent.click(heading);
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    await act(async () => resolveStart({ detection_id: 'delayed', status: 'FAILED', job_id: 'job-1', error: 'Service unavailable' }));
    expect(heading).toBeEnabled();
    expect(screen.getByRole('button', { name: '自动识别人物' })).toBeEnabled();
  });

  it('shows a revision conflict with an explicit reload path without losing the existing cards', async () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: '人物卡' }));
    fireEvent.click(await screen.findByRole('button', { name: '自动识别人物' }));
    mocks.detectCharacters.mockRejectedValueOnce(new Error('Character revision conflict'));
    fireEvent.click(screen.getByRole('button', { name: '开始识别' }));
    await screen.findByText('Character revision conflict');
    expect(screen.getByText('Ann')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重新加载人物卡' }));
    await waitFor(() => expect(mocks.getCharacters).toHaveBeenCalledTimes(2));
    expect(mocks.detectCharacters).toHaveBeenCalledOnce();
  });

  it('refreshes cards for a new version and ignores the previous project pending task', async () => {
    let resolveLatest!: (task: CharacterDetection) => void;
    mocks.getLatestCharacterDetection.mockImplementationOnce(() => new Promise(resolve => { resolveLatest = resolve; }));
    const props = { projectId: 'video-1', jobId: 'job-1', segments, onDirtyChange: vi.fn(), onBusyChange: vi.fn(), onApply: vi.fn() };
    const view = render(<CharacterPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '人物卡' }));
    view.rerender(<CharacterPanel {...props} projectId="video-2" jobId="job-2" />);
    await screen.findByText('Ann');
    await act(async () => resolveLatest({ detection_id: 'stale', status: 'RUNNING', job_id: 'job-1' }));
    expect(screen.queryByText('正在分析画面中的人物外观…')).not.toBeInTheDocument();
    expect(mocks.getCharacterDetection).not.toHaveBeenCalled();
    mocks.getCharacters.mockResolvedValue({ revision: 6, characters: [] });
    view.rerender(<CharacterPanel {...props} projectId="video-2" jobId="job-3" />);
    await waitFor(() => expect(screen.queryByText('Ann')).not.toBeInTheDocument());
    expect(mocks.detectCharacters).not.toHaveBeenCalled();
  });
});
