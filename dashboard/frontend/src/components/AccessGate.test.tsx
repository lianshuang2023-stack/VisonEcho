import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccessGate from './AccessGate';
import AccessControls from './AccessControls';
import { useAccessSession } from '../accessSession';
import type { AccessSession } from '../accessSession';

const limits = { max_video_seconds: 60, max_upload_mb: 50, guest_generations_remaining: 1 };
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
beforeEach(() => { request.mockResolvedValue(response(anonymous)); vi.stubGlobal('fetch', request); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('hosted workspace access', () => {
  it('does not mount a private workspace until the session is established', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    setup();
    expect(mounts).not.toHaveBeenCalled();
    await act(async () => resolve(response(anonymous)));
    expect(await screen.findByRole('heading', { name: '口述电影工作台' })).toBeVisible();
    expect(screen.getByRole('button', { name: '先试用一下' })).toBeVisible();
    expect(mounts).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/access/session']);
  });

  it('creates a guest workspace only from the trial button and shows its own state', async () => {
    setup(); await screen.findByRole('button', { name: '先试用一下' });
    request.mockResolvedValueOnce(response(guest));
    fireEvent.click(screen.getByRole('button', { name: '先试用一下' }));
    expect(await screen.findByRole('heading', { name: 'guest-1 private videos' })).toBeVisible();
    expect(screen.getByText('访客试用')).toBeVisible();
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
    expect(unmounts).toHaveBeenCalledWith('guest-1');
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
    expect(screen.queryByRole('button', { name: '先试用一下' })).not.toBeInTheDocument();
  });

  it('unmounts account data during logout and returns to the access screen', async () => {
    request.mockResolvedValueOnce(response(account)); setup();
    await screen.findByRole('heading', { name: 'account-1 private videos' });
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    request.mockResolvedValueOnce(response(anonymous));
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    await screen.findByRole('heading', { name: '口述电影工作台' });
    expect(unmounts).toHaveBeenCalledWith('account-1');
    expect(request.mock.calls[1][0]).toBe('/api/access/logout');
  });

  it('rechecks the authoritative session on an expired-session event', async () => {
    request.mockResolvedValueOnce(response(account)); setup();
    await screen.findByRole('heading', { name: 'account-1 private videos' });
    request.mockResolvedValueOnce(response(anonymous));
    act(() => window.dispatchEvent(new Event('visionecho-access-expired')));
    await screen.findByRole('heading', { name: '口述电影工作台' });
    await waitFor(() => expect(unmounts).toHaveBeenCalledWith('account-1'));
  });

  it('does not let an old session read replace a newly authenticated account', async () => {
    request.mockResolvedValueOnce(response(guest)); setup();
    await screen.findByRole('heading', { name: 'guest-1 private videos' });
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    act(() => window.dispatchEvent(new Event('focus')));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct-long-password' } });
    request.mockResolvedValueOnce(response(account));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '登录' }));
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
