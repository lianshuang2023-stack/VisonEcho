import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StudioQualityReport from './StudioQualityReport';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const defaults = { dirty: false, jobId: 'version/2', transcriptError: '', editorError: '' };

describe('saved version export panel', () => {
  it('offers saved downloads without requesting or requiring review metadata', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<StudioQualityReport {...defaults} />);
    expect(screen.getByRole('region', { name: '导出' })).toBeVisible();
    expect(screen.getByText('选择格式，下载当前已保存版本。审校状态不影响导出。')).toBeVisible();
    expect(screen.getByRole('link', { name: '下载 MP4' })).toHaveAttribute('href', '/api/media/output/version%2F2?download=true');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps downloading available while explaining that unsaved edits are excluded', () => {
    render(<StudioQualityReport {...defaults} dirty />);
    expect(screen.getByRole('link', { name: '下载 MP4' })).toBeVisible();
    expect(screen.getByText('下载已保存版本；当前未保存的修改不会包含在文件中。')).toBeVisible();
  });

  it('blocks only unavailable file contents and retains the saved video', async () => {
    render(<StudioQualityReport {...defaults} transcriptError="Subtitle unavailable" editorError="Narration unavailable" />);
    expect(screen.getByRole('link', { name: '下载 MP4' })).toBeVisible();
    fireEvent.click(screen.getByRole('combobox', { name: '导出格式' }));
    expect(await screen.findByRole('option', { name: /SRT · 通用字幕/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /VTT · 网页字幕/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /TXT · 口述稿/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /MP4 · 视频/ })).not.toHaveAttribute('aria-disabled', 'true');
  });
});
