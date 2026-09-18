import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccessGate from './AccessGate';
import AccessControls from './AccessControls';
import { useAccessSession } from '../accessSession';
import type { AccessSession } from '../accessSession';
import { UiPreferencesContext, useUiPreferences } from '../uiPreferences';

vi.mock('./LandingPage', () => ({ default: function MockLandingPage({ onStart, onLogin, busy, error, onRetry, hasWorkspace }: { onStart: () => void; onLogin: () => void; busy: boolean; error: string; onRetry?: () => void; hasWorkspace?: boolean }) {
  const { t } = useUiPreferences();
  return <main><h1>VisionEcho overview</h1><button disabled={busy} onClick={onStart}>{hasWorkspace ? t('进入工作区', 'Open studio') : t('立即开始', 'Get started')}</button><button disabled={busy} onClick={onLogin}>{hasWorkspace ? t('返回作品', 'Return to videos') : t('登录', 'Log in')}</button>{error && <p role="alert">{error}</p>}{onRetry && <button onClick={onRetry}>{t('重新检查连接', 'Check connection again')}</button>}</main>;
} }));

const limits = { max_video_seconds: 60, max_upload_mb: 1024, guest_generations_remaining: 5 };
const anonymous: AccessSession = { mode: 'hosted', user: null, limits };
const guest: AccessSession = { ...anonymous, user: { id: 'guest-1', kind: 'guest', username: null, expires_at: '2026-09-20T00:00:00Z' } };
const account: AccessSession = { ...anonymous, user: { id: 'account-1', kind: 'account', username: 'alice', expires_at: '2026-09-20T00:00:00Z' } };
const request = vi.fn();
const mounts = vi.fn();
const unmounts = vi.fn();
function response(session: AccessSession) { return { ok: true, json: async () => session }; }
function Workspace() {
  const { session } = useAccessSession();
  const id = session.user?.id ?? 'local';
  useEffect(() => { mounts(id); return () => { unmounts(id); }; }, [id]);
  return <main><h1>{id} private videos</h1><input aria-label="Private draft" defaultValue="" /><AccessControls /></main>;
}
const setup = () => render(<AccessGate><Workspace /></AccessGate>);
beforeEach(() => { window.history.replaceState(null, '', '/#visionecho-content'); request.mockResolvedValue(response(anonymous)); vi.stubGlobal('fetch', request); });
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('hosted workspace access', () => {
  it.each([
    ['local', { ...anonymous, mode: 'local' as const }, 'local'],
    ['account', account, 'account-1'],
    ['guest', guest, 'guest-1'],
  ] as const)('shows the overview at the root URL for %s sessions before opening the same workspace', async (_kind, session, id) => {
    window.history.replaceState(null, '', '/');
    request.mockResolvedValueOnce(response(session)); setup();
    expect(await screen.findByRole('heading', { name: 'VisionEcho overview' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Private draft' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '进入工作区' }));
    expect(screen.getByRole('heading', { name: id + ' private videos' })).toBeVisible();
    expect(window.location.hash).toBe('#visionecho-content');
    expect(request).toHaveBeenCalledOnce();
    expect(unmounts).not.toHaveBeenCalled();
  });

  it('restores the overview for the empty hash without discarding a working draft', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Private draft' }), { target: { value: 'Keep this working draft' } });
    act(() => { window.history.replaceState(null, '', '/#'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByRole('heading', { name: 'VisionEcho overview' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Private draft' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '进入工作区' }));
    expect(screen.getByRole('textbox', { name: 'Private draft' })).toHaveValue('Keep this working draft');
    expect(unmounts).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it('opens the overview for an active guest without replacing the workspace or its draft', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Private draft' }), { target: { value: 'Preserved overview draft' } });
    act(() => { window.history.replaceState(null, '', '/#about'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByRole('heading', { name: 'VisionEcho overview' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'guest-1 private videos' })).not.toBeInTheDocument();
    expect(unmounts).not.toHaveBeenCalled();
    for (const hash of ['#features', '#timing', '#impact']) {
      act(() => { window.history.replaceState(null, '', '/' + hash); window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(screen.getByRole('heading', { name: 'VisionEcho overview' })).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'guest-1 private videos' })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: '进入工作区' }));
    expect(screen.getByRole('textbox', { name: 'Private draft' })).toHaveValue('Preserved overview draft');
    expect(unmounts).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(['local', 'hosted'] as const)('supports a direct about link with an existing %s workspace', async mode => {
    window.history.replaceState(null, '', '/#about');
    request.mockResolvedValueOnce(response(mode === 'local' ? { ...anonymous, mode: 'local' } : account)); setup();
    expect(await screen.findByRole('heading', { name: 'VisionEcho overview' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Private draft' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回作品' }));
    expect(screen.getByRole('heading', { name: (mode === 'local' ? 'local' : 'account-1') + ' private videos' })).toBeVisible();
    expect(request).toHaveBeenCalledOnce();
  });

  it('keeps the workspace hidden when session verification fails while viewing the overview', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    act(() => { window.history.replaceState(null, '', '/#about'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    request.mockRejectedValueOnce(new Error('Temporary session outage'));
    act(() => window.dispatchEvent(new Event('focus')));
    await screen.findByText('Temporary session outage');
    expect(screen.getByRole('button', { name: '进入工作区' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'Private draft' })).not.toBeInTheDocument();
    expect(unmounts).not.toHaveBeenCalled();
  });

  it('opens login and returns to overview without creating a guest session', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '登录' }));
    expect(screen.getByLabelText('用户名')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '返回项目介绍' }));
    expect(screen.getByRole('heading', { name: 'VisionEcho overview' })).toBeVisible();
    expect(request).toHaveBeenCalledOnce();
    expect(mounts).not.toHaveBeenCalled();
  });

  it('surfaces a guest creation failure on the overview and permits a deliberate retry', async () => {
    setup(); await screen.findByRole('button', { name: '立即开始' });
    request.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ detail: 'Trial temporarily unavailable' }) });
    fireEvent.click(screen.getByRole('button', { name: '立即开始' }));
    await screen.findByText('Trial temporarily unavailable');
    expect(mounts).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '立即开始' })).toBeEnabled();
    request.mockResolvedValueOnce(response(guest));
    fireEvent.click(screen.getByRole('button', { name: '立即开始' }));
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
  });

  it('retries an anonymous session failure before enabling public actions', async () => {
    request.mockRejectedValueOnce(new Error('Session lookup failed')); setup();
    await screen.findByText('Session lookup failed');
    fireEvent.click(screen.getByRole('button', { name: '立即开始' }));
    expect(request).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce(response(anonymous));
    fireEvent.click(screen.getByRole('button', { name: '重新检查连接' }));
    expect(await screen.findByRole('button', { name: '立即开始' })).toBeEnabled();
    expect(mounts).not.toHaveBeenCalled();
  });

  it.each([11, 12, 24, 25])('accepts only passwords within 12–24 characters at length %s', async (length) => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '登录' }));
    const username = await screen.findByLabelText('用户名');
    const password = screen.getByLabelText('密码');
    fireEvent.change(username, { target: { value: 'tester' } });
    fireEvent.change(password, { target: { value: 'a'.repeat(length) } });
    expect(password).toHaveAttribute('minlength', '12');
    expect(password).toHaveAttribute('maxlength', '24');
    expect(screen.getByText('12–24 位字符')).toBeVisible();
    const form = password.closest('form')!;
    const submit = within(form).getByRole('button', { name: '登录' });
    if (length < 12 || length > 24) {
      expect(submit).toBeDisabled();
      fireEvent.submit(form);
      expect(request).toHaveBeenCalledOnce();
    } else {
      expect(submit).toBeEnabled();
      request.mockResolvedValueOnce(response(account));
      fireEvent.submit(form);
      await screen.findByRole('heading', { name: 'account-1 private videos' });
      expect(JSON.parse(request.mock.calls[1][1].body).password).toHaveLength(length);
    }
  });

  it('keeps the guest button without a trial sentence in English', async () => {
    render(<UiPreferencesContext.Provider value={{ language: 'en', theme: 'light', setLanguage: vi.fn(), setTheme: vi.fn(), t: (_zh, en) => en }}><AccessGate><Workspace /></AccessGate></UiPreferencesContext.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('button', { name: 'Try as a guest' })).toBeVisible();
    expect(screen.getByText('12–24 characters')).toBeVisible();
    expect(screen.queryByText(/Guest trial ·/)).not.toBeInTheDocument();
  });

  it('does not mount a private workspace until the session is established', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    setup();
    expect(mounts).not.toHaveBeenCalled();
    await act(async () => resolve(response(anonymous)));
    expect(await screen.findByRole('heading', { name: 'VisionEcho overview' })).toBeVisible();
    expect(screen.getByRole('button', { name: '立即开始' })).toBeVisible();
    expect(screen.queryByLabelText('用户名')).not.toBeInTheDocument();
    expect(screen.queryByText(/访客试用 · 视频最长/)).not.toBeInTheDocument();
    expect(mounts).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/access/session']);
  });

  it('creates a guest workspace only from the trial button and shows its own state', async () => {
    setup(); await screen.findByRole('button', { name: '立即开始' });
    request.mockResolvedValueOnce(response(guest));
    fireEvent.click(screen.getByRole('button', { name: '立即开始' }));
    expect(await screen.findByRole('heading', { name: 'guest-1 private videos' })).toBeVisible();
    expect(screen.getByText('访客试用')).toBeVisible();
    expect(screen.queryByRole('button', { name: '退出' })).not.toBeInTheDocument();
    expect(request.mock.calls[1][0]).toBe('/api/access/guest');
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({});
  });

  it('upgrades the guest session using registration and remounts its retained workspace', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Private draft' }), { target: { value: 'old in-memory draft' } });
    fireEvent.click(screen.getByRole('button', { name: '注册保存作品' }));
    const dialog = screen.getByRole('dialog', { name: '注册保存作品' });
    expect(dialog).toHaveTextContent('注册后保留当前试用作品');
    fireEvent.change(within(dialog).getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(within(dialog).getByLabelText('密码'), { target: { value: 'correct-long-password' } });
    request.mockResolvedValueOnce(response({ ...account, user: { ...account.user!, id: 'guest-1' } }));
    fireEvent.click(within(dialog).getByRole('button', { name: '创建账号' }));
    await screen.findByText('alice');
    expect(request.mock.calls[1][0]).toBe('/api/access/register');
    await waitFor(() => expect(unmounts).toHaveBeenCalledWith('guest-1'));
    expect(screen.getByRole('textbox', { name: 'Private draft' })).toHaveValue('');
  });

  it('switches from a guest to an existing account without retaining previous component data', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    const dialog = screen.getByRole('dialog', { name: '登录账号' });
    expect(dialog).toHaveTextContent('试用作品不会导入');
    fireEvent.change(within(dialog).getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(within(dialog).getByLabelText('密码'), { target: { value: 'correct-long-password' } });
    request.mockResolvedValueOnce(response(account));
    fireEvent.click(within(dialog).getByRole('button', { name: '登录' }));
    await screen.findByRole('heading', { name: 'account-1 private videos' });
    expect(screen.queryByRole('heading', { name: 'guest-1 private videos' })).not.toBeInTheDocument();
    await waitFor(() => expect(unmounts).toHaveBeenCalledWith('guest-1'));
  });

  it('keeps an existing guest workspace after a failed login and never falls back on session failure', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'incorrect-long-password' } });
    request.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ detail: 'Username or password is incorrect.' }) });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '登录' }));
    await screen.findByText('Username or password is incorrect.');
    expect(screen.getByRole('heading', { name: 'guest-1 private videos' })).toBeVisible();
    expect(unmounts).not.toHaveBeenCalled();
    cleanup(); request.mockRejectedValueOnce(new Error('Session service unavailable')); setup();
    await screen.findByText('Session service unavailable');
    expect(screen.queryByRole('heading', { name: /private videos/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即开始' })).toBeDisabled();
  });

  it('unmounts account data during logout and returns to the access screen', async () => {
    request.mockResolvedValueOnce(response(account)); setup();
    await screen.findByRole('heading', { name: 'account-1 private videos' });
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    request.mockResolvedValueOnce(response(anonymous));
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    await screen.findByRole('heading', { name: 'VisionEcho overview' });
    await waitFor(() => expect(unmounts).toHaveBeenCalledWith('account-1'));
    expect(request.mock.calls[1][0]).toBe('/api/access/logout');
  });

  it('rechecks the authoritative session on an expired-session event', async () => {
    request.mockResolvedValueOnce(response(account)); setup();
    await screen.findByRole('heading', { name: 'account-1 private videos' });
    request.mockResolvedValueOnce(response(anonymous));
    act(() => window.dispatchEvent(new Event('visionecho-access-expired')));
    await screen.findByRole('heading', { name: 'VisionEcho overview' });
    await waitFor(() => expect(unmounts).toHaveBeenCalledWith('account-1'));
  });

  it('does not let an old session read replace a newly authenticated account', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct-long-password' } });
    request.mockResolvedValueOnce(response(account));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '登录' }));
    await waitFor(() => expect(request.mock.calls.at(-1)?.[0]).toBe('/api/access/login'));
    await screen.findByRole('heading', { name: 'account-1 private videos' });
    await act(async () => resolveOld(response(guest)));
    expect(screen.getByRole('heading', { name: 'account-1 private videos' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'guest-1 private videos' })).not.toBeInTheDocument();
  });

  it('masks a transient session failure while retaining same-session drafts for retry', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Private draft' }), { target: { value: 'Keep this unsaved edit' } });
    request.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ detail: 'Temporary outage' }) });
    act(() => window.dispatchEvent(new Event('focus')));
    await screen.findByRole('heading', { name: '工作区连接暂时中断' });
    expect(screen.queryByRole('heading', { name: 'guest-1 private videos' })).not.toBeInTheDocument();
    expect(unmounts).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    request.mockResolvedValueOnce(response(guest));
    fireEvent.click(screen.getByRole('button', { name: '重新检查连接' }));
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    expect(screen.getByRole('textbox', { name: 'Private draft' })).toHaveValue('Keep this unsaved edit');
    expect(unmounts).not.toHaveBeenCalled();
  });
});
