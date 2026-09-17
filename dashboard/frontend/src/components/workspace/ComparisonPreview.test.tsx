import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { VideoProject } from '../../localWorkspaceApi';
import ComparisonPreview from './ComparisonPreview';

const mocks = vi.hoisted(() => ({ fetchInputVideoUrl: vi.fn(), getProject: vi.fn(), getNarration: vi.fn(), getTranscript: vi.fn() }));
vi.mock('../../api', () => ({ fetchInputVideoUrl: mocks.fetchInputVideoUrl }));
vi.mock('../../localWorkspaceApi', async importOriginal => ({ ...await importOriginal<typeof import('../../localWorkspaceApi')>(), ...mocks }));

const video: VideoProject = { video_id: 'video-1', title: '海边的一天', filename: 'coast.mp4', duration: 30, size_mb: 1.2, status: 'ready', archived: false, execution_count: 2, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z', last_modified: '2026-09-16T00:00:00Z', latest_execution_id: 'job-1', latest_result_id: 'job-1', thumbnail_url: '/thumbnail' };
const segment = { segment_index: 0, start_time: 5, end_time: 10, silence_duration: 5, dvi_text: '海浪漫过岸边。', audio_duration: 3, pass: true };
const cue = { id: 'cue-1', start: 1, end: 3, text: '你好，大海。' };

beforeEach(() => {
  mocks.fetchInputVideoUrl.mockResolvedValue('/input.mp4');
  mocks.getProject.mockResolvedValue({ project: video, latest_result_id: 'job-2', executions: [] });
  mocks.getNarration.mockResolvedValue({ segments: [segment, { ...segment, segment_index: 1, start_time: 15, end_time: 20, pass: false, dvi_text: '未配音片段' }], language: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural' });
  mocks.getTranscript.mockResolvedValue({ cues: [cue], revision: 0, language: 'zh-CN' });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });

function loadedMetadata(player: HTMLVideoElement) {
  Object.defineProperty(player, 'duration', { configurable: true, value: 30 });
  Object.defineProperty(player, 'readyState', { configurable: true, value: 1 });
  fireEvent.loadedMetadata(player);
}
async function open() {
  const onClose = vi.fn(); const onEdit = vi.fn();
  const view = render(<ComparisonPreview video={video} onClose={onClose} onEdit={onEdit} />);
  await screen.findByRole('group', { name: '口述解说时间轴' });
  const player = view.container.querySelector('video')!;
  loadedMetadata(player);
  return { ...view, player, onClose, onEdit };
}

describe('ComparisonPreview', () => {
  it('loads the latest saved version and maps only real recorded speech to the timeline', async () => {
    const { player } = await open();
    expect(mocks.fetchInputVideoUrl).toHaveBeenCalledWith(video.video_id);
    expect(mocks.getNarration).toHaveBeenCalledWith('job-2');
    expect(mocks.getTranscript).toHaveBeenCalledWith('job-2');
    expect(player).toHaveAttribute('src', '/input.mp4');
    expect(player).not.toHaveAttribute('autoplay');
    expect(screen.getByRole('button', { name: '原声' })).toHaveAttribute('aria-pressed', 'true');
    const track = screen.getByRole('group', { name: '口述解说时间轴' });
    const clips = within(track).getAllByRole('button');
    expect(clips).toHaveLength(1);
    // This is a 3-second audio clip, not the 5-second available narration window.
    expect(clips[0]).toHaveStyle({ width: '10%' });
    expect(clips[0]).toHaveAccessibleName('口述解说 00:05，海浪漫过岸边。');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('preserves the exact time and active playback only after the new video metadata loads', async () => {
    const { player, container } = await open();
    player.currentTime = 6.25; player.volume = 0.4; player.muted = true; player.playbackRate = 1.25;
    Object.defineProperty(player, 'paused', { configurable: true, value: false });
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole('button', { name: '口述版' }));
    const described = container.querySelector('video')!;
    expect(described).toHaveAttribute('src', '/api/media/output/job-2');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    loadedMetadata(described);
    expect(described.currentTime).toBe(6.25);
    expect(described.volume).toBe(0.4);
    expect(described.muted).toBe(true);
    expect(described.playbackRate).toBe(1.25);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(screen.getByText(segment.dvi_text)).toBeVisible();
    expect(screen.getByRole('button', { name: '口述版' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps paused videos paused and makes both timeline tracks seekable', async () => {
    const { player, container } = await open();
    player.currentTime = 2.2; fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole('button', { name: '口述版' }));
    const described = container.querySelector('video')!;
    loadedMetadata(described);
    expect(described.currentTime).toBe(2.2);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(screen.getByText(cue.text)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '口述解说 00:05，海浪漫过岸边。' }));
    expect(described.currentTime).toBe(5);
    expect(screen.getByText(segment.dvi_text)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '原对白 00:01，你好，大海。' }));
    expect(described.currentTime).toBe(1);
    expect(screen.getByText(cue.text)).toBeVisible();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('preserves the original position through rapid switches before metadata is available', async () => {
    const { player, container } = await open();
    player.currentTime = 12.5; fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole('button', { name: '口述版' }));
    fireEvent.click(screen.getByRole('button', { name: '原声' }));
    const restored = container.querySelector('video')!;
    loadedMetadata(restored);
    expect(restored.currentTime).toBe(12.5);
    expect(restored).toHaveAttribute('src', '/input.mp4');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('retries a failed media source at the saved position without starting playback', async () => {
    const { player, container } = await open();
    player.currentTime = 9.5; fireEvent.timeUpdate(player);
    fireEvent.error(player);
    expect(screen.getByText('视频暂时无法播放，请重试。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重试播放' }));
    const retried = container.querySelector('video')!;
    expect(retried).not.toBe(player);
    loadedMetadata(retried);
    expect(retried.currentTime).toBe(9.5);
    expect(screen.queryByText('视频暂时无法播放，请重试。')).not.toBeInTheDocument();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('allows failed preview requests to be retried and retains successful partial data', async () => {
    mocks.getTranscript.mockRejectedValueOnce(new Error('字幕服务暂不可用'));
    const { container } = await open();
    expect(screen.getByRole('alert')).toHaveTextContent('对白时间轴加载失败：字幕服务暂不可用');
    expect(within(screen.getByRole('group', { name: '口述解说时间轴' })).getAllByRole('button')).toHaveLength(1);
    expect(container.querySelector('video')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新加载预览' }));
    await screen.findByRole('button', { name: '原对白 00:01，你好，大海。' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.getTranscript).toHaveBeenCalledTimes(2);
  });

  it('shows a truthful no-result state and keeps the original available', async () => {
    mocks.getProject.mockResolvedValue({ project: { ...video, latest_result_id: null }, latest_result_id: null, executions: [] });
    const onEdit = vi.fn();
    const { container } = render(<ComparisonPreview video={{ ...video, latest_result_id: null }} onClose={vi.fn()} onEdit={onEdit} />);
    expect(await screen.findByText('还没有口述版')).toBeVisible();
    expect(screen.getByRole('button', { name: '口述版' })).toBeDisabled();
    expect(container.querySelector('video')).toHaveAttribute('src', '/input.mp4');
    expect(mocks.getNarration).not.toHaveBeenCalled();
    expect(mocks.getTranscript).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '去生成口述版' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('reports denied resume without an uncaught rejection and supports close/edit callbacks', async () => {
    const { player, container, onClose, onEdit } = await open();
    Object.defineProperty(player, 'paused', { configurable: true, value: false });
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('Playback needs a gesture'));
    fireEvent.click(screen.getByRole('button', { name: '口述版' }));
    loadedMetadata(container.querySelector('video')!);
    await waitFor(() => expect(screen.getByText('已保留播放位置，点击播放继续。')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '完成预览' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
