import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CharacterPanel from './CharacterPanel';
import type { CharacterPanelHandle } from './CharacterPanel';
import type { CharacterLibrary, NarrationSegment } from '../../localWorkspaceApi';
const mocks = vi.hoisted(() => ({ getCharacters: vi.fn(), saveCharacters: vi.fn() }));
vi.mock('../../localWorkspaceApi', () => mocks);
const library: CharacterLibrary = { revision: 4, characters: [{ id: 'person-1', appearance: 'Red coat', preferred_name: 'Ann', status: 'confirmed', aliases: [], thumbnail: null, occurrences: [{ job_id: 'job-1', segment_index: 0 }] }] };
const segments: NarrationSegment[] = [{ segment_index: 0, dvi_text: 'Ann opens the door.', start_time: 1, end_time: 5, silence_duration: 4, audio_duration: 3, pass: true }];
beforeEach(() => { mocks.getCharacters.mockResolvedValue(library); mocks.saveCharacters.mockImplementation(async (_id, data) => ({ ...data, revision: 5 })); });
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
});
