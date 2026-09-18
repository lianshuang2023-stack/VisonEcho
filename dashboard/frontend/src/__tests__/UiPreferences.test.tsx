import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import UiPreferencesProvider from '../UiPreferencesProvider';
import { UI_PREFERENCES_KEY, useUiPreferences } from '../uiPreferences';
import LocalVideoWorkspace from '../components/LocalVideoWorkspace';
import LandingPage from '../components/LandingPage';

const mocks = vi.hoisted(() => ({ fetchBackendHealth: vi.fn(), listCollections: vi.fn(), listProjects: vi.fn() }));
vi.mock('../api', () => ({ fetchBackendHealth: mocks.fetchBackendHealth, uploadVideo: vi.fn() }));
vi.mock('../localWorkspaceApi', async original => ({ ...await original<typeof import('../localWorkspaceApi')>(), ...mocks }));

beforeEach(() => {
  window.history.replaceState(null, '', '/#visionecho-content');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  mocks.fetchBackendHealth.mockResolvedValue({ configured: true, speech_region_configured: true, issues: [], model: 'test' });
  mocks.listCollections.mockResolvedValue([{ id: 'default', title: '默认项目', video_count: 0 }]);
  mocks.listProjects.mockResolvedValue([]);
});
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.uiTheme; });

describe('interface preferences', () => {
  it.each(['', '#about', '#features'])('opens the introduction in English at %s despite a saved Chinese preference', async hash => {
    window.history.replaceState(null, '', '/' + hash);
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ language: 'zh-CN', theme: 'dark' }));
    render(<UiPreferencesProvider><LandingPage onStart={vi.fn()} onLogin={vi.fn()} busy={false} error="" /></UiPreferencesProvider>);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Let the storybe heard.');
    expect(screen.getByRole('link', { name: 'Features' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Try as a guest' })[0]).toBeVisible();
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dataset.uiTheme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Switch interface to Chinese' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('让画面被听见。');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.uiTheme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '切换到亮色' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('让画面被听见。');
    expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY)!)).toEqual({ language: 'zh-CN', theme: 'light' });
  });

  it('defaults to English and remembers language and theme changes after remount', async () => {
    const first = render(<UiPreferencesProvider><LocalVideoWorkspace /></UiPreferencesProvider>);
    expect(await screen.findByRole('heading', { name: 'My videos' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload video' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    await waitFor(() => expect(document.documentElement.dataset.uiTheme).toBe('dark'));
    expect(document.documentElement.lang).toBe('en');
    expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY)!)).toEqual({ language: 'en', theme: 'dark' });
    fireEvent.click(screen.getByRole('button', { name: 'Switch interface to Chinese' }));
    expect(screen.getByRole('heading', { name: '我的作品' })).toBeVisible();
    first.unmount();
    render(<UiPreferencesProvider><LocalVideoWorkspace /></UiPreferencesProvider>);
    expect(await screen.findByRole('heading', { name: '我的作品' })).toBeVisible();
    expect(screen.getByRole('button', { name: '切换到亮色' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '切换页面为英文' }));
    expect(screen.getByRole('heading', { name: 'My videos' })).toBeVisible();
    expect(document.documentElement.dataset.uiTheme).toBe('dark');
  });

  it('keeps typed project names when the interface language changes', async () => {
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ language: 'zh-CN', theme: 'light' }));
    render(<UiPreferencesProvider><LocalVideoWorkspace /></UiPreferencesProvider>);
    await screen.findByRole('heading', { name: '我的作品' });
    fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    fireEvent.change(screen.getByRole('combobox', { name: '所属项目' }), { target: { value: '__new' } });
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '我的真实项目' } });
    fireEvent.click(screen.getByRole('button', { name: '切换页面为英文' }));
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('我的真实项目');
    expect(screen.getByRole('dialog', { name: 'Upload video' })).toBeVisible();
  });

  it('falls back safely if preferences are invalid or storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    function Probe() { const prefs = useUiPreferences(); return <button onClick={() => prefs.setTheme('dark')}>{prefs.theme}</button>; }
    render(<UiPreferencesProvider><Probe /></UiPreferencesProvider>);
    expect(document.documentElement.lang).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'light' }));
    expect(screen.getByRole('button', { name: 'dark' })).toBeVisible();
  });
});
