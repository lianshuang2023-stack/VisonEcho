import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StudioExportMenu from './StudioExportMenu';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function select(label: string) { fireEvent.click(screen.getByRole('combobox', { name: '导出格式' })); fireEvent.click(await screen.findByRole('option', { name: new RegExp(label) })); }

describe('format selection and direct download', () => {
  it('selects each saved format URL without fetching review state or starting a task', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<StudioExportMenu jobId="job/1" />);
    expect(screen.getByRole('link', { name: '下载 MP4' })).toHaveAttribute('href', '/api/media/output/job%2F1?download=true');
    await select('SRT · 通用字幕');
    expect(screen.getByRole('link', { name: '下载 SRT' })).toHaveAttribute('href', '/api/videos/job%2F1/export?kind=dialogue&format=srt');
    expect(screen.getByText('带时间码的对白字幕，适用于常见播放器和剪辑工具。', { selector: 'p' })).toBeVisible();
    await select('VTT · 网页字幕');
    expect(screen.getByRole('link', { name: '下载 VTT' })).toHaveAttribute('href', '/api/videos/job%2F1/export?kind=dialogue&format=vtt');
    await select('TXT · 口述稿');
    expect(screen.getByRole('link', { name: '下载 TXT' })).toHaveAttribute('href', '/api/videos/job%2F1/export?kind=description&format=txt');
    expect(screen.getByText('已配音段落的口述稿，含时间范围，适合阅读与编辑。', { selector: 'p' })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps compact mode to one button and shows direct downloads and notes only after opening', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<StudioExportMenu jobId="job-1" dirty compact />);
    const trigger = screen.getByRole('button', { name: '导出' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByText('下载已保存版本；当前未保存的修改不会包含在文件中。')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const mp4 = await screen.findByRole('menuitem', { name: /MP4 · 视频/ });
    expect(mp4).toHaveAttribute('href', '/api/media/output/job-1?download=true');
    expect(mp4).toHaveAttribute('download');
    expect(screen.getByRole('menuitem', { name: /SRT · 通用字幕/ })).toHaveAttribute('href', '/api/videos/job-1/export?kind=dialogue&format=srt');
    expect(screen.getByRole('menuitem', { name: /VTT · 网页字幕/ })).toHaveAttribute('href', '/api/videos/job-1/export?kind=dialogue&format=vtt');
    expect(screen.getByRole('menuitem', { name: /TXT · 口述稿/ })).toHaveAttribute('href', '/api/videos/job-1/export?kind=description&format=txt');
    expect(screen.getByText('下载已保存版本；当前未保存的修改不会包含在文件中。')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.keyDown(mp4, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).not.toHaveAttribute('aria-expanded', 'true');
  });

  it('removes navigation from unavailable compact menu items without affecting video download', async () => {
    render(<StudioExportMenu jobId="job-1" compact transcriptUnavailable narrationUnavailable />);
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    expect(await screen.findByRole('menuitem', { name: /MP4 · 视频/ })).toHaveAttribute('href', '/api/media/output/job-1?download=true');
    for (const format of ['SRT', 'VTT', 'TXT']) {
      const option = screen.getByRole('menuitem', { name: new RegExp(format) });
      expect(option).toHaveAttribute('aria-disabled', 'true');
      expect(option).not.toHaveAttribute('href');
    }
  });

  it('disables only dialogue formats when the transcript is unavailable', async () => {
    render(<StudioExportMenu jobId="job-1" transcriptUnavailable />);
    expect(screen.getByRole('link', { name: '下载 MP4' })).toBeVisible();
    fireEvent.click(screen.getByRole('combobox', { name: '导出格式' }));
    expect(await screen.findByRole('option', { name: /SRT · 通用字幕/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /VTT · 网页字幕/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /TXT · 口述稿/ })).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('option', { name: /TXT · 口述稿/ }));
    expect(screen.getByRole('link', { name: '下载 TXT' })).toBeVisible();
  });

  it.each([{ jobId: '' }, { jobId: 'job-1', disabled: true }])('offers no download until an output is available: %j', props => {
    render(<StudioExportMenu {...props} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载 MP4' })).toBeDisabled();
  });
});
